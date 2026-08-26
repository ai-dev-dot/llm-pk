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
//   其余 4xx(如密钥失效、schema 违例)→ `retryable=false`(arena 判 `isNetworkError` 后不再退避)。
//
// 用原生 fetch(node 18+),不引入 SDK;`baseUrl` 可指向任意 Anthropic 协议端点(`/v1/messages`)。
//

import type { MoveChoice, MoveContext, Player } from '../arena';
import { NetworkError } from '../arena';
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
  /** 单次请求超时(ms),默认 120000。超时抛 `NetworkError(retryable=true)`。 */
  timeoutMs?: number;
  /**
   * 网络重试相关——**重试策略由 arena 统一执行**(task 15),本字段为构造契约占位,
   * 供上层透传给 `ArenaConfig.networkRetryBaseDelayMs`;player 层不自行重试。
   */
  networkRetryBaseDelayMs?: number;
  /** 输出 token 预算上限,默认 1024。 */
  maxTokens?: number;
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
const DEFAULT_MAX_TOKENS = 1024;

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
  private readonly maxTokens: number;
  private readonly tokensPerM: TokensPerM;
  /** 构造契约占位(透传 arena),player 层不自行重试。 */
  public readonly networkRetryBaseDelayMs?: number;

  constructor(cfg: AnthropicPlayerConfig) {
    this.side = cfg.side;
    this.baseUrl = cfg.baseUrl;
    this.apiKey = cfg.apiKey;
    this.model = cfg.model;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTokens = cfg.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.tokensPerM = cfg.tokensPerM ?? DEFAULT_TOKENS_PER_M;
    this.networkRetryBaseDelayMs = cfg.networkRetryBaseDelayMs;
  }

  async pickMove(ctx: MoveContext): Promise<MoveChoice> {
    const started = Date.now();
    const system = buildSystemPrompt(this.side); // 同一模板,仅红/黑、执先/执后差异
    const user = buildUserPrompt(ctx);
    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
      tools: [MOVE_TOOL],
      tool_choice: { type: 'tool', name: MOVE_TOOL_NAME },
    };

    const controller = new AbortController();
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
        throw new NetworkError(`api timeout(>${this.timeoutMs}ms)`, true);
      }
      throw new NetworkError(`network error: ${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      json = null;
    }

    if (res.status < 200 || res.status >= 300) {
      throw this.httpError(res.status, json);
    }

    const { analysis, move } = extractToolUse(json);
    const usage = readUsage(json, this.tokensPerM);
    this.lastUsage = usage;
    return { analysis, move, usage, elapsedMs: Date.now() - started };
  }

  /** 非 2xx:429/5xx 可重试;其余 4xx 为确定性错误(不重试)。 */
  private httpError(status: number, json: unknown): NetworkError {
    const message = httpErrorMessage(status, json);
    const retryable = status === 429 || status >= 500;
    return new NetworkError(`${message} (HTTP ${status})`, retryable);
  }
}

/** 从响应提取 tool_use 的 {analysis, move};缺失即确定性协议错误(非重试)。 */
function extractToolUse(json: unknown): { analysis: string; move: string } {
  const resp = json as { content?: ToolUseBlock[] } | null;
  if (!resp || !Array.isArray(resp.content)) {
    throw new NetworkError('响应缺少 content 数组', false);
  }
  const block = resp.content.find((b) => b?.type === 'tool_use');
  if (!block) throw new NetworkError('响应缺少 tool_use 块(模型未按工具格式输出)', false);
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