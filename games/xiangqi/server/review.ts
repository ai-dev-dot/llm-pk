//
// Task 21 —— 赛后 AI 复盘服务。
//
// 契约(controller + brief):
// - `reviewGame(logPath | events, ctx) → { kind:'ok'; review: ReviewPayload } | { kind:'degraded' }`;
// - 独立进程/独立凭据:复盘用**自己构造的 Anthropic 客户端**(独立 `review.baseUrl/apiKey/model`,
//   由调用方注入 `ctx`),绝不借用红/黑某方 key 混用;未配齐三要素 → 直接 degraded;
// - 只读公共日志:输入取整局 `GameEvent[]`(move 的公共 analysis 与记谱、illegal-attempt、finish 等),
//   绝不含双方私有上下文(本模块不触 arena 运行时与 Session);
// - 产出:`review` 事件 payload 的场外形态 `{ summary, highlights, mistakes:{side,move?,note}[] }`;
// - 降级:任何失败(缺凭据/缺终局/超时/5xx/网络/坏响应)→ `kind:'degraded'`,
//   绝不抛给调用方,也绝不修改输入事件(只读)。
// - 发射接线在 http.ts:对局 finished 后异步触发,以 appendEvent 落 `review`(带 seq)。
//

import type { GameEvent, Usage } from './game-log';
import { readAllEvents } from './game-log';
import type { Side } from '../engine/types';
import { DEFAULT_TOKENS_PER_M, estimateCostUsd, type TokensPerM } from './models/anthropic';

/* ---------- 产出结构(ReviewEvent 场外形态) ---------- */

export interface ReviewMistake {
  side: Side;
  move?: string;
  note: string;
}

export interface ReviewPayload {
  summary: string;
  highlights: string[];
  mistakes: ReviewMistake[];
  model?: string;
  elapsedMs?: number;
  usage?: Usage;
}

/** 复盘客户端注入边界:测试/上层可整体替换网络侧。 */
export interface ReviewClient {
  /** 输入公共对局叙述(digest),返回结构化产出;任何失败抛错(上层归一为 degraded)。 */
  generate(digest: string): Promise<{ payload: ReviewPayload; usage?: Usage; elapsedMs?: number }>;
}

export interface ReviewClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxTokens?: number;
  tokensPerM?: TokensPerM;
}

export interface ReviewContext extends ReviewClientConfig {
  /** 外部注入客户端(测试替身);缺省用默认 fetch 客户端。 */
  client?: ReviewClient;
}

export type ReviewResult = { kind: 'ok'; review: ReviewPayload } | { kind: 'degraded' };

/* ---------- 默认缺省 ---------- */

const DEFAULT_TIMEOUT_MS = 120_000;
const ANALYSIS_TRIM = 160; // 单条己方思考入叙述的截断长度(控制输入 token)

/* ---------- 公共对局叙述(digest)构造 ---------- */

const sideWord = (s: Side): string => (s === 'red' ? '红' : '黑');
const trim = (s: string): string => (s.length > ANALYSIS_TRIM ? `${s.slice(0, ANALYSIS_TRIM)}…` : s);

function buildDigest(events: GameEvent[]): string {
  const L: string[] = [];
  const begin = events.find((e): e is Extract<GameEvent, { type: 'begin' }> => e.type === 'begin');
  L.push('以下是一局中国象棋的完整公共对局记录(不含任何私有上下文)。请以客观进阶教练视角复盘。');
  L.push('');
  if (begin) {
    L.push(`对局模型: 红=${begin.red.model} 黑=${begin.black.model}`);
    L.push(`先手方: ${begin.first === 'red' ? '红方' : '黑方'}`);
    L.push('');
  }
  let half = 0;
  for (const e of events) {
    switch (e.type) {
      case 'move': {
        half++;
        const note = e.move.notation ? `(${e.move.notation})` : '';
        L.push(`第${half}半回合 ${sideWord(e.turn)}: ${e.move.from}→${e.move.to} ${note}`);
        if (e.analysis && e.analysis.trim() !== '') L.push(`  思考: ${trim(e.analysis)}`);
        break;
      }
      case 'illegal-attempt':
        L.push(`[打回] ${sideWord(e.side)} 第${e.round}次: ${e.reason}`);
        break;
      case 'captured':
        L.push(`[吃子] ${sideWord(e.side)} 吃掉对方${e.piece.type}@${e.at}`);
        break;
      case 'check':
        L.push(`[将军] ${sideWord(e.side)}`);
        break;
      case 'draw':
        L.push(`[和棋] 原因=${e.reason}`);
        break;
      case 'retry':
        L.push(`[网络重试] ${sideWord(e.side)} 第${e.attempt}次 ${e.cause ?? 'network'}`);
        break;
      case 'timeout':
        L.push(`[超时] ${sideWord(e.side)}`);
        break;
      case 'finish': {
        const winnerText = e.winner === 'draw' ? '和棋' : `${sideWord(e.winner)}胜`;
        L.push(`[终局] ${winnerText}，原因=${e.reason}`);
        const { red, black } = e.ruleViolations;
        L.push(`规则违规计数 红=pre${red.pre}/post${red.post}，黑=pre${black.pre}/post${black.post}`);
        break;
      }
      default:
        break; // begin/error/player-message/review 等不进叙述
    }
  }
  L.push('');
  L.push('请仅以 JSON 返回复盘结果,结构:');
  L.push('{ "summary": string, "highlights": string[], "mistakes": [{ "side": "red"|"black", "move"?: string, "note": string }] }');
  L.push('summary 概括整局走势与胜负原因;highlights 列出关键转折(至多 5 条);mistakes 指出具体失误(可带坐标/记谱)与改法建议(至多 5 条)。只输出 JSON。');
  return L.join('\n');
}

/* ---------- 产出规范化(坏输出一律抛错 → 上层 degraded) ---------- */

function normalizePayload(input: unknown): ReviewPayload {
  const obj = input as Record<string, unknown> | null;
  if (!obj || typeof obj !== 'object') throw new Error('复盘输出非对象');
  const summary = obj.summary;
  if (typeof summary !== 'string' || summary.trim() === '') throw new Error('复盘缺 summary');
  const highlights = Array.isArray(obj.highlights)
    ? obj.highlights.filter((h): h is string => typeof h === 'string')
    : [];
  let mistakes: ReviewMistake[] = [];
  if (obj.mistakes !== undefined) {
    if (!Array.isArray(obj.mistakes)) throw new Error('mistakes 非数组');
    mistakes = obj.mistakes.map((m) => {
      const o = m as Record<string, unknown> | null;
      if (!o || typeof o !== 'object') throw new Error('mistake 项非对象');
      if (o.side !== 'red' && o.side !== 'black') throw new Error('mistake.side 非法');
      const note = o.note;
      if (typeof note !== 'string' || note.trim() === '') throw new Error('mistake 缺 note');
      const move = typeof o.move === 'string' && o.move.trim() !== '' ? o.move : undefined;
      const out: ReviewMistake = { side: o.side as Side, note };
      if (move) out.move = move;
      return out;
    });
  }
  return { summary, highlights, mistakes };
}

/* ---------- 默认客户端(原生 fetch,Anthropic 协议) ---------- */

function messagesUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
}

const REVIEW_SYSTEM =
  '你是中国象棋复盘教练。你只会阅读公共对局记录并输出严格 JSON,绝不编造不存在的事件或步法。';

function toNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function readUsage(json: unknown, tokensPerM: TokensPerM): Usage {
  const usage = (json as { usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null)?.usage ?? {};
  const promptTokens = toNum(usage.input_tokens);
  const completionTokens = toNum(usage.output_tokens);
  return { promptTokens, completionTokens, costUsd: estimateCostUsd(promptTokens, completionTokens, tokensPerM) };
}

function createDefaultClient(cfg: ReviewClientConfig): ReviewClient {
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = cfg.maxTokens; // 默认不传 max_tokens(交给端点默认);显式给才带
  const tokensPerM = cfg.tokensPerM ?? DEFAULT_TOKENS_PER_M;
  return {
    async generate(digest: string) {
      const started = Date.now();
      const body = {
        model: cfg.model,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        system: REVIEW_SYSTEM,
        messages: [{ role: 'user', content: digest }],
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(messagesUrl(cfg.baseUrl), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
            'x-api-key': cfg.apiKey,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw new Error(`复盘请求超时(>${timeoutMs}ms)`);
        throw err;
      } finally {
        clearTimeout(timer);
      }

      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error('复盘响应非 JSON');
      }
      const content = (json as { content?: unknown[] } | null)?.content;
      if (!Array.isArray(content)) throw new Error('复盘响应缺少 content 数组');
      const textBlock = content.find(
        (b) => b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'text',
      );
      const rawText = (textBlock as { text?: unknown } | undefined)?.text;
      if (typeof rawText !== 'string' || rawText.trim() === '') throw new Error('复盘响应缺少 text 输出');

      // 容错:模型可能把 JSON 包在 ```json 代码块里。
      const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        throw new Error('复盘 text 非 JSON');
      }
      const payload = normalizePayload(parsed);
      const usage = readUsage(json, tokensPerM);
      return { payload, usage, elapsedMs: Date.now() - started };
    },
  };
}

/* ---------- 主入口 ---------- */

/**
 * 赛后复盘:只读整局公共事件,生成复盘摘要;任何失败降级。
 * - 输入 `string`(JSONL 日志路径)→ readAllEvents;`GameEvent[]` 直接用(只读,不改入参)。
 * - `ctx.client` 可注入(测试);缺省用独立凭据构造的默认 fetch 客户端。
 * - 本函数不写任何事件,不触 arena/Session —— 落 `review` 事件由调用方决定。
 */
export async function reviewGame(
  eventsOrLogPath: string | GameEvent[],
  ctx: ReviewContext,
): Promise<ReviewResult> {
  let events: GameEvent[];
  if (typeof eventsOrLogPath === 'string') {
    try {
      events = readAllEvents(eventsOrLogPath);
    } catch {
      return { kind: 'degraded' };
    }
  } else {
    if (!Array.isArray(eventsOrLogPath)) return { kind: 'degraded' };
    events = eventsOrLogPath;
  }

  if (!ctx || typeof ctx !== 'object') return { kind: 'degraded' };
  // 独立凭据硬性条款:复盘必须自带三要素,绝不借用红/黑方 key。
  if (!ctx.baseUrl || !ctx.apiKey || !ctx.model) return { kind: 'degraded' };
  // 只复盘已终局对局(缺 finish 视为输入不完整 → 降级)。
  if (!events.some((e) => e.type === 'finish')) return { kind: 'degraded' };

  const started = Date.now();
  const client = ctx.client ?? createDefaultClient(ctx);
  const digest = buildDigest(events);
  try {
    const { payload, usage, elapsedMs } = await client.generate(digest);
    return {
      kind: 'ok',
      review: {
        ...payload,
        model: ctx.model,
        elapsedMs: elapsedMs ?? Date.now() - started,
        ...(usage ? { usage } : {}),
      },
    };
  } catch {
    return { kind: 'degraded' };
  }
}