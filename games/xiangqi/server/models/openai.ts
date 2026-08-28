//
// OpenAI 协议棋手适配器(chat/completions 原生端点,2026-08-28 GLM-5.3 系列定案引入)。
//
// 与 AnthropicPlayer 同契约(Player 接口,arena 零改),协议差异点:
// - URL 形如 `{base}/chat/completions`(`base` 为 OpenAI 兼容 API 根,如
//   `https://open.bigmodel.cn/api/paas/v4`);认证头 `Authorization: Bearer <key>`;
// - 工具:OpenAI `tools:[{type:'function',function:{name,description,parameters}}]`;
//   强制出招用 `tool_choice:{type:'function',function:{name:'pick_move'}}`;
//   响应 `choices[0].message.tool_calls[0].function.arguments` 为字符串 JSON → {analysis,move};
// - 截断/弃用:`finish_reason` `length`(截断)与 `stop`(主动结束未出招)带提示重发(G3c),
//   其余与 Anthropic 语义一致:usage.prompt_tokens/completion_tokens、429/5xx→retryable。
// - 思考字段(config `models.<name>.thinking`)按 OpenAI 原生形态透传,如 GLM 官方:
//   `{ thinking:{type:'enabled'}, reasoning_effort:'max' }` —— 原生端点真正生效。
//
// 提示词(principle B):与 AnthropicPlayer 共用同一 buildUserPrompt / buildSystemPrompt,
// 同一工具名与 {analysis, move} schema;隔离/回显/红线不变。
//

import type { MoveChoice, MoveContext, Player } from '../arena';
import { NetworkError, PlayerCancelled } from '../arena';
import type { Usage } from '../game-log';
import type { DebugLogSink } from '../debug-log';
import { rawBodyForDebug } from '../debug-log';
import type { Side } from '../../engine/types';
import { buildSystemPrompt } from '../../scripts/spike-prompt';
import {
  buildUserPrompt,
  DEFAULT_TOKENS_PER_M,
  estimateCostUsd,
  MAX_TRUNCATE_RETRY,
  TRUNCATED_HINT,
  type TokensPerM,
} from './anthropic';

const MOVE_TOOL_NAME = 'pick_move';
const DEFAULT_TIMEOUT_MS = 120_000;

/** OpenAI 工具声明:function.parameters(OpenAI 风格,非 Anthropic 的 input_schema)。 */
const MOVE_TOOL = {
  type: 'function',
  function: {
    name: MOVE_TOOL_NAME,
    description:
      '提出你的走法:先写对局面的思考 analysis,再给出这一步 move(中文记谱如「炮二平五」或坐标如「h3-e3」)。',
    parameters: {
      type: 'object',
      properties: {
        analysis: { type: 'string', description: '你对局面的思考过程' },
        move: { type: 'string', description: '这一步走法:中文记谱或坐标,如「炮二平五」/「h3-e3」' },
      },
      required: ['analysis', 'move'],
    },
  },
} as const;

export interface OpenAIPlayerConfig {
  side: Side;
  /** OpenAI 兼容 API 根(自带协议版本,如 `…/api/paas/v4`);实际请求 `{base}/chat/completions`。 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 自定义 system 提示(可选);缺省共用 buildSystemPrompt(side)。 */
  systemPrompt?: string;
  timeoutMs?: number;
  /** 输出 token 预算(默认不传,交端点默认)。 */
  maxTokens?: number;
  tokensPerM?: TokensPerM;
  /** 思考字段透传片段(config `models.<name>.thinking`),整段展开进请求体顶层。 */
  thinking?: Record<string, unknown>;
  debugLog?: DebugLogSink;
  /** 构造契约占位(透传 arena),本层不自行重试。 */
  networkRetryBaseDelayMs?: number;
}

/** chat/completions 响应解析结果。 */
interface ChatParsed {
  analysis: string;
  move: string;
  usage: Usage;
  /** `length`(截断) | `stop`(未出招即结束) | `tool_calls`(正常) | undefined。 */
  finishReason?: string;
}

function toNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function chatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

/**
 * OpenAI 响应解析:取 choices[0].message.tool_calls[0].function.arguments。
 * B2:缺 tool_calls / arguments 非须解析 JSON / 坏结构 → 空 move(交 arena 打回,不抛 NetworkError)。
 */
function parseChat(text: string, tokensPerM: TokensPerM): ChatParsed {
  let json: unknown = null;
  try {
    json = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    json = null;
  }
  const resp = json as { choices?: unknown; usage?: unknown } | null;
  const choice = Array.isArray(resp?.choices) ? (resp.choices[0] as Record<string, unknown>) : undefined;
  const msg = (choice?.message ?? {}) as Record<string, unknown>;
  const fc = (Array.isArray(msg.tool_calls) ? (msg.tool_calls[0] as Record<string, unknown>) : undefined)?.function as
    | Record<string, unknown>
    | undefined;
  let analysis = '';
  let move = '';
  if (fc && typeof fc.arguments === 'string') {
    try {
      const args = JSON.parse(fc.arguments) as Record<string, unknown>;
      analysis = typeof args.analysis === 'string' ? args.analysis : '';
      move = typeof args.move === 'string' ? args.move : '';
    } catch {
      /* arguments 非 JSON → 空 move,走打回 */
    }
  }
  const usage = (resp?.usage ?? {}) as Record<string, unknown>;
  const promptTokens = toNum(usage.prompt_tokens);
  const completionTokens = toNum(usage.completion_tokens);
  const finishReason = typeof choice?.finish_reason === 'string' ? (choice.finish_reason as string) : undefined;
  return {
    analysis,
    move,
    usage: { promptTokens, completionTokens, costUsd: estimateCostUsd(promptTokens, completionTokens, tokensPerM) },
    finishReason,
  } as ChatParsed;
}

/**
 * OpenAI 协议棋手 —— 与 AnthropicPlayer 行为对齐(网络重试交 arena、pause 中止、打回语义)。
 * 不支持流式(SSE)路径:GLM/OpenAI 原生非流式即遵守 max_tokens,需实时思考再另行扩展。
 */
export class OpenAIPlayer implements Player {
  public readonly side: Side;
  public readonly model: string;
  /** 最近一次成功调用 usage;失败不更新。 */
  public lastUsage?: Usage;
  /** 构造契约占位。 */
  public readonly networkRetryBaseDelayMs?: number;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxTokens?: number;
  private readonly tokensPerM: TokensPerM;
  private readonly systemPrompt?: string;
  private readonly thinking?: Record<string, unknown>;
  private readonly debugLog?: DebugLogSink;
  private ctl: AbortController | null = null;
  private cancelled = false;

  constructor(cfg: OpenAIPlayerConfig) {
    this.side = cfg.side;
    this.baseUrl = cfg.baseUrl;
    this.apiKey = cfg.apiKey;
    this.model = cfg.model;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTokens = cfg.maxTokens;
    this.tokensPerM = cfg.tokensPerM ?? DEFAULT_TOKENS_PER_M;
    this.systemPrompt = cfg.systemPrompt;
    this.thinking = cfg.thinking;
    this.debugLog = cfg.debugLog;
    this.networkRetryBaseDelayMs = cfg.networkRetryBaseDelayMs;
  }

  cancelPending(): void {
    this.cancelled = true;
    this.ctl?.abort();
  }

  async pickMove(ctx: MoveContext): Promise<MoveChoice> {
    this.cancelled = false;
    const started = Date.now();
    const system = this.systemPrompt ?? buildSystemPrompt(this.side);
    const baseUser = buildUserPrompt(ctx);
    // G3c:length(截断)/stop(主动结束未出招)且无 move → 带提示重发,最多 MAX_TRUNCATE_RETRY 次。
    for (let attempt = 0; ; attempt++) {
      const user = attempt === 0 ? baseUser : `${baseUser}\n\n${TRUNCATED_HINT}`;
      const parsed = await this.callOnce(system, user, attempt);
      if (parsed.usage) this.lastUsage = parsed.usage;
      const missingMove = parsed.move === '';
      const retryNoTool =
        missingMove && (parsed.finishReason === 'length' || parsed.finishReason === 'stop');
      if (!retryNoTool || attempt >= MAX_TRUNCATE_RETRY) {
        return {
          analysis: parsed.analysis,
          move: parsed.move,
          usage: parsed.usage,
          elapsedMs: Date.now() - started,
        };
      }
    }
  }

  private writeError(attempt: number, name: string, message: string, retryable: boolean): void {
    this.debugLog?.write({
      kind: 'player-error',
      protocol: 'openai',
      ts: new Date().toISOString(),
      attempt,
      error: { name, message, retryable },
    });
  }

  private async callOnce(system: string, user: string, attempt: number): Promise<ChatParsed> {
    const body = {
      model: this.model,
      ...(this.maxTokens ? { max_tokens: this.maxTokens } : {}),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      tools: [MOVE_TOOL],
      tool_choice: { type: 'function', function: { name: MOVE_TOOL_NAME } },
      ...(this.thinking ?? {}),
    };
    const url = chatUrl(this.baseUrl);
    const reqStart = Date.now();
    const ts = (): string => new Date().toISOString();
    this.debugLog?.write({ kind: 'player-request', protocol: 'openai', ts: ts(), attempt, url, body });

    const controller = new AbortController();
    this.ctl = controller;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof NetworkError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        if (this.cancelled) throw new PlayerCancelled('回合被暂停中止');
        this.writeError(attempt, 'api-timeout', `api timeout(>${this.timeoutMs}ms)`, true);
        throw new NetworkError(`api timeout(>${this.timeoutMs}ms)`, true, 'request-timeout');
      }
      this.writeError(attempt, 'network', `network error: ${err instanceof Error ? err.message : String(err)}`, true);
      throw new NetworkError(`network error: ${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      this.ctl = null;
    }

    if (res.status < 200 || res.status >= 300) {
      clearTimeout(timer);
      const text = await consumeTextSafe(res);
      const json = parseJson(text);
      const retryable = res.status === 429 || res.status >= 500;
      this.debugLog?.write({
        kind: 'player-response',
        protocol: 'openai',
        ts: ts(),
        attempt,
        status: res.status,
        ok: false,
        rawText: rawBodyForDebug(text),
        error: { message: chatErrorText(res.status, json), retryable },
      });
      throw new NetworkError(`${chatErrorText(res.status, json)} (HTTP ${res.status})`, retryable);
    }

    let parsed: ChatParsed;
    let text: string;
    try {
      text = await consumeTextSafe(res);
      parsed = parseChat(text, this.tokensPerM);
    } catch (err) {
      if (err instanceof NetworkError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        if (this.cancelled) throw new PlayerCancelled('回合被暂停中止');
        this.writeError(attempt, 'api-timeout', `api timeout(>${this.timeoutMs}ms)`, true);
        throw new NetworkError(`api timeout(>${this.timeoutMs}ms)`, true, 'request-timeout');
      }
      this.writeError(attempt, 'read-body', `读响应体失败: ${err instanceof Error ? err.message : String(err)}`, true);
      throw new NetworkError(`读响应体失败: ${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      clearTimeout(timer);
      this.ctl = null;
    }
    this.debugLog?.write({
      kind: 'player-response',
      protocol: 'openai',
      ts: ts(),
      attempt,
      status: res.status,
      ok: true,
      rawText: rawBodyForDebug(text),
      extracted: { analysis: parsed.analysis, move: parsed.move, finishReason: parsed.finishReason, usage: parsed.usage },
      elapsedMs: Date.now() - reqStart,
    });
    return parsed;
  }
}

function parseJson(text: string): unknown {
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}

async function consumeTextSafe(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    throw new NetworkError(`读响应体失败: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

function chatErrorText(status: number, json: unknown): string {
  if (json && typeof json === 'object') {
    const err = (json as Record<string, unknown>).error;
    if (err && typeof err === 'object') {
      const message = (err as Record<string, unknown>).message;
      if (typeof message === 'string' && message) return message;
    }
  }
  return `HTTP ${status}`;
}