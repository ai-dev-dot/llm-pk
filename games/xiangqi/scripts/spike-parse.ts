//
// M0 解析 spike —— 真实模型出招集 → parseMove 成功率基线。
//
// 运行(需 games/xiangqi/config.json 且 api_key 非空):
//   cd games/xiangqi && npx tsx scripts/spike-parse.ts   (或 npm run spike:parse)
//
// awaiting-key 行为:config 缺失 / api_key 为空 → 打印
//   "spike awaiting key: 请配置 games/xiangqi/config.json(…)"
//   并以 exit code 2 退出,不做任何网络调用。
//
// 产物: scripts/spike-result.json(已 gitignore)。
// 网络调用全部包在「有 key」分支内,无 key 环境 `tsc --noEmit` 同样通过。
//

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Board, Side } from '../engine/board';
import { initialBoard, opposite, sqToCode } from '../engine/board';
import type { Phase } from '../engine/judge';
import { classify } from '../engine/judge';
import { isInCheck, simulateApply } from '../engine/moves';
import { parseMove } from '../engine/notation';
import type { ParseResult } from '../engine/notation';
import { buildSystemPrompt, buildUserPrompt } from './spike-prompt';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(HERE, '..', 'config.json');
const CONFIG_EXAMPLE_PATH = resolve(HERE, '..', 'config.example.json');
const RESULT_PATH = resolve(HERE, 'spike-result.json');

const DEFAULT_STEPS = 40;
const DEFAULT_MAX_TOKENS = 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_NETWORK_RETRIES = 2;

// ---------------------------------------------------------------- config ----
interface SideModel { model: string }
interface Config {
  base_url: string;
  api_key: string;
  red: SideModel;
  black: SideModel;
  steps: number;
  max_tokens: number;
  timeout_ms: number;
}

type LoadConfigResult = { ok: true; config: Config } | { ok: false; message: string };

function readConfig(): LoadConfigResult {
  let raw: string | null = null;
  try {
    raw = readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    raw = null;
  }
  if (raw === null) {
    return { ok: false, message: `找不到 ${CONFIG_PATH}(可参照 ${CONFIG_EXAMPLE_PATH} 复制为 config.json 并填写字段)` };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, message: `${CONFIG_PATH} 不是合法 JSON` };
  }
  if (typeof data !== 'object' || data === null) {
    return { ok: false, message: `${CONFIG_PATH} 顶层应为 JSON 对象` };
  }
  const obj = data as Record<string, unknown>;
  const red = obj.red && typeof obj.red === 'object' ? (obj.red as Record<string, unknown>) : undefined;
  const black = obj.black && typeof obj.black === 'object' ? (obj.black as Record<string, unknown>) : undefined;
  const config: Config = {
    base_url: typeof obj.base_url === 'string' && obj.base_url ? obj.base_url : 'https://api.anthropic.com',
    api_key: typeof obj.api_key === 'string' ? obj.api_key : '',
    red: { model: red && typeof red.model === 'string' ? red.model : '' },
    black: { model: black && typeof black.model === 'string' ? black.model : '' },
    steps: typeof obj.steps === 'number' && Number.isFinite(obj.steps) && obj.steps > 0
      ? Math.round(obj.steps)
      : DEFAULT_STEPS,
    max_tokens: typeof obj.max_tokens === 'number' && Number.isFinite(obj.max_tokens)
      ? Math.round(obj.max_tokens)
      : DEFAULT_MAX_TOKENS,
    timeout_ms: typeof obj.timeout_ms === 'number' && Number.isFinite(obj.timeout_ms)
      ? Math.round(obj.timeout_ms)
      : REQUEST_TIMEOUT_MS,
  };
  return { ok: true, config };
}

function printAwaitingKey(): void {
  console.log(
    'spike awaiting key: 请配置 games/xiangqi/config.json(参照 config.example.json 填 base_url / api_key / red.model / black.model / steps;未配 key 时仅通过 tsc 校验、不触发任何网络调用)。',
  );
}

// ---------------------------------------------------------------- network ----
const MOVE_TOOL_NAME = 'submit_move';
const MOVE_TOOL: MoveToolSchema = {
  name: MOVE_TOOL_NAME,
  description: '提出你的走法:先写对局面的思考 analysis,再给出这一步 move(中文记谱如「炮二平五」或坐标如「h3-e3」)。',
  input_schema: {
    type: 'object',
    properties: {
      analysis: { type: 'string', description: '你对局面的思考过程' },
      move: { type: 'string', description: '这一步走法:中文记谱或坐标,如「炮二平五」/「h3-e3」' },
    },
    required: ['analysis', 'move'],
  },
};

interface MoveToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: string;
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

interface AnthropicMsgBody {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: string; content: string }>;
  tools: MoveToolSchema[];
  tool_choice: { type: string; name: string };
}

interface AnthropicContentBlock {
  type: string;
  name?: string;
  input?: unknown;
}
interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: Record<string, unknown>;
}

type CallResult =
  | {
      ok: true;
      analysis: string;
      moveText: string;
      inputTokens: number;
      outputTokens: number;
      stopReason: string;
      elapsedMs: number;
    }
  | { ok: false; error: string; elapsedMs: number };

function buildMessagesUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
}

function extractMove(json: unknown): Omit<Extract<CallResult, { ok: true }>, 'elapsedMs'> | { ok: false; error: string } {
  const resp = json as AnthropicResponse;
  if (!resp || !Array.isArray(resp.content)) return { ok: false, error: '响应缺少 content 数组' };
  const toolUse = resp.content.find((b) => b && b.type === 'tool_use');
  if (toolUse) {
    let input: unknown = toolUse.input;
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch { /* 保留原串 */ }
    }
    const rec = (input ?? {}) as Record<string, unknown>;
    const moveText = typeof rec.move === 'string' ? rec.move : '';
    const analysis = typeof rec.analysis === 'string' ? rec.analysis : '';
    if (!moveText.trim()) return { ok: false, error: 'tool_use 缺少 move 字段' };
    const usage = (resp.usage ?? {}) as Record<string, unknown>;
    const toNum = (v: unknown): number => (typeof v === 'number' ? v : 0);
    return {
      ok: true,
      analysis,
      moveText,
      inputTokens: toNum(usage.input_tokens),
      outputTokens: toNum(usage.output_tokens),
      stopReason: resp.stop_reason ?? '',
    };
  }
  return { ok: false, error: '响应缺少 tool_use 块(模型未按工具格式输出)' };
}

function httpErrorMessage(status: number, json: unknown): string {
  if (json && typeof json === 'object') {
    const err = (json as Record<string, unknown>).error;
    if (err && typeof err === 'object') {
      const em = (err as Record<string, unknown>).message;
      if (typeof em === 'string') return em;
    }
  }
  return `HTTP ${status}`;
}

async function fetchOnce(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? (JSON.parse(text) as unknown) : null; } catch { json = null; }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function callAnthropic(cfg: Config, side: Side, system: string, user: string): Promise<CallResult> {
  const url = buildMessagesUrl(cfg.base_url);
  const timeoutMs = cfg.timeout_ms;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': cfg.api_key,
  };
  const body: AnthropicMsgBody = {
    model: side === 'red' ? cfg.red.model : cfg.black.model,
    max_tokens: cfg.max_tokens,
    system,
    messages: [{ role: 'user', content: user }],
    tools: [MOVE_TOOL],
    tool_choice: { type: 'tool', name: MOVE_TOOL.name },
  };
  const begun = Date.now();
  let lastErr = '';
  for (let attempt = 0; attempt <= MAX_NETWORK_RETRIES; attempt++) {
    try {
      const { status, json } = await fetchOnce(url, headers, body, timeoutMs);
      if (status >= 200 && status < 300) {
        const extracted = extractMove(json);
        if (!extracted.ok) return { ok: false, error: extracted.error, elapsedMs: Date.now() - begun };
        return { ...extracted, elapsedMs: Date.now() - begun };
      }
      lastErr = httpErrorMessage(status, json);
      if (status < 500 && status !== 429) break; // 4xx(非 429)不重试
    } catch (err) {
      lastErr = err instanceof Error && err.name === 'AbortError'
        ? `timeout(>${timeoutMs}ms)`
        : err instanceof Error
          ? err.message
          : String(err);
    }
    if (attempt < MAX_NETWORK_RETRIES) await sleep(500 * (attempt + 1));
  }
  return { ok: false, error: lastErr, elapsedMs: Date.now() - begun };
}

// ---------------------------------------------------------------- spike ----
type StepCategory = 'ok' | 'parse' | 'network';

interface StepRecord {
  n: number;
  side: Side;
  category: StepCategory;
  rawMove: string;           // 截断 160
  reason: string | null;     // parse 失败 reason;network 失败为错误串;ok 为 null
  elapsedMs: number;
  inCheck: boolean;
  hadRejection: boolean;
  inputTokens: number;
  outputTokens: number;
}

interface MoveApplied {
  n: number;
  side: Side;
  from: string;
  to: string;
}

interface GameResult {
  ended: 'ongoing' | 'checkmate' | 'stalemate';
  atStep: number;
}

async function runSpike(cfg: Config): Promise<{ steps: StepRecord[]; moves: MoveApplied[]; game: GameResult }> {
  let board = initialBoard();
  let turn: Side = 'red';
  const history: string[] = [];
  const steps: StepRecord[] = [];
  const moves: MoveApplied[] = [];
  let rejection: { count: number; reason: string; text?: string } | undefined;
  let game: GameResult = { ended: 'ongoing', atStep: cfg.steps };

  for (let n = 1; n <= cfg.steps; n++) {
    const inCheck = isInCheck(board, turn);
    const system = buildSystemPrompt(turn);
    const user = buildUserPrompt({ side: turn, board, history, inCheck, rejection });
    const res = await callAnthropic(cfg, turn, system, user);

    if (!res.ok) {
      steps.push({
        n, side: turn, category: 'network', rawMove: '', reason: res.error,
        elapsedMs: res.elapsedMs, inCheck, hadRejection: rejection !== undefined,
        inputTokens: 0, outputTokens: 0,
      });
      rejection = rejection === undefined
        ? { count: 1, reason: res.error }
        : { count: rejection.count + 1, reason: res.error };
      console.log(`[${n}/${cfg.steps}] ${turn} 网络/协议错误: ${res.error} (${res.elapsedMs}ms)`);
      continue;
    }

    const pr: ParseResult = parseMove(res.moveText, board, turn);
    steps.push({
      n, side: turn, category: pr.ok ? 'ok' : 'parse',
      rawMove: res.moveText.slice(0, 160),
      reason: pr.ok ? null : pr.reason,
      elapsedMs: res.elapsedMs, inCheck, hadRejection: rejection !== undefined,
      inputTokens: res.inputTokens, outputTokens: res.outputTokens,
    });

    if (pr.ok) {
      const mover = turn;
      const from = sqToCode(pr.move.from);
      const to = sqToCode(pr.move.to);
      moves.push({ n, side: mover, from, to });
      history.push(`${from}-${to}`);
      board = simulateApply(board, pr.move);
      rejection = undefined;
      turn = opposite(turn);
      console.log(`[${n}/${cfg.steps}] ${mover === 'red' ? '红' : '黑'}走 ${from}-${to} 合法 (${res.elapsedMs}ms)`);
    } else {
      rejection = { count: (rejection?.count ?? 0) + 1, reason: pr.reason, text: res.moveText.slice(0, 60) };
      console.log(`[${n}/${cfg.steps}] ${turn} 走法被打回: ${pr.reason} <- 「${res.moveText.slice(0, 60)}」 (${res.elapsedMs}ms)`);
    }

    const phase: Phase = classify(board, turn);
    if (phase === 'checkmate' || phase === 'stalemate') {
      game = { ended: phase, atStep: n };
      console.log(`对局提前结束: ${phase}(第 ${n} 步)`);
      break;
    }
  }
  return { steps, moves, game };
}

// ---------------------------------------------------------------- 汇总 ----
const round1 = (x: number): number => Math.round(x * 10) / 10;

function summarize(cfg: Config, steps: StepRecord[], moves: MoveApplied[], game: GameResult) {
  const total = steps.length;
  const parsed = steps.filter((s) => s.category === 'ok').length;
  const parseFailed = steps.filter((s) => s.category === 'parse').length;
  const networkFailed = steps.filter((s) => s.category === 'network').length;

  const reasonDistribution: Record<string, number> = {};
  for (const s of steps) {
    if (s.category === 'parse' && s.reason !== null) {
      reasonDistribution[s.reason] = (reasonDistribution[s.reason] ?? 0) + 1;
    }
  }
  // 按字典序输出稳定
  const reasonSorted: Record<string, number> = {};
  for (const k of Object.keys(reasonDistribution).sort()) reasonSorted[k] = reasonDistribution[k];

  const bySideInit = (): { invocations: number; parsed: number; parseFailed: number; networkFailed: number; totalElapsedMs: number } =>
    ({ invocations: 0, parsed: 0, parseFailed: 0, networkFailed: 0, totalElapsedMs: 0 });
  const bySide: Record<'red' | 'black', ReturnType<typeof bySideInit>> = { red: bySideInit(), black: bySideInit() };
  for (const s of steps) {
    const acc = bySide[s.side];
    acc.invocations++;
    if (s.category === 'ok') acc.parsed++;
    else if (s.category === 'parse') acc.parseFailed++;
    else acc.networkFailed++;
    acc.totalElapsedMs += s.elapsedMs;
  }
  const sideSummary = (acc: ReturnType<typeof bySideInit>) => ({
    invocations: acc.invocations,
    parsed: acc.parsed,
    parseFailed: acc.parseFailed,
    networkFailed: acc.networkFailed,
    avgElapsedMs: acc.invocations ? round1(acc.totalElapsedMs / acc.invocations) : 0,
  });

  const totalElapsed = steps.reduce((a, s) => a + s.elapsedMs, 0);

  return {
    schema: 'xiangqi-spike-parse-v1',
    generatedAt: new Date().toISOString(),
    config: { base_url: cfg.base_url, red: cfg.red, black: cfg.black, steps: cfg.steps },
    game,
    summary: {
      invocations: total,
      parsed,
      parseFailed,
      networkFailed,
      parseRate: total ? round1(parsed / total) : 0,
      avgElapsedMs: total ? round1(totalElapsed / total) : 0,
      reasonDistribution: reasonSorted,
      bySide: { red: sideSummary(bySide.red), black: sideSummary(bySide.black) },
    },
    movesApplied: moves,
    steps: steps.map((s) => ({
      n: s.n, side: s.side, category: s.category, rawMove: s.rawMove, reason: s.reason,
      elapsedMs: s.elapsedMs, inCheck: s.inCheck, hadRejection: s.hadRejection,
      inputTokens: s.inputTokens, outputTokens: s.outputTokens,
    })),
  };
}

// ---------------------------------------------------------------- main ----
async function main(): Promise<void> {
  const loaded = readConfig();
  if (!loaded.ok) {
    printAwaitingKey();
    console.error(`  -> ${loaded.message}`);
    process.exit(2);
  }
  const cfg = loaded.config;
  if (!cfg.api_key) {
    printAwaitingKey();
    console.error(`  -> ${CONFIG_PATH} 已存在但 api_key 为空;填入真实 key 后再运行真实模型调用`);
    process.exit(2);
  }
  if (!cfg.red.model || !cfg.black.model) {
    printAwaitingKey();
    console.error(`  -> ${CONFIG_PATH} 缺少 red.model / black.model`);
    process.exit(2);
  }

  console.log(`开始 spike: ${cfg.red.model}(红) vs ${cfg.black.model}(黑), 上限 ${cfg.steps} 次模型调用`);
  const { steps, moves, game } = await runSpike(cfg);
  const result = summarize(cfg, steps, moves, game);
  writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2) + '\n', 'utf8');

  const s = result.summary;
  console.log('');
  console.log(`spike 完成: ${s.invocations} 次调用, 解析成功 ${s.parsed} (${(s.parseRate * 100).toFixed(1)}%),`);
  console.log(`  parse 打回 ${s.parseFailed} 次, 网络/协议错误 ${s.networkFailed} 次, 平均耗时 ${s.avgElapsedMs}ms`);
  if (Object.keys(s.reasonDistribution).length > 0) {
    console.log('  reason 分布:', JSON.stringify(s.reasonDistribution));
  }
  console.log(`结果已写入: ${RESULT_PATH}`);
}

main().catch((err) => {
  console.error('spike 异常终止:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});