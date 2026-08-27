//
// Anthropic 协议棋手适配器(task 16)。
//
// 契约(brief §6 + controller):
// - `AnthropicPlayer implements Player`:红黑仅构造参数不同(原则 B);构造
//   `({ side, baseUrl, apiKey, model, timeoutMs?, networkRetryBaseDelayMs?, maxTokens?, tokensPerM? })`;
// - `pickMove(ctx)` 构建 system(复用 spike 的同一模板,仅「红/黑、执先/执后」文本差异)
//   与 user(asciiBoard + history + selfThoughts + rejection?),以 tool-use 强制输出
//   `{ analysis, move }`(tool_choice type 强制该工具),并回传 `usage` 供 arena 记成本;
// - 隔离(原则 C):只读 `ctx.selfThoughts`(己方)与公共 `history`,绝不自行拼装对方 analysis;
// - 回显(原则 D):绝不把 legalMoves 清单写进任何 user 消息;rejection 只带中文讲评原因;
// - 网络错误:传输失败 / 超时(AbortController @ timeoutMs)/ 5xx / 429 → `NetworkError(retryable=true)`;
//   其余 4xx(如密钥失效)→ `retryable=false`(arena 判 `isNetworkError` 后不再退避);
//   B2:200 但缺 tool_use / 缺 content / 工具参数缺失 → 返回空 move,交 arena 打回循环(PARSER_INVALID)。
//
// 用原生 fetch(node 18+),不引入 SDK;`baseUrl` 可指向任意 Anthropic 协议端点(`/v1/messages`)。
//

import type { MoveChoice, MoveContext, Player } from '../arena';
import { NetworkError, PlayerCancelled } from '../arena';
import type { Usage } from '../game-log';
import type { Side } from '../../engine/types';
import { buildSystemPrompt } from '../../scripts/spike-prompt';

export interface TokensPerM {
  /** 输入每百万 token 价(USD)。 */
  input: number;
  /** 输出每百万 token 价(USD)。 */
  output: number;
}

/** 缺省单价(代表值,可按实际模型覆盖):输入 $3 / 输出 $15 每百万 token。 */
export const DEFAULT_TOKENS_PER_M: TokensPerM = { input: 3, output: 15 };

/** 成本估算(USD):prompt*input + completion*output,按百万 token 折算。纯函数,便于测试。 */
export function estimateCostUsd(promptTokens: number, completionTokens: number, tokensPerM: TokensPerM): number {
  return (promptTokens * tokensPerM.input) / 1_000_000 + (completionTokens * tokensPerM.output) / 1_000_000;
}

export interface AnthropicPlayerConfig {
  side: Side;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 自定义 system 提示(如 config 里 `red.systemPrompt`);缺省用同一模板 buildSystemPrompt(side)。 */
  systemPrompt?: string;
  /**
   * 是否 SSE 流式(默认 false,JSON 一次性解析;GLM 等兼容端点流式+thinking 不稳,非流式才遵守 max_tokens);
   * 端点不支持流式 / 返回普通 JSON 时自动回退非流式解析,行为与原有 fetch 完全一致。
   */
  stream?: boolean;
  /** 单次请求超时(ms),默认 120000。超时抛 `NetworkError(retryable=true)`。 */
  timeoutMs?: number;
  /**
   * 网络重试相关——**重试策略由 arena 统一执行**(task 15),本字段为构造契约占位,
   * 供上层透传给 `ArenaConfig.networkRetryBaseDelayMs`;player 层不自行重试。
   */
  networkRetryBaseDelayMs?: number;
  /**
   * 输出 token 预算上限。**默认不传**(请求体省略 max_tokens,由端点用自身默认,
   * 适配长思考的大模型);仅在端点强制要求时显式给出。
   */
  maxTokens?: number;
  /**
   * 思考模式(原则 E),对齐 deepseek 官方双旋钮:
   * - 开关 `thinking.type`:`off` 显式传 `{type:'disabled'}`(防端点默认开启思考的后门);
   *   `high` | `max` 传 `{type:'enabled'}`。
   * - 强度 `output_config.effort`:`high` | `max` 下发与档位同名的值(`'high'` | `'max'`,
   *   对齐 deepseek 官方语义);`off` 不查 effort。
   * - **不附 budget_tokens**:部分 Anthropic 兼容端点(如 GLM open.bigmodel.cn)对显式思考
   *   预算实现不完整、会静默黑洞,预算交由端点自身默认。
   * 档位名(off/high/max)记录于 begin.rules.thinkingMode 供观测与对比。缺省 'off'。
   * 本设定始终显式下发,绝不依赖端点缺省。
   */
  thinkingMode?: 'off' | 'high' | 'max';
  /** 每百万 token 单价(USD),默认 `DEFAULT_TOKENS_PER_M`。 */
  tokensPerM?: TokensPerM;
}

/** 强制工具输出 `{ analysis, move }`。 */
const MOVE_TOOL_NAME = 'pick_move';
const MOVE_TOOL = {
  name: MOVE_TOOL_NAME,
  description:
    '提出你的走法:先写对局面的思考 analysis,再给出这一步 move(中文记谱如「炮二平五」或坐标如「h3-e3」)。',
  input_schema: {
    type: 'object',
    properties: {
      analysis: { type: 'string', description: '你对局面的思考过程' },
      move: { type: 'string', description: '这一步走法:中文记谱或坐标,如「炮二平五」/「h3-e3」' },
    },
    required: ['analysis', 'move'],
  },
} as const;

const DEFAULT_TIMEOUT_MS = 120_000;

/** max_tokens 截断后带提示重发的文案(G3c):告知模型因超长被截断,请精简并直接给 move。 */
const TRUNCATED_HINT =
  '注意:你上一次回复没有完成工具调用(未产出 pick_move)。请务必仍然调用 pick_move 工具提交 move(中文记谱或坐标);不要只输出普通文字、不要提前结束。若上一条是因输出超长被截断,请把 analysis 精简到一两句、先给 move 再略述。';

/** 无工具响应(max_tokens 截断 / end_turn 弃用)最多带提示重发的次数(含首次共 1+MAX 次请求)。 */
const MAX_TRUNCATE_RETRY = 2;

/**
 * 组装 user 消息(原则 C/D):棋盘 + 公共历史(+中文记谱旁注)+ 己方自省 + 打回讲评。
 * 只消费 MoveContext 的公开字段,绝不读取/拼装 ctx 以外任何内容。
 */
export function buildUserPrompt(ctx: MoveContext): string {
  const sideWord = ctx.side === 'red' ? '红' : '黑';
  const L: string[] = [];
  L.push(`当前局面(下方为红方、第 1 行;上方为黑方、第 10 行)。现在轮到${sideWord}方走棋:`);
  L.push('');
  L.push(ctx.asciiBoard);
  if (ctx.history.length > 0) {
    L.push('');
    L.push('已走出步法(统一坐标,中文记谱为旁注):');
    L.push(
      ctx.history
        .map((p, i) => {
          const note = p.notation ? `  ${p.notation}` : '';
          return `  ${i + 1}. ${p.move}${note}`;
        })
        .join('\n'),
    );
  }
  if (ctx.selfThoughts.length > 0) {
    L.push('');
    L.push('我方的思考(仅自己可见,供延续思路):');
    L.push(
      ctx.selfThoughts.map((t) => (t.move ? `  - ${t.move}: ${t.analysis}` : `  - ${t.analysis}`)).join('\n'),
    );
  }
  if (ctx.rejection) {
    const k = ctx.rejection.round > 1 ? `(第 ${ctx.rejection.round} 次被拒)` : '';
    L.push('');
    L.push(`【裁判】你的上一步无效${k},原因: ${ctx.rejection.reason}。请换一步,不要重复同一走法。`);
  }
  L.push('');
  L.push('请用工具提交 { analysis, move }。');
  return L.join('\n');
}

/** base_url → messages URL:末尾无 `/v1` 则补。 */
function messagesUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
}

interface ToolUseBlock {
  type?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
}

function toNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function parseInput(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    try {
      return JSON.parse(input) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (input ?? {}) as Record<string, unknown>;
}

export class AnthropicPlayer implements Player {
  public readonly side: Side;
  public readonly model: string;
  /** 最近一次成功调用的 usage;失败不更新。 */
  public lastUsage?: Usage;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxTokens?: number;
  private readonly tokensPerM: TokensPerM;
  private readonly systemPrompt?: string;
  private readonly thinkingMode: 'off' | 'high' | 'max';
  private readonly stream: boolean;
  /** 构造契约占位(透传 arena),player 层不自行重试。 */
  public readonly networkRetryBaseDelayMs?: number;
  /** 当前飞行请求的 AbortController(pause abort 用);无飞行请求时 null。 */
  private ctl: AbortController | null = null;
  /** 被外部 cancelPending 中止(pause)的标志 → 抛 PlayerCancelled,而非超时。 */
  private cancelled = false;

  constructor(cfg: AnthropicPlayerConfig) {
    this.side = cfg.side;
    this.baseUrl = cfg.baseUrl;
    this.apiKey = cfg.apiKey;
    this.model = cfg.model;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTokens = cfg.maxTokens;
    this.tokensPerM = cfg.tokensPerM ?? DEFAULT_TOKENS_PER_M;
    this.networkRetryBaseDelayMs = cfg.networkRetryBaseDelayMs;
    this.systemPrompt = cfg.systemPrompt;
    this.thinkingMode = cfg.thinkingMode ?? 'off';
    // G3:默认非流式(JSON 一次性返回)。GLM 等 Anthropic 兼容端点对「流式 + thinking」实现不完整
    // (黑洞/狂流/max_tokens 不生效);非流式路径遵守总输出上限。需实时思考展示时显式 stream:true。
    this.stream = cfg.stream ?? false;
  }

  /** 外部中止当前飞行请求(arena.pause 冻结回合用):置取消标志并 abort → 后续 AbortError 识别为暂停中止。 */
  cancelPending(): void {
    this.cancelled = true;
    this.ctl?.abort();
  }

  async pickMove(ctx: MoveContext): Promise<MoveChoice> {
    this.cancelled = false; // 新请求重置暂停标志
    const started = Date.now();
    // 自定义 systemPrompt 优先(arena config 传入可令其生效),缺省回落同一模板。
    const system = this.systemPrompt ?? buildSystemPrompt(this.side);
    const baseUser = buildUserPrompt(ctx);
    // 无工具响应重试(G3c):tool_choice 强制工具——模型主动结束但没给 move(max_tokens 截断 / end_turn 弃用)
    // 一律视为「未产出着法」→ 带 TRUNCATED_HINT 重发,最多 MAX_TRUNCATE_RETRY 次;仍失败则交 arena 打回。
    // 注:畸形端点响应(缺 stop_reason 等)不在此列,直接走原有"空 move → 打回"语义。
    for (let attempt = 0; ; attempt++) {
      const user = attempt === 0 ? baseUser : `${baseUser}\n\n${TRUNCATED_HINT}`;
      const parsed = await this.callOnce(system, user, ctx.onThought);
      const elapsedMs = Date.now() - started;
      if (parsed.usage) this.lastUsage = parsed.usage;
      const missingMove = parsed.move === '';
      const retryNoTool =
        missingMove && (parsed.stopReason === 'max_tokens' || parsed.stopReason === 'end_turn');
      if (!retryNoTool || attempt >= MAX_TRUNCATE_RETRY) {
        return {
          analysis: parsed.analysis,
          move: parsed.move,
          usage: parsed.usage ?? { promptTokens: 0, completionTokens: 0, costUsd: 0 },
          elapsedMs,
        };
      }
    }
  }

  /** 单次 Messages 请求(网络/HTTP/解析;超时与 pause 语义保持原样)。 */
  private async callOnce(system: string, user: string, onThought?: (chunk: string) => void): Promise<ParsedBody> {
    // 思考模式(原则 E),对齐 deepseek 官方双旋钮:off → 开关 disabled(防端点默认开后门);
    // high/max → 开关 enabled + 强度 effort('high'|'max');off 不查 effort。
    // 不附 budget_tokens:显式思考预算在部分兼容端点(如 GLM)静默黑洞,预算交端点默认。
    const thinking: Record<string, unknown> =
      this.thinkingMode === 'off' ? { type: 'disabled' } : { type: 'enabled' };
    const thinkingEffort = this.thinkingMode === 'max' ? 'max' : this.thinkingMode === 'high' ? 'high' : undefined;
    const body = {
      model: this.model,
      // max_tokens 默认省略:交给端点自身的输出上限(适配长思考);显式配置才带上。
      ...(this.maxTokens ? { max_tokens: this.maxTokens } : {}),
      system,
      messages: [{ role: 'user', content: user }],
      tools: [MOVE_TOOL],
      tool_choice: { type: 'tool', name: MOVE_TOOL_NAME },
      thinking,
      ...(thinkingEffort ? { output_config: { effort: thinkingEffort } } : {}),
      ...(this.stream ? { stream: true } : {}),
    };

    const controller = new AbortController();
    this.ctl = controller;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(messagesUrl(this.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof NetworkError) throw err; // httpError 已抛的保留原语义
      if (err instanceof Error && err.name === 'AbortError') {
        // 被外部 pause 中止(cancelPending)→ 暂停信号,不算超时、不算失败
        if (this.cancelled) throw new PlayerCancelled('回合被暂停中止');
        throw new NetworkError(`api timeout(>${this.timeoutMs}ms)`, true);
      }
      throw new NetworkError(`network error: ${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      // 注意:流式读取期间超时定时器仍需工作,故不能在这里 clear —— 移到读取完成后的收尾。
      if (!this.stream) this.ctl = null;
    }

    if (res.status < 200 || res.status >= 300) {
      clearTimeout(timer);
      const text = await consumeTextSafe(res);
      let json: unknown = null;
      try {
        json = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        json = null;
      }
      throw this.httpError(res.status, json);
    }

    try {
      return this.stream
        ? await readSseBody(res, this.tokensPerM, onThought)
        : await readJsonBody(res, this.tokensPerM);
    } catch (err) {
      if (err instanceof NetworkError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        if (this.cancelled) throw new PlayerCancelled('回合被暂停中止');
        throw new NetworkError(`api timeout(>${this.timeoutMs}ms)`, true);
      }
      throw new NetworkError(`读响应体失败: ${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      clearTimeout(timer);
      this.ctl = null;
    }
  }

  /** 非 2xx:429/5xx 可重试;其余 4xx 为确定性错误(不重试)。 */
  private httpError(status: number, json: unknown): NetworkError {
    const message = httpErrorMessage(status, json);
    const retryable = status === 429 || status >= 500;
    return new NetworkError(`${message} (HTTP ${status})`, retryable);
  }
}

/* ---------- SSE 流式(via fetch body reader) ---------- */

/** @typedef readSseBody 返回:{ analysis, move, usage }。含 SSE 与非流式 JSON 双路径。 */

interface SseFinal {
  analysis: string;
  move: string;
}

/** 解析完成的请求结果:额外带 stop_reason(截断检测用;非流式写入,流式缺省 undefined)。 */
interface ParsedBody extends SseFinal {
  usage: Usage;
  stopReason?: string;
}

/** 从非流式 JSON 读 stop_reason(max_tokens = 截断标志)。 */
function readStopReason(json: unknown): string | undefined {
  const r = (json as { stop_reason?: unknown } | null)?.stop_reason;
  return typeof r === 'string' && r !== '' ? r : undefined;
}

/**
 * 安全读取整个响应体为字符串(读体失败抛 NetworkError,交 arena 重试)。
 * 非 2xx 的错误正文不严谨解析,只取文本给 httpError 也许可读 message;这里统一容错。
 */
async function consumeTextSafe(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    throw new NetworkError(`读响应体失败: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

/**
 * 非流式路径:整段 JSON → {analysis, move}。等价于旧 pickMove 的 JSON 解析。
 * 供 stream=false 或 SSE 回退(final 无事件)使用。
 */
async function readJsonBody(res: Response, tokensPerM: TokensPerM): Promise<ParsedBody> {
  const text = await consumeTextSafe(res);
  let json: unknown = null;
  try {
    json = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    json = null;
  }
  const { analysis, move } = extractToolUse(json);
  const usage = readUsage(json, tokensPerM);
  const stopReason = readStopReason(json);
  return { analysis, move, usage, stopReason };
}

/**
 * 流式路径:body 按 Web ReadableStream 读,累加为文本后按「\n\n」分块解析 SSE 事件。
 * - `content_block_delta.input_json_delta.partial_json` → 拼到 jsonBuf;
 * - 用 AnalysisScraper 实时截取 analysis 增量 → 调 `onThought`(若提供);
 * - 全部读完 / message_stop → JSON.parse(jsonBuf) 取最终 {analysis, move} + usage。
 *
 * 兼容性回退:若 body 读完仍**没有任何 SSE 事件**(如网关返回普通 JSON),
 * 整段按非流式 JSON 解析,行为与旧 fetch 路径完全一致。
 */
async function readSseBody(
  res: Response,
  tokensPerM: TokensPerM,
  onThought?: (chunk: string) => void,
): Promise<ParsedBody> {
  if (!res.body) return readJsonBody(res, tokensPerM);

  let allText = '';
  let jsonBuf = '';
  const receivedAnySse = { value: false };
  let emitted = 0;
  let usageRaw: AnthropicUsage = {};
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  const consume = (ev: { name: string; data: string }): void => {
    receivedAnySse.value = true;
    let data: unknown = null;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!data || typeof data !== 'object') return;
    const obj = data as Record<string, unknown>;

    // message_start / message_delta 携带 usage(若有流式计费)
    if ((obj.type === 'message_start' || obj.type === 'message_delta') && obj.usage) {
      const u = obj.usage as AnthropicUsage;
      const it = toNum(u.input_tokens);
      const ot = toNum(u.output_tokens);
      if (it > 0) usageRaw = { ...usageRaw, input_tokens: it };
      if (ot > 0) usageRaw = { ...usageRaw, output_tokens: ot };
    }
    if (obj.type !== 'content_block_delta') return;
    const delta = obj.delta as Record<string, unknown> | undefined;
    if (!delta || delta.type !== 'input_json_delta' || typeof delta.partial_json !== 'string') return;
    jsonBuf += delta.partial_json as string;
    const cur = extractAnalysisPrefix(jsonBuf);
    if (onThought && cur.length > emitted) {
      const chunk = cur.slice(emitted);
      emitted = cur.length;
      onThought(chunk);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        allText += decoder.decode(value, { stream: true });
        // 边读边切走已完整的 SSE 块(\n\n 结尾)
        for (;;) {
          const idx = allText.indexOf('\n\n');
          if (idx < 0) break;
          const ev = parseSseEvent(allText.slice(0, idx));
          allText = allText.slice(idx + 2);
          if (ev) consume(ev);
        }
      }
    }
    // 尾部残余
    const rest = allText.trim();
    if (rest !== '') {
      const ev = parseSseEvent(rest);
      if (ev) consume(ev);
    }
  } catch (err) {
    // AbortError 由调用方识别;其余读流异常按网络错误抛
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new NetworkError(`读响应体失败(stream): ${err instanceof Error ? err.message : String(err)}`, true);
  }

  if (receivedAnySse.value) {
    return finalizeSse(jsonBuf, usageRaw, tokensPerM);
  }
  // 无任何 SSE 事件 → 回退非流式(与 readJsonBody 等价)
  return readJsonBodyFallback(allText, tokensPerM);
}

/** 完全没 SSE 事件时,把累积的 body 文本当普通 JSON 解析。 */
async function readJsonBodyFallback(bodyText: string, tokensPerM: TokensPerM): Promise<ParsedBody> {
  let json: unknown = null;
  try {
    json = bodyText ? (JSON.parse(bodyText) as unknown) : null;
  } catch {
    json = null;
  }
  const { analysis, move } = extractToolUse(json);
  const usage = readUsage(json, tokensPerM);
  const stopReason = readStopReason(json);
  return { analysis, move, usage, stopReason };
}

/** SSE 事件字段提取(格式:event:\n data:{json}\n\n)。 */
function parseSseEvent(raw: string): { name: string; data: string } | null {
  const lines = raw.trim().split('\n');
  let event = '';
  const dataPart: string[] = [];
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataPart.push(line.slice('data:'.length).trimStart());
  }
  if (dataPart.length === 0) return null;
  return { name: event || 'message', data: dataPart.join('\n') };
}

/**
 * 从 (可能未闭合的) 累积 JSON 中提取 `"analysis": "..."` 的当前值字符串。
 * 返回 analysis 键之后已到达的字符串(未闭合也算),供流式增量回调;找不到键返回 ''。
 */
function extractAnalysisPrefix(json: string): string {
  const keyIdx = json.indexOf('"analysis"');
  if (keyIdx < 0) return '';
  // 找到键后冒号后的字符串起始引号
  let i = keyIdx + '"analysis"'.length;
  while (i < json.length && json[i] !== ':') i++;
  i++; // 跳过冒号
  while (i < json.length && (json[i] === ' ' || json[i] === '\t')) i++;
  if (i >= json.length || json[i] !== '"') return '';
  i++; // 跳起始引号
  let out = '';
  let inString = true;
  while (i < json.length && inString) {
    const ch = json[i];
    if (ch === '\\') {
      // 转义:直接吃下一个字符与反斜杠本身,保留原始形态(unicode 等)
      out += ch;
      if (i + 1 < json.length) out += json[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"') inString = false;
    else out += ch;
    i++;
  }
  return out;
}

/**
 * SSE 全部读完:用累积工具 input(jsonBuf,shape `{analysis, move}`,并非完整响应)
 * 解析最终 {analysis, move};usage 从事件中单独累计。未闭合/坏 JSON → 空 move 走打回。
 */
function finalizeSse(jsonBuf: string, usageRaw: AnthropicUsage, tokensPerM: TokensPerM): ParsedBody {
  let json: unknown = null;
  try {
    json = jsonBuf ? (JSON.parse(jsonBuf) as unknown) : null;
  } catch {
    json = null; // 流式未闭合 → 空(打回)
  }
  const input = (json ?? {}) as Record<string, unknown>;
  const analysis = typeof input.analysis === 'string' ? input.analysis : '';
  const move = typeof input.move === 'string' ? input.move : '';
  const usage = { promptTokens: toNum(usageRaw.input_tokens), completionTokens: toNum(usageRaw.output_tokens) };
  return { analysis, move, usage: { ...usage, costUsd: estimateCostUsd(usage.promptTokens, usage.completionTokens, tokensPerM) } };
}

/**
 * 从响应提取 tool_use 的 {analysis, move}。
 * B2:响应缺 tool_use / 缺 content / 工具参数缺失 → **不**抛 NetworkError(false)(否则落入
 * internal-error 平局);改为返回空 move,由 arena.parseResolve('') 判 PARSER_INVALID → 正常打回。
 */
function extractToolUse(json: unknown): { analysis: string; move: string } {
  const resp = json as { content?: ToolUseBlock[] } | null;
  if (!resp || !Array.isArray(resp.content)) return { analysis: '', move: '' };
  const block = resp.content.find((b) => b?.type === 'tool_use');
  if (!block) return { analysis: '', move: '' };
  const input = parseInput(block.input);
  const analysis = typeof input.analysis === 'string' ? input.analysis : '';
  const move = typeof input.move === 'string' ? input.move : '';
  return { analysis, move };
}

/** 读 Anthropic usage(input/output tokens)→ 我方 Usage(带成本估算)。 */
function readUsage(json: unknown, tokensPerM: TokensPerM): Usage {
  const usage = (json as { usage?: AnthropicUsage } | null)?.usage ?? {};
  const promptTokens = toNum(usage.input_tokens);
  const completionTokens = toNum(usage.output_tokens);
  return {
    promptTokens,
    completionTokens,
    costUsd: estimateCostUsd(promptTokens, completionTokens, tokensPerM),
  };
}

function httpErrorMessage(status: number, json: unknown): string {
  if (json && typeof json === 'object') {
    const err = (json as Record<string, unknown>).error;
    if (err && typeof err === 'object') {
      const message = (err as Record<string, unknown>).message;
      if (typeof message === 'string' && message) return message;
    }
  }
  return `HTTP ${status}`;
}