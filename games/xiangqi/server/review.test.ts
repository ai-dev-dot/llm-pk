//
// Task 21 —— 赛后复盘服务(review.ts)测试(严格 TDD)。
//
// 契约(controller):
// - `reviewGame(events | logPath, ctx) → { kind:'ok'; review } | { kind:'degraded' }`;
// - 独立进程/独立凭据:复盘用自己的 client(baseUrl/apiKey/model),绝不借红/黑方 key;
//   未配 key → 直接 degraded,且绝不发起网络调用;
// - 只读公共日志:输入整局 GameEvent[];任何失败(500/超时/未配/无终局/坏响应)→ degraded,
//   绝不影响调用方事件流(本模块只读输入、不写任何事件);
// - 正常路径(注入 client 与默认 fetch client 双路)返回结构化 ReviewPayload。
//

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { reviewGame, type ReviewClient, type ReviewContext, type ReviewPayload } from './review';
import type { GameEvent } from './game-log';
import { appendEvent } from './game-log';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'review-test-'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

/* ---------- 夹具 ---------- */

/** 构造一段含有终局的小型对局事件(公共字段齐全,与真实日志 shape 一致)。 */
function sampleEvents(): GameEvent[] {
  return [
    {
      seq: 1,
      ts: '2026-08-26T00:00:00.000Z',
      type: 'begin',
      gameId: 'g-rev',
      red: { model: 'm-red' },
      black: { model: 'm-black' },
      rules: { drawRepeat: 3, illegalAttemptsLimit: 3, maxTotalMoves: 20, networkRetries: 3, timeoutMs: 120000, carrySelfAnalysisN: 6, contextBudgetTokens: 32000 },
    },
    {
      seq: 2,
      ts: '2026-08-26T00:00:00.010Z',
      type: 'move',
      turn: 'red',
      move: { from: 'h3', to: 'e3', notation: '炮二平五' },
      analysis: '架中炮控制中路……',
      legal: true,
    },
    {
      seq: 3,
      ts: '2026-08-26T00:00:00.020Z',
      type: 'move',
      turn: 'black',
      move: { from: 'b7', to: 'e7', notation: '马8进7' },
      analysis: '跳马护中路……',
      legal: true,
    },
    {
      seq: 4,
      ts: '2026-08-26T00:00:00.030Z',
      type: 'illegal-attempt',
      side: 'black',
      round: 1,
      reason: '马被蹩腿',
      violations: { pre: 1, post: 0 },
    },
    {
      seq: 5,
      ts: '2026-08-26T00:00:00.040Z',
      type: 'check',
      side: 'black',
    },
    {
      seq: 6,
      ts: '2026-08-26T00:00:00.050Z',
      type: 'finish',
      winner: 'red',
      reason: 'checkmate',
      ruleViolations: { red: { pre: 0, post: 0 }, black: { pre: 1, post: 2 } },
    },
  ];
}

function makeCtx(over: Partial<ReviewContext> = {}): ReviewContext {
  return {
    baseUrl: 'http://localhost:1',
    apiKey: 'sk-review',
    model: 'cm-review',
    ...over,
  };
}

function okClient(payload: ReviewPayload): ReviewClient {
  return { async generate() { return { payload }; } };
}

function failClient(err: Error): ReviewClient {
  return { async generate() { throw err; } };
}

/** 把事件数组写为 JSONL 日志文件,返回路径。 */
async function writeLog(events: GameEvent[], name = 'g.jsonl'): Promise<string> {
  const file = join(dir, name);
  const sink = createWriteStream(file, { flags: 'a' });
  for (const e of events) appendEvent(sink, e);
  sink.end();
  await finished(sink);
  return file;
}

const expectUntouched = (ev: GameEvent[], original: GameEvent[]) => {
  // degraded 不得改动输入事件数组(只读公共日志契约)
  expect(ev).toEqual(original);
};

/* ---------- 正常路径(注入 client) ---------- */

describe('reviewGame 正常路径', () => {
  it('注入 client:返回 ok 与结构化 ReviewPayload(summary/highlights/mistakes)', async () => {
    const payload: ReviewPayload = {
      summary: '红方中局弃马抢攻,最终成杀',
      highlights: ['红方中炮牵制', '黑方左马失位'],
      mistakes: [
        { side: 'black', move: 'e7', note: '第 4 回合跳马被蹩腿,应改走车' },
        { side: 'black', note: '中局兑子后左翼空虚' },
      ],
    };
    const ctx = makeCtx({ client: okClient(payload) });
    const result = await reviewGame(sampleEvents(), ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.review.summary).toBe(payload.summary);
    expect(result.review.highlights).toEqual(payload.highlights);
    expect(result.review.mistakes).toEqual(payload.mistakes);
  });

  it('logPath 输入:读文件事件,返回 ok', async () => {
    const payload: ReviewPayload = { summary: 's', highlights: [], mistakes: [] };
    const file = await writeLog(sampleEvents());
    const result = await reviewGame(file, makeCtx({ client: okClient(payload) }));
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.review.summary).toBe('s');
  });

  it('empty highlights/mistakes 合法(可裁剪);ok 附带 model 与 elapsedMs', async () => {
    const payload: ReviewPayload = { summary: '平淡对局', highlights: [], mistakes: [] };
    const result = await reviewGame(sampleEvents(), makeCtx({ client: okClient(payload) }));
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.review.summary).toBe('平淡对局');
    expect(result.review.highlights).toEqual([]);
    expect(result.review.mistakes).toEqual([]);
    expect(result.review.model).toBe('cm-review');
    expect(typeof result.review.elapsedMs).toBe('number');
  });
});

/* ---------- 降级路径:未配 key / 网络失败 / 无终局 ---------- */

describe('reviewGame 降级路径(kind: degraded)', () => {
  it('未配 review apiKey → degraded,且绝不调用 client(独立凭据契约)', async () => {
    const called: string[] = [];
    const ctx = makeCtx({
      apiKey: '',
      client: { async generate() { called.push('x'); throw new Error('不应调用'); } },
    });
    const result = await reviewGame(sampleEvents(), ctx);
    expect(result).toEqual({ kind: 'degraded' });
    expect(called).toEqual([]);
  });

  it('未配 baseUrl/model → degraded', async () => {
    expect(await reviewGame(sampleEvents(), makeCtx({ baseUrl: '' }))).toEqual({ kind: 'degraded' });
    expect(await reviewGame(sampleEvents(), makeCtx({ model: '' }))).toEqual({ kind: 'degraded' });
  });

  it('HTTP 500(网络失败)→ degraded;输入事件数组不变', async () => {
    const events = sampleEvents();
    const result = await reviewGame(events, makeCtx({ client: failClient(new Error('HTTP 500')) }));
    expect(result).toEqual({ kind: 'degraded' });
    expectUntouched(events, sampleEvents());
  });

  it('超时 → degraded;输入事件数组不变', async () => {
    const events = sampleEvents();
    const timeout = Object.assign(new Error('timeout'), { name: 'AbortError' });
    const result = await reviewGame(events, makeCtx({ client: failClient(timeout) }));
    expect(result).toEqual({ kind: 'degraded' });
    expectUntouched(events, sampleEvents());
  });

  it('事件缺 finish(对局未完)→ degraded,不发起调用', async () => {
    const noFinish = sampleEvents().filter((e) => e.type !== 'finish');
    const called: string[] = [];
    const ctx = makeCtx({ client: { async generate() { called.push('x'); throw new Error('不应调用'); } } });
    const result = await reviewGame(noFinish, ctx);
    expect(result).toEqual({ kind: 'degraded' });
    expect(called).toEqual([]);
  });
});

/* ---------- 默认 client(真实 fetch)路径 ---------- */

describe('reviewGame 默认 client(原生 fetch)', () => {
  const textBlock = (text: string) => ({ type: 'text', text });
  const respOf = (text: string, status = 200) =>
    new Response(JSON.stringify({ content: [textBlock(text)], usage: { input_tokens: 100, output_tokens: 40 } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('fetch 200 + 合法 JSON 文本 → ok(带 usage/elapsedMs/model)', async () => {
    const body = JSON.stringify({ summary: '红胜', highlights: ['a'], mistakes: [{ side: 'black', move: 'e7', note: 'n' }] });
    const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    vi.stubGlobal('fetch', async (url: unknown, init: Record<string, unknown>) => {
      seen.push({ url: String(url), headers: init.headers as Record<string, string>, body: String(init.body) });
      return respOf(body);
    });
    const ctx = makeCtx({ apiKey: 'sk-review-x' });
    const result = await reviewGame(sampleEvents(), ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.review.summary).toBe('红胜');
    expect(result.review.highlights).toEqual(['a']);
    expect(result.review.mistakes).toEqual([{ side: 'black', move: 'e7', note: 'n' }]);
    // 独立凭据:用自己的 key 请求,绝不混入红/黑某方 key
    expect(seen.length).toBe(1);
    expect(seen[0]!.url).toContain('/v1/messages');
    const headers = seen[0]!.headers;
    expect(headers['x-api-key']).toBe('sk-review-x');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    // 请求体包含 digest(公共 move.record + 记谱信息),不含任何 apiKey
    expect(String(seen[0]!.body)).toContain('炮二平五');
    expect(String(seen[0]!.body)).not.toContain('sk-review-x');
  });

  it('fetch 500 → degraded', async () => {
    vi.stubGlobal('fetch', async () => respOf('{"error":{"message":"boom"}}', 500));
    const result = await reviewGame(sampleEvents(), makeCtx());
    expect(result).toEqual({ kind: 'degraded' });
  });

  it('fetch 超时(AbortController abort)→ degraded', async () => {
    vi.stubGlobal('fetch', async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const result = await reviewGame(sampleEvents(), makeCtx({ timeoutMs: 1 }));
    expect(result).toEqual({ kind: 'degraded' });
  });

  it('fetch 网络错误(如 ECONNREFUSED)→ degraded', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:1');
    });
    const result = await reviewGame(sampleEvents(), makeCtx());
    expect(result).toEqual({ kind: 'degraded' });
  });

  it('响应缺 text 块(模型未按格式输出)→ degraded', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ content: [] }), { status: 200 }));
    const result = await reviewGame(sampleEvents(), makeCtx());
    expect(result).toEqual({ kind: 'degraded' });
  });

  it('文本不是合法 JSON / 缺 summary / 非法 side → degraded', async () => {
    const badBodies = [
      '这不是 JSON',
      JSON.stringify({ highlights: [] }),
      JSON.stringify({ summary: 's', highlights: [], mistakes: [{ side: 'blue', note: 'x' }] }),
    ];
    for (const bad of badBodies) {
      vi.stubGlobal('fetch', async () => respOf(bad));
      const result = await reviewGame(sampleEvents(), makeCtx());
      expect(result).toEqual({ kind: 'degraded' });
      vi.unstubAllGlobals();
    }
  });
});