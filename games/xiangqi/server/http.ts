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
import { appendEvent, readAllEvents } from './game-log';
import { AnthropicPlayer, DEFAULT_TOKENS_PER_M } from './models/anthropic';
import type { TokensPerM } from './models/anthropic';
import type { Side } from '../engine/types';
import { reviewGame, type ReviewClient, type ReviewContext } from './review';
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

/**
 * 一个可复用的 LLM 配置项(config.json 的 `models` 注册表)。
 * 红/黑/复盘按名引用(`{ "use": "<name>" }`),各自独立端点/密钥/模型,可重复引用。
 * 字段沿用 config 的 snake_case;secret 只存在于服务端 config 与 player 构造,绝不外发/落日志。
 */
export interface ModelProfile {
  base_url?: string;
  api_key?: string;
  model?: string;
  system_prompt?: string;
  max_tokens?: number;
  timeout_ms?: number;
  tokens_per_m?: TokensPerM;
}

/** 红/黑在 config 里的引用形态:按名引用 profile,或旧格式只给 model。 */
export interface SideDefaults {
  use?: string;
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
  timeoutMs?: number;
  tokensPerM?: TokensPerM;
}

/** `config.json` 的读取形态(服务器级缺省;secret 只为补参,不落日志)。 */
export interface ServerDefaults {
  /** LLM 注册表:任意多个命名 profile,红/黑/复盘按 `use` 引用。 */
  models?: Record<string, ModelProfile>;
  /** 旧格式兼容:顶层单一端点/密钥(无 models 时回落)。 */
  base_url?: string;
  api_key?: string;
  port?: number;
  steps?: number;
  max_tokens?: number;
  timeout_ms?: number;
  red?: SideDefaults;
  black?: SideDefaults;
  rules?: Partial<GameRulesSnapshot>;
  maxCostPerGame?: number;
  networkRetryBaseDelayMs?: number;
  /** 赛后复盘缺省(独立凭据;`use` 引用 models,或自带 base_url/api_key/model;三要素缺一则复盘禁用)。 */
  review?: {
    use?: string;
    base_url?: string;
    api_key?: string;
    model?: string;
    max_tokens?: number;
    timeout_ms?: number;
    tokens_per_m?: { input?: number; output?: number };
  };
}

/** 请求体里解析出的复盘客户端配置(secret 只在服务内存,绝不外发/落日志)。 */
export interface ResolvedReview {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxTokens?: number;
  tokensPerM?: TokensPerM;
}

export interface GameRecord {
  id: string;
  arena: Arena;
  logPath: string;
  /** 该局的日志 sink(与 arena 共用一个对象,`appendEvent` 的 seq 沿同一序列延续)。 */
  sink: GameLogSink;
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
  /** 复盘客户端注入(测试替身);缺省 review 服务自建独立凭据客户端。 */
  reviewClient?: ReviewClient;
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
/** 非空字符串:空白串/空串视为"未提供"(表单留空回落 config 的关键)。 */
const nes = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.trim() : undefined;
  return s ? s : undefined;
};
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const obj = <T>(v: unknown): T | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as T) : undefined;

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
    const cfgBody = obj<Record<string, unknown>>(body.config) ?? {};
    const reqTimeoutMs = num(cfgBody.timeoutMs); // 请求级 config.timeoutMs(与 config.json timeout_ms 同权,请求级优先)
    const red = resolveSide('red', body.red, dflt, reqTimeoutMs);
    const black = resolveSide('black', body.black, dflt, reqTimeoutMs);

    const rules = resolveRules(cfgBody, dflt);
    // B4:begin.rules.timeoutMs 须反映真实生效值 —— config.json 顶层 timeout_ms 亦参与回落,不再硬报默认 120000。
    if (rules.timeoutMs === undefined && dflt.timeout_ms !== undefined) rules.timeoutMs = dflt.timeout_ms;
    const maxCostPerGame = num(cfgBody.maxCostPerGame) ?? dflt.maxCostPerGame;
    const networkRetryBaseDelayMs = num(cfgBody.networkRetryBaseDelayMs) ?? dflt.networkRetryBaseDelayMs;

    const gid = randomUUID();
    const logPath = join(logDir, `${gid}.jsonl`);
    const sink = fileLogSink(logPath); // 与 arena 共用同一对象,事后复盘追加在同一 seq 序列上
    const arena = registry.create({
      gameId: gid,
      red: { player: buildPlayer('red', red), model: red.model, systemPrompt: red.systemPrompt },
      black: { player: buildPlayer('black', black), model: black.model, systemPrompt: black.systemPrompt },
      sink,
      rules,
      maxCostPerGame,
      networkRetryBaseDelayMs,
    });
    const record: GameRecord = {
      id: gid,
      arena,
      logPath,
      sink,
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
    // 终局后异步触发赛后复盘(独立凭据客户端;失败静默降级,绝不影响对局状态)。
    const reviewOpts = resolveReview(body.review, dflt);
    if (reviewOpts) {
      arena.onEvent.on('finish', () => {
        void triggerReview(record, { ...reviewOpts, client: opts.reviewClient }).catch(() => {
          /* reviewGame 已兜底为 degraded;此处防御意外同步抛错 */
        });
      });
    }
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
    // L5:非法规则值(Arena 构造抛 RangeError,如 illegalAttemptsLimit:0)→ 400 VALIDATION_ERROR 而非 500。
    if (err instanceof RangeError) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: err.message, hint: '规则参数非法' },
      });
      return;
    }
    const e = err as (Error & { status?: number; statusCode?: number; type?: string }) | undefined;
    const status = e?.status ?? e?.statusCode;
    // body-parser 等请求类错误(400..499):按原状态码回(如 413 超大 body),不误落 500
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({
        error: {
          code: typeof e?.type === 'string' && e.type !== '' ? e.type : 'BAD_REQUEST',
          message: e instanceof Error ? e.message : String(e),
          hint: '请求不符合预期',
        },
      });
      return;
    }
    // 顶层兜底:只打 message/code,绝不打印原始错误对象字段(防密钥等敏感值入日志)
    // eslint-disable-next-line no-console
    console.error(
      `[xiangqi-http] 未捕获错误: ${e instanceof Error ? e.message : String(err)} (${e instanceof Error ? e.name : 'unknown'})`,
    );
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
  /** 按名取 config.models 里的 profile;未定义 → 400(不静默回落,避免配错名打到错误端点)。 */
  function resolveProfile(name: string, d: ServerDefaults): ModelProfile {
    const p = d.models?.[name];
    if (!p) {
      throw new HttpError(
        400,
        'VALIDATION_ERROR',
        `config.models 中未定义模型: "${name}"`,
        '请在 config.json 的 models 注册表中定义该名称,或改用内联 baseUrl/apiKey/model',
      );
    }
    return p;
  }

  function resolveSide(side: Side, raw: unknown, d: ServerDefaults, reqTimeoutMs?: number): ResolvedSide {
    const b = obj<Record<string, unknown>>(raw);
    if (!b) throw new HttpError(400, 'VALIDATION_ERROR', `body.${side} 必填`);
    const defSide = (side === 'red' ? d.red : d.black) ?? {};

    // ① 按名引用 profile:请求体 use 优先,回落 config.<side>.use。
    const useName = nes(b.use) ?? nes(defSide.use);
    const prof = useName ? resolveProfile(useName, d) : undefined;

    // ② baseUrl / model:请求体内联 > 被引用 profile > 旧格式顶层/config.<side>.model。
    //    nes() 把空串/空白视为未提供(表单留空 → 回落 config)。
    const baseUrl = nes(b.baseUrl) ?? nes(prof?.base_url) ?? nes(d.base_url);
    const model = nes(b.model) ?? nes(prof?.model) ?? nes(defSide.model);
    if (!baseUrl) {
      throw new HttpError(400, 'VALIDATION_ERROR', `body.${side}.baseUrl 必填`, '或在 config.json 为该方配置 use 指向 models');
    }
    if (!model) {
      throw new HttpError(400, 'VALIDATION_ERROR', `body.${side}.model 必填`, '或在 config models 的 profile 中配置 model');
    }

    // ③ 密钥外带防护(红线):未显式给 apiKey 时,服务端 key 只能回落给"与最终 baseUrl 同源"的那份:
    //    - profile 的 key 仅当 baseUrl 取自该 profile(未被请求体篡改)时可用;
    //    - 旧格式顶层 api_key 仅当 baseUrl === config.base_url 时可用;
    //    否则 400——绝不把服务端密钥发往请求体指定的任意端点。
    let apiKey = nes(b.apiKey);
    if (!apiKey && prof && baseUrl === nes(prof.base_url)) apiKey = nes(prof.api_key);
    if (!apiKey && baseUrl === nes(d.base_url)) apiKey = nes(d.api_key);
    if (!apiKey) {
      throw new HttpError(
        400,
        'VALIDATION_ERROR',
        `body.${side}.apiKey 必填`,
        '未给 apiKey 且 baseUrl 与服务端配置端点不一致(密钥外带防护):请显式提供 apiKey,或使用 config 中定义的模型名',
      );
    }

    return {
      baseUrl,
      apiKey,
      model,
      systemPrompt:
        nes(b.systemPrompt) ?? nes(b.system_prompt) ?? nes(prof?.system_prompt) ?? nes(defSide.systemPrompt),
      maxTokens:
        num(b.maxTokens) ?? num(b.max_tokens) ?? num(prof?.max_tokens) ?? num(defSide.maxTokens) ?? num(d.max_tokens),
      // B4:请求级 config.timeoutMs 与 config.json timeout_ms 同权;请求级优先,单边显式值仍最优先。
      timeoutMs:
        num(b.timeoutMs) ??
        num(b.timeout_ms) ??
        num(prof?.timeout_ms) ??
        num(defSide.timeoutMs) ??
        reqTimeoutMs ??
        num(d.timeout_ms),
      tokensPerM:
        obj<TokensPerM>(b.tokensPerM) ?? obj<TokensPerM>(b.tokens_per_m) ?? obj<TokensPerM>(prof?.tokens_per_m) ?? defSide.tokensPerM,
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

/**
 * 解析复盘配置:请求体 `review` 优先,dflt(config.json) 补齐。
 * **独立凭据硬性条款**:baseUrl/apiKey/model 三要素缺一 ⇒ 返回 undefined(复盘禁用),
 * 绝不借用红/黑某方 key 补位。
 */
function resolveReview(raw: unknown, d: ServerDefaults): ResolvedReview | undefined {
  const b = obj<Record<string, unknown>>(raw);
  const def = d.review ?? {};
  // review.use 引用 models 注册表;引用未定义/profile 不全 → prof 为空 → 三要素缺 → 降级(复盘是可选增强,不令建局失败)。
  const useName = nes(b?.use) ?? nes(def.use);
  const prof = useName ? d.models?.[useName] : undefined;
  const baseUrl = nes(b?.baseUrl) ?? nes(prof?.base_url) ?? nes(def.base_url);
  const model = nes(b?.model) ?? nes(prof?.model) ?? nes(def.model);
  // 独立凭据红线:复盘只用它引用的 profile key 或 review 段自带 key,绝不借红黑/顶层 api_key。
  // 同样按 baseUrl 同源回落,防请求体篡改 baseUrl 外带服务端密钥。
  let apiKey = nes(b?.apiKey);
  if (!apiKey && prof && baseUrl === nes(prof.base_url)) apiKey = nes(prof.api_key);
  if (!apiKey && baseUrl === nes(def.base_url)) apiKey = nes(def.api_key);
  if (!baseUrl || !apiKey || !model) return undefined; // 三要素缺一 ⇒ 复盘禁用(静默降级)
  return {
    baseUrl,
    apiKey,
    model,
    maxTokens: num(b?.maxTokens) ?? num(b?.max_tokens) ?? num(prof?.max_tokens) ?? num(def.max_tokens),
    timeoutMs: num(b?.timeoutMs) ?? num(b?.timeout_ms) ?? num(prof?.timeout_ms) ?? num(def.timeout_ms),
    tokensPerM: resolveTokensPerM(
      obj(b?.tokensPerM) ?? obj(b?.tokens_per_m),
      prof?.tokens_per_m ?? def.tokens_per_m,
    ),
  };
}

/** 合并 tokens_per_m(请求体优先,config.json 补齐;只配单边时另一侧回落 DEFAULT)。 */
function resolveTokensPerM(
  req?: unknown,
  def?: { input?: number; output?: number },
): TokensPerM | undefined {
  const r = obj<Record<string, unknown>>(req);
  const input = num(r?.input) ?? def?.input;
  const output = num(r?.output) ?? def?.output;
  if (input !== undefined && output !== undefined) return { input, output };
  if (input !== undefined || output !== undefined) {
    const base = DEFAULT_TOKENS_PER_M;
    return { input: input ?? base.input, output: output ?? base.output };
  }
  return undefined;
}

/**
 * 终局后异步触发赛后复盘:ok 则以同一 sink 追加 `review` 事件(seq 延续),
 * 并同步进内存镜像 + 广播(WS 实时帧与断线重连补发同源);degraded 静默不作任何落地。
 */
async function triggerReview(record: GameRecord, ctx: ReviewContext): Promise<void> {
  const result = await reviewGame([...record.events], ctx);
  if (result.kind !== 'ok') return;
  const { review } = result;
  const recorded = appendEvent(record.sink, {
    type: 'review',
    summary: review.summary,
    highlights: review.highlights,
    mistakes: review.mistakes,
    keyPoints: review.highlights, // 兼容别名:早期前端仅消费 keyPoints,映射同值保证要点可渲染
    model: review.model,
    elapsedMs: review.elapsedMs,
    usage: review.usage,
  });
  // `event` 广播会触发 http.ts 的镜像 listener(record.events.push)与 WS 推流 ——
  // 只此一处落地,不手动 push,避免事件被双重计入镜像。
  record.arena.onEvent.emit('event', recorded);
}

