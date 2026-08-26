import { mkdir } from 'node:fs/promises';
import { createWriteStream, readFileSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import type { PieceType, Side } from '../engine/types';

/**
 * 对局事件日志 —— 一局一文件 append-only JSONL,实时与回放的唯一真相源(spec §5/§10)。
 * 约定:
 * - `seq` 由日志模块按 sink 自增(每局从 1 起),`ts` 落盘时补 ISO;
 * - 任何事件写盘前必须过 `sanitizeForLog`(密钥隔离 hook,§13 硬性条款);
 * - `finish.ruleViolations` 分阶段 `{ pre, post }`(评审采纳)由调度器统计,本模块只定义结构。
 */

/* ---------- 事件类型(§5 + 评审采纳) ---------- */

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

/** 单方规则失误计数,分阶段:pre=首次被打回前累计(教学前);post=被拒后重犯(教学后)。 */
export interface RuleViolations {
  pre: number;
  post: number;
}

export interface BaseEvent {
  seq: number; // 单调递增(模块自增,每局从 1)
  ts: string;  // ISO 8601(落盘补写)
}

export interface PlayerMeta {
  model: string;
}

/** 开局时的非敏感规则快照(§13 参数;数值均为公开常量,不含密钥)。 */
export interface GameRulesSnapshot {
  drawRepeat: number;
  illegalAttemptsLimit: number;
  maxTotalMoves: number;
  networkRetries: number;
  timeoutMs: number;
  carrySelfAnalysisN: number;
  contextBudgetTokens: number;
}

export interface BeginEvent extends BaseEvent {
  type: 'begin';
  gameId: string;
  red: PlayerMeta;
  black: PlayerMeta;
  rules?: GameRulesSnapshot;
}

export interface MoveEvent extends BaseEvent {
  type: 'move';
  turn: Side; // 行棋方
  move: { from: string; to: string; notation?: string };
  analysis?: string; // 己方思考(写入日志用于复盘,不对对方可见)
  elapsedMs?: number;
  usage?: Usage; // Anthropic usage 字段 → “思考成本指标”
  legal: boolean;
}

export interface IllegalAttemptEvent extends BaseEvent {
  type: 'illegal-attempt';
  side: Side;
  round: number; // 本半回合内第几次打回(1 起)
  reason: string; // 打回讲评或 reason 码(绝不枚举合法走法)
  violations: RuleViolations; // 该方累计违规计数快照
  attempt?: { text: string }; // 模型尝试文本
}

export interface CheckEvent extends BaseEvent {
  type: 'check';
  side: Side; // 被将军一方
}

export interface CapturedEvent extends BaseEvent {
  type: 'captured';
  side: Side; // 吃子方
  piece: { type: PieceType; side: Side };
  at: string; // 被吃棋子所在格
}

export interface DrawEvent extends BaseEvent {
  type: 'draw';
  reason: string; // 'repeat' | 'no-fighting-material' | 'max-moves' | 'cost-limit'
}

export interface FinishEvent extends BaseEvent {
  type: 'finish';
  winner: Side | 'draw';
  reason: string; // 'checkmate' | 'stalemate' | 'illegal-moves' | 'timeout' | 'draw-*' | ...
  ruleViolations: { red: RuleViolations; black: RuleViolations };
}

export interface RetryEvent extends BaseEvent {
  type: 'retry';
  side: Side;
  attempt: number;
  cause?: string; // 'network' | '5xx' | ...
}

export interface TimeoutEvent extends BaseEvent {
  type: 'timeout';
  side: Side;
}

export interface ErrorEvent extends BaseEvent {
  type: 'error';
  code: string;
  message: string;
  hint?: string;
}

export interface PlayerMessageEvent extends BaseEvent {
  type: 'player-message';
  side: Side;
  content: string; // 思考/发言
  phase?: 'thought' | 'message';
}

export interface ReviewEvent extends BaseEvent {
  type: 'review';
  summary: string;
  /** 单条失误复盘(赛后全量公共日志产出,与对局模型/凭据隔离)。 */
  mistakes?: ReviewMistake[];
  /** 要点/亮点(复盘服务主产出字段)。 */
  highlights?: string[];
  /**
   * 兼容别名(仅兼容层):早期前端只消费 `keyPoints` 渲染要点;复盘服务本身不产本字段,
   * 由接线层(http.ts triggerReview)落事件时映射为 `highlights` 的同值别名供前端消费。
   */
  keyPoints?: string[];
  model?: string; // 审查模型(与对局模型可不同)
  elapsedMs?: number;
  usage?: Usage;
}

export interface ReviewMistake {
  side: Side;
  move?: string;
  note: string;
}

export type GameEvent =
  | BeginEvent
  | MoveEvent
  | IllegalAttemptEvent
  | CheckEvent
  | CapturedEvent
  | DrawEvent
  | FinishEvent
  | RetryEvent
  | TimeoutEvent
  | ErrorEvent
  | PlayerMessageEvent
  | ReviewEvent;

/** 分布式的 Omit(对 union 逐成员去掉 seq/ts)。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** appendEvent 入参:seq/ts 由日志模块补写,调用方可不提供(提供了也会被覆盖)。 */
export type GameEventInput = DistributiveOmit<GameEvent, 'seq' | 'ts'>;

/* ---------- 密钥隔离 hook(spec §13 硬性条款) ---------- */

const normKey = (k: string): string => k.toLowerCase().replace(/[-_.]/g, '');
const SENSITIVE_KEYS = new Set([
  'apikey',
  'apikeys',
  'authorization',
  'baseurl',
  'auth',
  'authtoken',
  'accesstoken',
  'accesstokensecret',
  'refreshtoken',
  'idtoken',
  'token',
  'secrettoken',
  'secret',
  'clientsecret',
  'appsecret',
  'password',
  'passwd',
  'pwd',
  'credential',
  'credentials',
  'privatekey',
  'secretkey',
  'xapikey',
  'xauthtoken',
  'bearer',
]);

const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/**
 * 递归删除敏感键(黑名单,键名忽略大小写与 `-`/`_`/`.` 分隔)。
 * 返回**新对象**,不修改入参——调用方在内存里的事件不受影响,写盘/外发的一概是干净副本。
 */
export function sanitizeForLog<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainRecord(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        if (SENSITIVE_KEYS.has(normKey(k))) continue; // 剔除敏感键
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/* ---------- 顺序写(append-only) ---------- */

/** 日志写口:接受 node WriteStream,也接受任意按行写的手工 sink(便于测试注入)。 */
export interface LogSink {
  write(line: string): unknown;
}
export type GameLogSink = WriteStream | LogSink;

/** 每局一个计数器:sink 即身份;WeakMap 保证同局同流、异局各异。 */
const seqBySink = new WeakMap<object, number>();

function takeSeq(sink: object): number {
  const next = (seqBySink.get(sink) ?? 0) + 1;
  seqBySink.set(sink, next);
  return next;
}

/**
 * 按序写一行 JSON。
 * - sanitize(密钥隔离 hook)→ 补 `seq`/`ts` → 落一行。
 * - 返回写出的完整记录(带 seq/ts),调用方可直接用于 WS 广播。
 */
export function appendEvent(sink: GameLogSink, evt: GameEventInput): GameEvent {
  const clean = sanitizeForLog(evt) as Record<string, unknown>;
  const record: Record<string, unknown> = { ...clean, seq: takeSeq(sink), ts: new Date().toISOString() };
  sink.write(`${JSON.stringify(record)}\n`);
  return record as unknown as GameEvent;
}

/** 便利打开:自动建目录,追加模式。落点 `games/xiangqi/logs/<gameId>.jsonl`。 */
export async function openGameLog(filePath: string): Promise<WriteStream> {
  await mkdir(dirname(filePath), { recursive: true });
  return createWriteStream(filePath, { flags: 'a' });
}

/** 读回全部事件:按行 parse,容忍空行/尾换行;坏 JSON 直接抛错(快失败)。 */
export function readAllEvents(filePath: string): GameEvent[] {
  const text = readFileSync(filePath, 'utf8');
  const events: GameEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    events.push(JSON.parse(line) as GameEvent);
  }
  return events;
}