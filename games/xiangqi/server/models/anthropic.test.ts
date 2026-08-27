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
import { NetworkError, PlayerCancelled, type MoveContext } from '../arena';

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

  it('systemPrompt 可配:提供时完全替换模板(config.red.systemPrompt 生效链路)', async () => {
    const fn = stubFetch(toolUseResponse());
    const p = new AnthropicPlayer({
      side: 'red',
      baseUrl: 'http://x',
      apiKey: 'k',
      model: 'm',
      systemPrompt: '你是测试专用棋手,只走兵。',
    });
    await p.pickMove(fakeCtx);
    const body = requestOf(fn).body;
    expect(body.system).toContain('测试专用棋手');
    expect(body.system).not.toContain('炮:直线行走'); // 模板被整体覆盖
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

  it('B2:响应缺 tool_use → 返回空 move(不再抛 NetworkError,解析层判 PARSER_INVALID → 打回)', async () => {
    stubFetch(new Response(JSON.stringify({ content: [{ type: 'text', text: '我不会' }] }), { status: 200 }));
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm' });
    const c = await p.pickMove(fakeCtx);
    expect(c.move).toBe('');
    expect(c.analysis).toBe('');
    expect(p.lastUsage).toMatchObject({ promptTokens: 0, completionTokens: 0 }); // usage 缺失回落 0,不抛
  });

  it('B2:响应缺 content 数组 → 同样返回空 move(打回)', async () => {
    stubFetch(new Response(JSON.stringify({ stop_reason: 'end' }), { status: 200 }));
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm' });
    const c = await p.pickMove(fakeCtx);
    expect(c.move).toBe('');
  });

  it('max_tokens 默认不传:未配置 maxTokens 时请求体不含 max_tokens 字段', async () => {
    const fn = stubFetch(toolUseResponse());
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm' });
    await p.pickMove(fakeCtx);
    expect(requestOf(fn).body).not.toHaveProperty('max_tokens');
  });

  it('max_tokens 显式配置时才带上请求体', async () => {
    const fn = stubFetch(toolUseResponse());
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm', maxTokens: 8192 });
    await p.pickMove(fakeCtx);
    expect(requestOf(fn).body.max_tokens).toBe(8192);
  });

  it('B2:工具参数缺失(输入无 move 键)→ 返回空 move(打回)', async () => {
    stubFetch(
      new Response(
        JSON.stringify({ content: [{ type: 'tool_use', name: 'pick_move', input: { analysis: '只思考' } }] }),
        { status: 200 },
      ),
    );
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm' });
    const c = await p.pickMove(fakeCtx);
    expect(c.move).toBe('');
    expect(c.analysis).toBe('只思考'); // analysis 若有则照常提取
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

  it('cancelPending(pause 中止飞行请求)→ PlayerCancelled,而非超时 NetworkError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          }),
      ),
    );
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm', timeoutMs: 100000 });
    const pending = p.pickMove(fakeCtx).catch((e: unknown) => e);
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled()); // 请求已发出(controller 已挂上)

    p.cancelPending(); // arena.pause 中止:区分「暂停中止」vs「超时」
    const err = await pending;
    expect(err).toBeInstanceOf(PlayerCancelled);
    expect(err).not.toBeInstanceOf(NetworkError);
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

  it('res.text() 读响应体失败 → NetworkError(retryable=true)', async () => {
    const failBody = {
      status: 200,
      text: async (): Promise<string> => {
        throw new TypeError('socket hang up');
      },
      json: async (): Promise<unknown> => null,
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn(async () => failBody));
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm' });
    const err = await p.pickMove(fakeCtx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError & { retryable?: boolean }).retryable).toBe(true);
    expect((err as Error).message).toMatch(/读响应体失败/);
  });
});
/* ---------- G3:SSE 流式(stream:true + onThought 实时增量) ---------- */

describe('AnthropicPlayer SSE 流式(G3)', () => {
  /** 拼一段 Anthropic SSE:事件行用 \n\n 分隔。 */
  function sseEvent(json: unknown): string {
    return `event: message\ndata: ${JSON.stringify(json)}\n\n`;
  }
  function sseBody(): string {
    const toolInputJson = '{"analysis":"我思考中——","move":"h3-e3"}';
    // 关键:partial_json 成段给出,input 按分析/其余拆三段,模拟流式递增
    return [
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"analysis":"我思考' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '中——"' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: ',"move":"h3-e3"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 100, output_tokens: 20 } },
    ]
      .map(sseEvent)
      .join('');
  }

  it('流式:请求体含 stream:true;onThought 边收 analysis 增量;最终 {analysis, move} 与 usage 正确', async () => {
    const chunks: string[] = [];
    const ctx = { ...fakeCtx, onThought: (c: string) => chunks.push(c) };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(sseBody(), { status: 200, headers: { 'content-type': 'text/event-stream' } })),
    );
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm' });

    const c = await p.pickMove(ctx);

    expect(c.move).toBe('h3-e3');
    expect(c.analysis).toBe('我思考中——');
    expect(c.usage).toMatchObject({ promptTokens: 100, completionTokens: 20 });
    // 增量回调:第一段含「我思考」,第二段含「中——」
    expect(chunks.join('')).toBe('我思考中——');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // 请求带 stream:true
    const [url, init] = (vi.mocked(fetch).mock.calls[0]!) as [string, RequestInit];
    expect(url).toBe('http://x/v1/messages');
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(true);
    expect(body.tools[0].name).toBe('pick_move');
  });

  it('流式:usage 缺失时回落 0(不抛)', async () => {
    const ctx = { ...fakeCtx, onThought: () => {} };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          'event: message\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"analysis\\":\\"a\\",\\"move\\":\\"h3-e3\\"}"}}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      ),
    );
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm' });
    const c = await p.pickMove(ctx);
    expect(c.move).toBe('h3-e3');
    expect(c.usage).toEqual({ promptTokens: 0, completionTokens: 0, costUsd: 0 });
  });
});

/* ---------- 思考模式(原则 E)显式下发 ---------- */

describe('思考模式(原则 E)', () => {
  it('off:请求体显式 thinking.type=disabled 且不查 effort', async () => {
    const fn = stubFetch(toolUseResponse());
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm', thinkingMode: 'off' });
    await p.pickMove(fakeCtx);
    const b = requestOf(fn).body;
    expect(b.thinking).toEqual({ type: 'disabled' });
    expect(b.output_config).toBeUndefined();
  });

  it('缺省 thinkingMode → off(显式 disabled,绝不依赖端点缺省)', async () => {
    const fn = stubFetch(toolUseResponse());
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm' });
    await p.pickMove(fakeCtx);
    const b = requestOf(fn).body;
    expect(b.thinking).toEqual({ type: 'disabled' });
    expect(b.output_config).toBeUndefined();
  });

  it('max:thinking.type=enabled 且 output_config.effort=max(对齐 deepseek 官方强度)', async () => {
    const fn = stubFetch(toolUseResponse());
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm', thinkingMode: 'max' });
    await p.pickMove(fakeCtx);
    const b = requestOf(fn).body;
    expect(b.thinking).toEqual({ type: 'enabled' });
    expect(b.output_config).toEqual({ effort: 'max' });
  });

  it('high:thinking.type=enabled 且 output_config.effort=high(对齐 deepseek 官方强度)', async () => {
    const fn = stubFetch(toolUseResponse());
    const p = new AnthropicPlayer({ side: 'red', baseUrl: 'http://x', apiKey: 'k', model: 'm', thinkingMode: 'high' });
    await p.pickMove(fakeCtx);
    const b = requestOf(fn).body;
    expect(b.thinking).toEqual({ type: 'enabled' });
    expect(b.output_config).toEqual({ effort: 'high' });
  });
});
