//
// OpenAI 协议棋手适配器测试(严格 TDD)。
//
// 覆盖(与 AnthropicPlayer 契约对齐 + 协议差异):
// - tool_calls.function.arguments → {analysis, move};Bearer 认证;URL {base}/chat/completions;
//   messages system+user;tools function.parameters;tool_choice 函数锁定向;usage 落 MoveChoice/lastUsage;
// - 思考字段片段(如 GLM 原生 `reasoning_effort`)透传;max_tokens 缺省省略;
// - B2:缺 tool_calls / arguments 非 JSON → 空 move(打回,不抛 NetworkError);
// - G3c:finish_reason=length|stop 且无 move → 带提示重发,上限 MAX_TRUNCATE_RETRY;
// - 网络:超时/传输失败/5xx → retryable;4xx(非429)→ 不重试;pause 中止 → PlayerCancelled;
// - 隔离/回显(原则 C/D):user 消息仅棋盘+公共历史+己方思考,无 legalMoves。
//

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIPlayer } from './openai';
import { NetworkError, PlayerCancelled, type MoveContext } from '../arena';

const fakeCtx: MoveContext = {
  side: 'red',
  asciiBoard: '    a    b    c    d    e    f    g    h    i   \n10  .  .  .  .   [將]  .  .  .  .  黑(顶)',
  history: [{ move: 'h3-e3' }, { move: 'i7-i6' }],
  selfThoughts: [{ move: 'h3-e3', analysis: '瞄中路' }],
};

function chatResp(opts: {
  move?: string;
  analysis?: string;
  finish?: string;
  usage?: Record<string, number>;
} = {}): Response {
  const { move = 'h3-e3', analysis = '瞄中路', finish = 'tool_calls', usage = { prompt_tokens: 100, completion_tokens: 20 } } = opts;
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'pick_move', arguments: JSON.stringify({ analysis, move }) } }],
          },
          finish_reason: finish,
        },
      ],
      usage,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function noToolResp(finish = 'stop'): Response {
  return new Response(
    JSON.stringify({
      id: 'x',
      choices: [{ index: 0, message: { role: 'assistant', content: '我不会' }, finish_reason: finish }],
      usage: { prompt_tokens: 5, output_tokens: 3 },
    }),
    { status: 200 },
  );
}

function stubFetch(body: Response | (() => Response | Promise<Response>)): ReturnType<typeof vi.fn> {
  const fn = vi.fn(typeof body === 'function' ? body : (async () => body) as () => Promise<Response>);
  vi.stubGlobal('fetch', fn);
  return fn;
}

function requestOf(fn: ReturnType<typeof vi.fn>, index = 0): { url: string; init: RequestInit; body: any } {
  const [url, init] = fn.mock.calls[index];
  return { url, init, body: JSON.parse(init.body as string) };
}

function mkPlayer(over: Partial<import('./openai').OpenAIPlayerConfig> = {}) {
  return new OpenAIPlayer({ side: 'red', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-abc', model: 'm', ...over });
}

afterEach(() => vi.unstubAllGlobals());

describe('OpenAIPlayer 基本调用', () => {
  it('tool_calls 提取 {analysis,move};Bearer 认证;URL /chat/completions;usage 返回并落 lastUsage', async () => {
    const fn = stubFetch(chatResp());
    const p = mkPlayer();

    const c = await p.pickMove(fakeCtx);

    expect(c).toMatchObject({ analysis: '瞄中路', move: 'h3-e3' });
    expect(c.usage).toMatchObject({ promptTokens: 100, completionTokens: 20 });
    expect(p.lastUsage).toMatchObject({ promptTokens: 100, completionTokens: 20 });
    const { url, init, body } = requestOf(fn);
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(init.headers).toMatchObject({ 'content-type': 'application/json', authorization: 'Bearer sk-abc' });
    // messages:system + user(棋盘/历史/自省)
    expect(body.messages.map((m: any) => m.role)).toEqual(['system', 'user']);
    expect(body.messages[1].content).toContain(fakeCtx.asciiBoard);
    expect(body.messages[1].content).toContain('h3-e3');
    expect(body.messages[1].content).toContain('瞄中路');
    // 工具与强制出招
    expect(body.tools[0].type).toBe('function');
    expect(body.tools[0].function.name).toBe('pick_move');
    expect(body.tools[0].function.parameters.required).toEqual(['analysis', 'move']);
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'pick_move' } });
  });

  it('thinking 片段透传(GLM 原生形态:thinking + reasoning_effort)', async () => {
    const fn = stubFetch(chatResp());
    const p = mkPlayer({ thinking: { thinking: { type: 'enabled' }, reasoning_effort: 'max' } });
    await p.pickMove(fakeCtx);
    const body = requestOf(fn).body;
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('max');
  });

  it('max_tokens 默认省略;显式配置才带上', async () => {
    const fn = stubFetch(chatResp());
    await (await mkPlayer()).pickMove(fakeCtx);
    expect(requestOf(fn).body).not.toHaveProperty('max_tokens');

    const fn2 = stubFetch(chatResp());
    await mkPlayer({ maxTokens: 8192 }).pickMove(fakeCtx);
    expect(requestOf(fn2).body.max_tokens).toBe(8192);
  });

  it('B2:响应缺 tool_calls → 空 move(打回,不抛网络错);finish 非 length/stop 不触发 G3c 重发', async () => {
    // finish_reason=content_filter:无 tool_calls 且不属于截断/弃用 → 单次请求即返回空 move
    stubFetch(noToolResp('content_filter'));
    const c = await mkPlayer().pickMove(fakeCtx);
    expect(c.move).toBe('');
    expect(c.analysis).toBe('');
  });

  it('B2:tool_calls 存在但 arguments 非合法 JSON → 空 move', async () => {
    const bad = new Response(
      JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', tool_calls: [{ function: { name: 'pick_move', arguments: '{{{' } }] }, finish_reason: 'tool_calls' }],
      }),
      { status: 200 },
    );
    stubFetch(bad);
    const c = await mkPlayer().pickMove(fakeCtx);
    expect(c.move).toBe('');
  });

  it('G3c:finish_reason=stop 且无 tool_calls → 带提示重发;第二次正常返回', async () => {
    const seq = vi
      .fn()
      .mockResolvedValueOnce(noToolResp('stop'))
      .mockResolvedValueOnce(chatResp());
    vi.stubGlobal('fetch', seq);
    const c = await mkPlayer().pickMove(fakeCtx);
    expect(c.move).toBe('h3-e3');
    expect(seq).toHaveBeenCalledTimes(2);
    const body2 = requestOf(seq, 1).body;
    expect(body2.messages[1].content).toContain('请务必仍然调用 pick_move'); // hint 追加
  });

  it('G3c:finish_reason=length(截断)同样触发重发', async () => {
    const seq = vi.fn().mockResolvedValueOnce(noToolResp('length')).mockResolvedValueOnce(chatResp());
    vi.stubGlobal('fetch', seq);
    const c = await mkPlayer().pickMove(fakeCtx);
    expect(c.move).toBe('h3-e3');
    expect(seq).toHaveBeenCalledTimes(2);
  });

  it('G3c:重发耗尽仍无 move → 返回空 move(交 arena 打回,尝试 = 原始+MAX 次)', async () => {
    const seq = vi.fn(async () => noToolResp('length')); // 工厂:每次 new Response,避免同一 body 二次读
    vi.stubGlobal('fetch', seq);
    const c = await mkPlayer().pickMove(fakeCtx);
    expect(c.move).toBe('');
    expect(seq).toHaveBeenCalledTimes(3); // 1 + MAX_TRUNCATE_RETRY(2)
  });
});

describe('OpenAIPlayer 网络错误', () => {
  it('fetch 传输失败 → NetworkError(retryable=true)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(mkPlayer().pickMove(fakeCtx)).rejects.toMatchObject({ name: 'NetworkError', retryable: true });
  });

  it('超时(AbortController) → NetworkError(retryable=true)', async () => {
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_, rej) => {
      init.signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')));
    })));
    const err = await mkPlayer({ timeoutMs: 10 }).pickMove(fakeCtx).catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).retryable).toBe(true);
    expect((err as Error).message).toMatch(/timeout/i);
  });

  it('cancelPending(pause) → PlayerCancelled,而非超时', async () => {
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_, rej) => {
      init.signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')));
    })));
    const p = mkPlayer({ timeoutMs: 100000 });
    const pending = p.pickMove(fakeCtx).catch((e) => e);
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    p.cancelPending();
    const err = await pending;
    expect(err).toBeInstanceOf(PlayerCancelled);
  });

  it('5xx → NetworkError(retryable=true);4xx(非429) → retryable=false 且携带错误信息', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })));
    await expect(mkPlayer().pickMove(fakeCtx)).rejects.toMatchObject({ name: 'NetworkError', retryable: true });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Invalid key' } }), { status: 401 })));
    const err = await mkPlayer().pickMove(fakeCtx).catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).retryable).toBe(false);
    expect((err as Error).message).toContain('Invalid key');
  });

  it('429 → retryable=true', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rl', { status: 429 })));
    await expect(mkPlayer().pickMove(fakeCtx)).rejects.toMatchObject({ name: 'NetworkError', retryable: true });
  });
});

describe('OpenAIPlayer 调试日志(debugLog)', () => {
  function memSink(): { entries: Array<Record<string, unknown>>; sink: { write(e: Record<string, unknown>): void } } {
    const entries: Array<Record<string, unknown>> = [];
    return { entries, sink: { write: (e) => entries.push(e) } };
  }

  it('成功:player-request/response 带 protocol=openai 与完整原文', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => chatResp()));
    const { entries, sink } = memSink();
    await mkPlayer({ debugLog: sink }).pickMove(fakeCtx);

    expect(entries.length).toBe(2);
    expect(entries[0]).toMatchObject({ kind: 'player-request', protocol: 'openai', attempt: 0 });
    expect((entries[0]['body'] as Record<string, unknown>)['messages']).toBeDefined();
    expect(entries[1]).toMatchObject({ kind: 'player-response', protocol: 'openai', ok: true, status: 200 });
    const raw = entries[1]['rawText'] as Record<string, unknown>;
    expect((raw['choices'] as unknown[])?.[0]).toBeDefined();
    expect((entries[1]['extracted'] as Record<string, unknown>)['move']).toBe('h3-e3');
  });

  it('非 2xx:player-response ok:false 带状态码与净化错误体', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 401 })));
    const { entries, sink } = memSink();
    await mkPlayer({ debugLog: sink }).pickMove(fakeCtx).catch(() => {});
    const resp = entries[1]!;
    expect(resp['kind']).toBe('player-response');
    expect(resp['status']).toBe(401);
    expect(resp['ok']).toBe(false);
  });
});
/* ---------- 流式(SSE):长思考防网关空闲掐断 ---------- */

function sseResp(events: Record<string, unknown>[]): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('OpenAIPlayer 流式(stream: true)', () => {
  it('SSE 增量拼接出招:请求体带 stream:true;tool 参数分段拼接;usage 取末包', async () => {
    const args = JSON.stringify({ analysis: '中炮直车', move: 'h3-e3' });
    const half = Math.floor(args.length / 2);
    const fn = stubFetch(() =>
      sseResp([
        { choices: [{ index: 0, delta: { reasoning_content: '思考A' } }] },
        { choices: [{ index: 0, delta: { reasoning_content: '思考B' } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, half) } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 111, completion_tokens: 222 } },
      ]),
    );
    const picked = await mkPlayer({ stream: true }).pickMove(fakeCtx);
    expect(picked.move).toBe('h3-e3');
    expect(picked.analysis).toBe('中炮直车');
    expect(picked.usage?.promptTokens).toBe(111);
    expect(picked.usage?.completionTokens).toBe(222);
    const { body } = requestOf(fn);
    expect(body.stream).toBe(true);
  });

  it('reasoning_content 经 onThought 推流(节流);默认关流式时不带 stream 字段', async () => {
    const onThought = vi.fn();
    const args = JSON.stringify({ analysis: 'x', move: 'a1-a2' });
    const long = '长'.repeat(200); // 超过节流阈值(120 字符)必推
    const fn = stubFetch(() =>
      sseResp([
        { choices: [{ index: 0, delta: { reasoning_content: long } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } },
      ]),
    );
    await mkPlayer({ stream: true }).pickMove({ ...fakeCtx, onThought });
    expect(onThought).toHaveBeenCalled();
    const pushed = onThought.mock.calls.map((c) => String(c[0])).join('');
    expect(pushed).toContain('长');
    // 默认(非流式)请求体不带 stream
    const fn2 = stubFetch(() => chatResp());
    await mkPlayer().pickMove(fakeCtx);
    expect(requestOf(fn2).body.stream).toBeUndefined();
  });

  it('流式 finish=length 无 move -> G3c 带提示重发(第二次仍流式)', async () => {
    const args = JSON.stringify({ analysis: 'x', move: 'a1-a2' });
    // 默认实现=成功出招;第一次调用被 mockImplementationOnce 覆盖为 length 截断
    const seq = vi.fn(async () =>
      sseResp([
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 30 } },
      ]),
    ).mockImplementationOnce(async () =>
      sseResp([
        { choices: [{ index: 0, delta: { reasoning_content: '想不完' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 99 } },
      ]),
    );
    vi.stubGlobal('fetch', seq);
    const picked = await mkPlayer({ stream: true }).pickMove(fakeCtx);
    expect(picked.move).toBe('a1-a2');
    expect(seq).toHaveBeenCalledTimes(2);
    const second = requestOf(seq, 1);
    expect(second.body.stream).toBe(true);
    expect(String(second.body.messages[1].content)).toContain('没有完成工具调用');
  });

  it('流式读流中断 -> NetworkError(retryable)', async () => {
    const broken = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"x"}}]}\n\n'));
          c.error(new TypeError('fetch failed'));
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
    vi.stubGlobal('fetch', vi.fn(async () => broken));
    await expect(mkPlayer({ stream: true }).pickMove(fakeCtx)).rejects.toMatchObject({
      name: 'NetworkError',
      retryable: true,
    });
  });
});
