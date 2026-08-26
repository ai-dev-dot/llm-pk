//
// AnthropicPlayer 适配器测试(task 16,严格 TDD)。
//
// 覆盖(brief + controller 契约):
// - tool_use 提取 → { analysis, move };usage(prompt/completion/costUsd)随 MoveChoice 返回并落 lastUsage;
// - 请求体:system 同一模板(仅红/黑、执先/执后文本差异)、user 含 asciiBoard/history/selfThoughts/rejection、
//   tool-use schema 强制 {analysis, move}、tool_choice 强制选该工具;
// - 隔离(原则 C):仅取 ctx 的己方 selfThoughts + 公共 history,绝不拼装对方 analysis / 任意多余字段;
// - 回显(原则 D):user 消息绝不包含 legalMoves 清单;
// - 网络错误:超时/传输失败/5xx → NetworkError(retryable=true);4xx(非 429) → retryable=false;
// - estimateCostUsd 纯函数与 tokensPerM 可配。
//

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicPlayer, DEFAULT_TOKENS_PER_M, estimateCostUsd } from './anthropic';
import { NetworkError, type MoveContext } from '../arena';

/* ---------- 工具 ---------- */

const fakeCtx: MoveContext = {
  side: 'red',
  asciiBoard: '    a    b    c    d    e    f    g    h    i   \n10  .  .  .  .   [將]  .  .  .  .  黑(顶)\n. . . . . . . . .',
  history: [{ move: 'h3-e3' }, { move: 'i7-i6' }],
  selfThoughts: [{ move: 'h3-e3', analysis: '瞄中路' }],
};

function toolUseResponse(partial: { move?: string; analysis?: string } = {}, usage?: unknown): Response {
  return new Response(
    JSON.stringify({
      content: [
        { type: 'text', text: '我思考一下……' },
        {
          type: 'tool_use',
          name: 'pick_move',
          input: { analysis: partial.analysis ?? '瞄中路', move: partial.move ?? 'h3-e3' },
        },
      ],
      stop_reason: 'tool_use',
      usage: usage ?? { input_tokens: 100, output_tokens: 20 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function stubFetch(body: Response) {
  const fn = vi.fn(async () => body);
  vi.stubGlobal('fetch', fn);
  return fn;
}

function requestOf(fn: ReturnType<typeof vi.fn>, index = 0): { url: string; init: RequestInit; body: any } {
  const [url, init] = fn.mock.calls[index];
  return { url, init, body: JSON.parse(init.body as string) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ---------- 用例 1(端到端,对齐 brief Step 1) ---------- */

describe('AnthropicPlayer 基本调用', () => {
  it('从 tool_use 提取 {analysis, move},usage 随 MoveChoice 返回并暴露 lastUsage', async () => {
    const fn = stubFetch(toolUseResponse());
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm' });

    const c = await p.pickMove(fakeCtx);

    expect(c).toMatchObject({ analysis: '瞄中路', move: 'h3-e3' });
    expect(c.usage).toMatchObject({ promptTokens: 100, completionTokens: 20 });
    expect(c.usage!.costUsd).toBeCloseTo(estimateCostUsd(100, 20, DEFAULT_TOKENS_PER_M), 10);
    expect(p.lastUsage).toMatchObject({ promptTokens: 100, completionTokens: 20 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('请求体:user 含 asciiBoard/history/selfThoughts,system 为同一模板且 tool_choice 强制 pick_move', async () => {
    const fn = stubFetch(toolUseResponse());
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm' });

    await p.pickMove(fakeCtx);

    const { url, init, body } = requestOf(fn);
    expect(url).toBe('http://x/v1/messages'); // base_url 末尾无 /v1 自动补
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'content-type': 'application/json', 'x-api-key': 'k' });

    // system:同一模板,红色取「红方/先行」
    expect(body.system).toContain('红方');
    expect(body.system).toContain('先行');
    expect(body.system).toContain('炮:直线行走');
    // user:棋盘 + 历史 + 己方思考
    const user = body.messages[0].content;
    expect(body.messages[0].role).toBe('user');
    expect(user).toContain(fakeCtx.asciiBoard);
    expect(user).toContain('h3-e3');
    expect(user).toContain('瞄中路');
    // tool-use schema
    expect(body.tools[0].name).toBe('pick_move');
    expect(body.tools[0].input_schema.required).toEqual(['analysis', 'move']);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'pick_move' });
  });

  it('历史含中文记谱时作为旁注随行展示', async () => {
    const fn = stubFetch(toolUseResponse());
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm' });
    await p.pickMove({
      ...fakeCtx,
      history: [{ move: 'h3-e3', notation: '炮二平五' }, { move: 'i7-i6', notation: '卒7进1' }],
    });
    const user = requestOf(fn).body.messages[0].content;
    expect(user).toContain('炮二平五');
    expect(user).toContain('卒7进1');
  });

  it('黑方仅「黑方/后行」文本差异,其余模板一致', async () => {
    const fn = stubFetch(toolUseResponse());
    const p = new AnthropicPlayer({ side: 'black', baseUrl: 'http://x', apiKey: 'k', model: 'm' });
    await p.pickMove({ ...fakeCtx, side: 'black' });
    const body = requestOf(fn).body;
    expect(body.system).toContain('黑方');
    expect(body.system).toContain('后行');
    expect(body.system).not.toContain('先行');
    expect(body.system).toContain('炮:直线行走'); // 规则部分与红方完全一致
  });

  it('rejection 携带中文讲评提示(只讲原因,不枚举走法)', async () => {
    const fn = stubFetch(toolUseResponse());
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x/api', apiKey: 'k', model: 'm' });
    await p.pickMove({ ...fakeCtx, rejection: { round: 2, reason: '马被蹩腿' } });
    const { url, body } = requestOf(fn);
    expect(url).toBe('http://x/api/v1/messages'); // base_url 以 /api 结尾时追加 /v1/messages
    const user = body.messages[0].content;
    expect(user).toContain('马被蹩腿');
    expect(user).toContain('第 2 次');
    expect(user).toContain('请换一步');
  });

  it('响应缺 tool_use → 抛非 retryable NetworkError', async () => {
    stubFetch(new Response(JSON.stringify({ content: [{ type: 'text', text: '我不会' }] }), { status: 200 }));
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm' });
    await expect(p.pickMove(fakeCtx)).rejects.toSatisfy(
      (e: unknown) => e instanceof NetworkError && e.retryable === false,
    );
  });
});

/* ---------- 用例 2:usage 采集 ---------- */

describe('usage 采集与成本估算', () => {
  it('usage 缺失时回落 0', async () => {
    // 构造一个不含 usage 键的响应(走 toolUseResponse 默认缺省会注入 usage,故手工拼)
    stubFetch(
      new Response(
        JSON.stringify({
          content: [{ type: 'tool_use', name: 'pick_move', input: { analysis: '瞄中路', move: 'h3-e3' } }],
        }),
        { status: 200 },
      ),
    );
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm' });
    const c = await p.pickMove(fakeCtx);
    expect(c.usage).toEqual({ promptTokens: 0, completionTokens: 0, costUsd: 0 });
  });

  it('estimateCostUsd 按每百万 token 单价计算(可测纯函数)', () => {
    expect(estimateCostUsd(1_000_000, 0, { input: 1, output: 20 })).toBe(1);
    expect(estimateCostUsd(0, 500_000, { input: 1, output: 2 })).toBe(1);
    expect(estimateCostUsd(1000, 2000, { input: 3, output: 15 })).toBeCloseTo(0.003 + 0.03, 10);
  });

  it('tokensPerM 可配 → costUsd 随之变化', async () => {
    stubFetch(toolUseResponse());
    const p = new AnthropicPlayer({
      side: 'red',
      baseUrl: 'http://x',
      apiKey: 'k',
      model: 'm',
      tokensPerM: { input: 2, output: 10 },
    });
    const c = await p.pickMove(fakeCtx);
    expect(c.usage!.promptTokens).toBe(100);
    expect(c.usage!.completionTokens).toBe(20);
    expect(c.usage!.costUsd).toBeCloseTo((100 * 2) / 1e6 + (20 * 10) / 1e6, 12);
  });

  it('调用成功后 lastUsage 更新;初始为 undefined', () => {
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm' });
    expect(p.lastUsage).toBeUndefined();
  });
});

/* ---------- 用例 3:隔离(原则 C)与回显(原则 D) ---------- */

describe('隔离与回显', () => {
  it('user 消息不含任何 legalMoves 清单(原则 D)', async () => {
    const fn = stubFetch(toolUseResponse());
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm' });
    const ctx = { ...fakeCtx, legalMoves: ['h3-e3', 'h4-h5'] } as MoveContext;
    await p.pickMove(ctx);
    const user = requestOf(fn).body.messages[0].content;
    expect(user).not.toContain('legalMoves');
    expect(user).not.toContain('h4-h5'); // 合法清单里的第二个走法不得出现
  });

  it('绝不自行拼装 ctx 之外的对方 analysis(原则 C)', async () => {
    const fn = stubFetch(toolUseResponse());
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm' });
    const ctx = {
      ...fakeCtx,
      // 结构上不应存在的字段;若 player 盲目拼装会把对方私享分析泄进来
      opponentAnalysis: '对方私享思考:下一步杀棋',
    } as unknown as MoveContext;
    await p.pickMove(ctx);
    const serialized = JSON.stringify(requestOf(fn).body);
    expect(serialized).not.toContain('对方私享思考');
  });

  it('仅转发己方 selfThoughts(对方历史以坐标出现在 history 属公共,不入 selfThoughts)', async () => {
    const fn = stubFetch(toolUseResponse());
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm' });
    await p.pickMove(fakeCtx);
    const user = requestOf(fn).body.messages[0].content;
    expect(user).toContain('瞄中路'); // 己方思考出现
    expect(user).not.toContain('对方'); // 无任何对方字样
  });
});

/* ---------- 用例 4:网络错误语义 ---------- */

describe('网络错误', () => {
  it('fetch 传输失败 → NetworkError(retryable=true)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm' });
    await expect(p.pickMove(fakeCtx)).rejects.toMatchObject({ name: 'NetworkError', retryable: true });
  });

  it('超时(AbortController for timeoutMs)→ NetworkError(retryable=true)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          }),
      ),
    );
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm', timeoutMs: 10 });
    const err = await p.pickMove(fakeCtx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError & { retryable?: boolean }).retryable).toBe(true);
    expect((err as Error).message).toMatch(/timeout/i);
  });

  it('5xx → NetworkError(retryable=true)', async () => {
    stubFetch(new Response('糟糕', { status: 503 }));
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm' });
    await expect(p.pickMove(fakeCtx)).rejects.toMatchObject({ name: 'NetworkError', retryable: true });
  });

  it('4xx(如 400 解析错误)→ NetworkError(retryable=false),携带错误信息', async () => {
    stubFetch(new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 }));
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm' });
    const err = await p.pickMove(fakeCtx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError & { retryable?: boolean }).retryable).toBe(false);
    expect((err as Error).message).toContain('Invalid API key');
  });

  it('429 限流 → NetworkError(retryable=true,交由 arena 指数退避)', async () => {
    stubFetch(new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 }));
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm' });
    await expect(p.pickMove(fakeCtx)).rejects.toMatchObject({ name: 'NetworkError', retryable: true });
  });
});