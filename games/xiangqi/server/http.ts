//
// Task 17 —— REST 服务与多局管理装配(http.ts)。
//
// 契约(brief + controller):
// - POST /api/games:body `{ red:{baseUrl,apiKey,model,...}, black:{…}, config?:{…} }` → 201 { id };
//   必填校验(red/black 各自的 model/baseUrl/apiKey),缺参 400;`config` 透传规则参数
//   (illegalAttemptsLimit 等),`secret(apiKey)` 只用于构造模型客户端、**绝不**落日志/上响应;
// - GET /api/games(列表:id/红黑 model/status/回合数/winner)、GET /api/games/:id(详情+当前 phase)、
//   GET /api/games/:id/replay(读日志 → 事件数组,供回放);
// - POST /api/games/:id/pause|resume|step;非法状态 409、不存在 404;
// - 错误统一格式 `{ error: { code, message, hint } }`(spec §11)。
//
// 玩家构造可注入(`buildPlayer`,测试用脚本化 Player 免网);缺省构造 AnthropicPlayer。
// 事件源:arena.onEvent 桥接到内存镜像(record.events,与日志同步;appendFileSync 保证落盘即时),
// WS 增量与 REST 回放同源。
//

import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Express } from 'express';
import type { WebSocketServer as WSS } from 'ws';
import type { Arena } from './arena';
import type { Player } from './arena';
import { GameRegistry } from './game-registry';
import type { GameEvent, GameLogSink, GameRulesSnapshot } from './game-log';
import { readAllEvents } from './game-log';
import { AnthropicPlayer } from './models/anthropic';
import type { TokensPerM } from './models/anthropic';
import type { Side } from '../engine/types';
import { attachWsServer } from './ws';

/* ---------- 类型 ---------- */

/** 单边解析后的模型客户端配置(secret 仅存在于此层,不进入任何对外结构)。 */
export interface ResolvedSide {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt?: string;
  maxTokens?: number;
  timeoutMs?: number;
  tokensPerM?: TokensPerM;
}

export type PlayerFactory = (side: Side, cfg: ResolvedSide) => Player;

/** `config.json` 的读取形态(服务器级缺省;secret 只为补参,不落日志)。 */
export interface ServerDefaults {
  base_url?: string;
  api_key?: string;
  port?: number;
  steps?: number;
  max_tokens?: number;
  timeout_ms?: number;
  red?: { model?: string; systemPrompt?: string; maxTokens?: number; timeoutMs?: number; tokensPerM?: TokensPerM };
  black?: { model?: string; systemPrompt?: string; maxTokens?: number; timeoutMs?: number; tokensPerM?: TokensPerM };
  rules?: Partial<GameRulesSnapshot>;
  maxCostPerGame?: number;
  networkRetryBaseDelayMs?: number;
}

export interface GameRecord {
  id: string;
  arena: Arena;
  logPath: string;
  /** 与日志严格同源的内存事件镜像(每事件 append 一次)。 */
  events: GameEvent[];
  redModel: string;
  blackModel: string;
  redSystemPrompt?: string;
  blackSystemPrompt?: string;
  createdAt: string;
}

export interface XiangqiServerOptions {
  registry?: GameRegistry;
  /** 玩家工厂注入(缺省 AnthropicPlayer;测试用脚本化 Player)。 */
  buildPlayer?: PlayerFactory;
  /** 日志目录;缺省 `games/xiangqi/logs`。 */
  logDir?: string;
  /** `config.json` 缺省(作为请求体缺省补齐)。 */
  config?: ServerDefaults;
}

export interface XiangqiServer {
  server: http.Server;
  registry: GameRegistry;
  store: Map<string, GameRecord>;
  wss: WSS;
  dispose: () => Promise<void>;
}

/* ---------- 小工具 ---------- */

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const obj = <T>(v: unknown): T | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as T) : undefined;

function requireString(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') throw new Error('required');
  return v;
}

/**
 * 日志落盘:用 appendFileSync 保证「write 返回即已持久化」,回放/补发与实时严格同源。
 * 目录若被外部删除(如测试清理时序),写失败时重建目录重试一次,保证事件不丢。
 */
function fileLogSink(filePath: string): GameLogSink {
  const dir = dirname(filePath);
  const write = (line: string) => appendFileSync(filePath, line, 'utf8');
  mkdirSync(dir, { recursive: true });
  return {
    write(line: string) {
      try {
        write(line);
      } catch (err) {
        if ((err as { code?: string })?.code === 'ENOENT') {
          try {
            mkdirSync(dir, { recursive: true });
            write(line);
            return;
          } catch {
            /* 重建仍失败则抛原始错误 */
          }
        }
        throw err;
      }
    },
  };
}

const defaultBuildPlayer: PlayerFactory = (side, cfg) =>
  new AnthropicPlayer({
    side,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    systemPrompt: cfg.systemPrompt,
    maxTokens: cfg.maxTokens,
    timeoutMs: cfg.timeoutMs,
    tokensPerM: cfg.tokensPerM,
  });

const DEFAULT_LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs');

/* ---------- 服务装配 ---------- */

export function createXiangqiServer(opts: XiangqiServerOptions = {}): XiangqiServer {
  const registry = opts.registry ?? new GameRegistry();
  const store = new Map<string, GameRecord>();
  const logDir = opts.logDir ?? DEFAULT_LOG_DIR;
  const dflt = opts.config ?? {};
  const buildPlayer = opts.buildPlayer ?? defaultBuildPlayer;

  const app: Express = express();
  app.disable('x-powered-by');
  app.use(express.json());

  /* ---------- POST /api/games ---------- */
  app.post('/api/games', (_req, res) => {
    const body = obj<Record<string, unknown>>(_req.body) ?? {};
    const red = resolveSide('red', body.red, dflt);
    const black = resolveSide('black', body.black, dflt);

    const cfgBody = obj<Record<string, unknown>>(body.config) ?? {};
    const rules = resolveRules(cfgBody, dflt);
    const maxCostPerGame = num(cfgBody.maxCostPerGame) ?? dflt.maxCostPerGame;
    const networkRetryBaseDelayMs = num(cfgBody.networkRetryBaseDelayMs) ?? dflt.networkRetryBaseDelayMs;

    const gid = randomUUID();
    const logPath = join(logDir, `${gid}.jsonl`);
    const arena = registry.create({
      gameId: gid,
      red: { player: buildPlayer('red', red), model: red.model, systemPrompt: red.systemPrompt },
      black: { player: buildPlayer('black', black), model: black.model, systemPrompt: black.systemPrompt },
      sink: fileLogSink(logPath),
      rules,
      maxCostPerGame,
      networkRetryBaseDelayMs,
    });
    const record: GameRecord = {
      id: gid,
      arena,
      logPath,
      events: [],
      redModel: red.model,
      blackModel: black.model,
      redSystemPrompt: red.systemPrompt,
      blackSystemPrompt: black.systemPrompt,
      createdAt: new Date().toISOString(),
    };
    store.set(gid, record);
    // 先挂上事件镜像(含 begin),再启动;begin 在 start() 同步阶段落日志,镜像不漏。
    arena.onEvent.on('event', (evt: GameEvent) => record.events.push(evt));
    void arena.start();

    res.status(201).json({ id: gid });
  });

  /* ---------- GET /api/games ---------- */
  app.get('/api/games', (_req, res) => {
    const games = [...store.values()].map((r) => ({
      id: r.id,
      red: { model: r.redModel },
      black: { model: r.blackModel },
      status: r.arena.state,
      moveCount: r.arena.moveCount,
      winner: winnerOf(r),
    }));
    res.json({ games });
  });

  /* ---------- GET /api/games/:id ---------- */
  app.get('/api/games/:id', (req, res) => {
    const r = mustGame(req.params.id);
    res.json({
      id: r.id,
      status: r.arena.state,
      phase: r.arena.state,
      turn: r.arena.turn,
      moveCount: r.arena.moveCount,
      red: { model: r.redModel, systemPrompt: r.redSystemPrompt },
      black: { model: r.blackModel, systemPrompt: r.blackSystemPrompt },
      winner: winnerOf(r),
      reason: reasonOf(r),
      totalCostUsd: r.arena.totalCost,
      createdAt: r.createdAt,
    });
  });

  /* ---------- GET /api/games/:id/replay ---------- */
  app.get('/api/games/:id/replay', (req, res) => {
    const r = mustGame(req.params.id);
    // 读日志(append-only JSONL,已 sanitize)→ 事件数组,供回放与实时同源 diff。
    const events = readAllEvents(r.logPath);
    res.json({ id: r.id, events });
  });

  /* ---------- 控制端点 ---------- */
  app.post('/api/games/:id/pause', (req, res) => {
    const r = mustGame(req.params.id);
    const st = r.arena.state;
    if (st !== 'running' && st !== 'paused') {
      throw new HttpError(409, 'INVALID_STATE', `当前状态 ${st} 不可 pause`, '仅 running/paused 可 pause');
    }
    r.arena.pause();
    res.json({ id: r.id, status: r.arena.state });
  });

  app.post('/api/games/:id/resume', (req, res) => {
    const r = mustGame(req.params.id);
    const st = r.arena.state;
    if (st !== 'paused' && st !== 'running') {
      throw new HttpError(409, 'INVALID_STATE', `当前状态 ${st} 不可 resume`, '仅 paused/running 可 resume');
    }
    r.arena.resume();
    res.json({ id: r.id, status: r.arena.state });
  });

  app.post('/api/games/:id/step', async (req, res) => {
    const r = mustGame(req.params.id);
    const st = r.arena.state;
    if (st !== 'paused') {
      throw new HttpError(409, 'INVALID_STATE', `step 仅可在暂停态调用(当前 ${st})`, '请先 pause 再 step');
    }
    await r.arena.step(); // 请求在单半回合完成后返回,语义同步
    res.json({ id: r.id, status: r.arena.state, moveCount: r.arena.moveCount });
  });

  /* ---------- 404 与错误兜底 ---------- */
  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: '资源不存在', hint: '请检查路径' } });
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, hint: err.hint } });
      return;
    }
    const e = err as (Error & { status?: number; type?: string }) | undefined;
    if (e?.type === 'entity.parse.failed' || e?.status === 400) {
      res.status(400).json({ error: { code: 'BAD_JSON', message: '请求体不是合法 JSON', hint: '请检查 body 格式' } });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[xiangqi-http] 未捕获错误:', err);
    res.status(500).json({
      error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(err), hint: '服务器内部错误' },
    });
  });

  const server = http.createServer(app);
  const wss = attachWsServer(server, store);

  return {
    server,
    registry,
    store,
    wss,
    dispose: async () => {
      for (const ws of wss.clients) ws.close();
      await new Promise<void>((res) => wss.close(() => res()));
      await new Promise<void>((res) => server.close(() => res()));
      for (const r of store.values()) registry.dispose(r.id);
    },
  };

  /* ---------- 内部 ---------- */
  function resolveSide(side: Side, raw: unknown, d: ServerDefaults): ResolvedSide {
    const b = obj<Record<string, unknown>>(raw);
    if (!b) throw new HttpError(400, 'VALIDATION_ERROR', `body.${side} 必填`);
    const defSide = (side === 'red' ? d.red : d.black) ?? {};

    let model: string;
    try {
      model = requireString(str(b.model) ?? defSide.model);
    } catch {
      throw new HttpError(400, 'VALIDATION_ERROR', `body.${side}.model 必填`);
    }
    const baseUrl = str(b.baseUrl) ?? d.base_url;
    if (!baseUrl) throw new HttpError(400, 'VALIDATION_ERROR', `body.${side}.baseUrl 必填`);
    const apiKey = str(b.apiKey) ?? d.api_key;
    if (!apiKey) throw new HttpError(400, 'VALIDATION_ERROR', `body.${side}.apiKey 必填`);

    return {
      baseUrl,
      apiKey,
      model,
      systemPrompt: str(b.systemPrompt) ?? defSide.systemPrompt,
      maxTokens: num(b.maxTokens) ?? num(b.max_tokens) ?? defSide.maxTokens ?? d.max_tokens,
      timeoutMs: num(b.timeoutMs) ?? num(b.timeout_ms) ?? defSide.timeoutMs ?? d.timeout_ms,
      tokensPerM: obj(b.tokensPerM) ?? defSide.tokensPerM,
    };
  }

  function resolveRules(cfgBody: Record<string, unknown>, d: ServerDefaults): Partial<GameRulesSnapshot> {
    const defRules = d.rules ?? {};
    const out: Partial<GameRulesSnapshot> = {};
    const keys = [
      'drawRepeat',
      'illegalAttemptsLimit',
      'maxTotalMoves',
      'networkRetries',
      'timeoutMs',
      'carrySelfAnalysisN',
      'contextBudgetTokens',
    ] as const;
    for (const k of keys) {
      const v = num(cfgBody[k]) ?? defRules[k];
      if (v !== undefined) out[k] = v;
    }
    if (out.maxTotalMoves === undefined && d.steps !== undefined) out.maxTotalMoves = d.steps;
    return out;
  }

  function mustGame(id: string): GameRecord {
    const r = store.get(id);
    if (!r) throw new HttpError(404, 'NOT_FOUND', `对局不存在: ${id}`);
    return r;
  }
}

function winnerOf(r: GameRecord): Side | 'draw' | null {
  for (let i = r.events.length - 1; i >= 0; i--) {
    const e = r.events[i]!;
    if (e.type === 'finish') return e.winner;
  }
  return null;
}

function reasonOf(r: GameRecord): string | null {
  for (let i = r.events.length - 1; i >= 0; i--) {
    const e = r.events[i]!;
    if (e.type === 'finish') return e.reason;
  }
  return null;
}

