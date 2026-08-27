//
// App 端到端冒烟(T20 首页列表化后的自动化形态):
// 首页列表 →「开始对局」(fetch stub:POST 空配置)→ 进入 GameView → WS(fake WebSocket)
// 推 begin/move 帧 → 棋盘/记谱/成本联动;再演练 pause/resume/step 交接;深链/回放导航。
//
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import App from './App.vue';

/* ---------- 全局 stub(jsdom 无 WebSocket;fetch 拦截建局) ---------- */

const wsInstances: FakeWs[] = [];
class FakeWs {
  url: string;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    wsInstances.push(this);
  }
  close(): void {
    /* 测试内视同正常保持连接 */
  }
}

const frame = (seq: number, event: unknown) => JSON.stringify({ seq, event });

/** 通用 fetch stub:首页列表 / POST 建局 / replay / 详情兜底。 */
function stubFetch(opts: { logGames?: unknown[] } = {}) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (u === '/api/logs') return new Response(JSON.stringify({ games: opts.logGames ?? [] }), { status: 200 });
    if (u === '/api/games' && method === 'POST') return new Response(JSON.stringify({ id: 'g-smoke' }), { status: 201 });
    if (u.endsWith('/replay')) return new Response(JSON.stringify({ id: 'g-smoke', events: [] }), { status: 200 });
    return new Response(JSON.stringify({ id: 'g-smoke', status: 'paused', moveCount: 1 }), { status: 200 });
  });
}

afterEach(() => {
  wsInstances.length = 0;
  window.location.hash = '';
  vi.unstubAllGlobals();
});

describe('App 全流程冒烟', () => {
  it('首页点「开始对局」→ 建局(POST 空配置)→ WS 事件 → 棋盘/记谱/成本渲染;pause/resume/step 发 REST', async () => {
    vi.stubGlobal('WebSocket', FakeWs as unknown as typeof WebSocket);
    const restCalls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        const method = init?.method ?? 'GET';
        if (u === '/api/logs') return new Response(JSON.stringify({ games: [] }), { status: 200 });
        if (u === '/api/games' && method === 'POST') {
          // 断言请求体为空配置 + 思考模式(红/黑不落屏,服务端回落 config.json)
          const posted = JSON.parse(String(init?.body));
          expect(posted.red.model).toBe('');
          expect(posted.config?.thinkingMode).toBe('off'); // 重开默认关闭思考
          return new Response(JSON.stringify({ id: 'g-smoke' }), { status: 201 });
        }
        if (u.endsWith('/replay')) return new Response(JSON.stringify({ id: 'g-smoke', events: [] }), { status: 200 });
        restCalls.push(u);
        return new Response(JSON.stringify({ id: 'g-smoke', status: 'paused', moveCount: 1 }), { status: 200 });
      }),
    );

    const w = mount(App);
    // 初始为首页对局列表
    expect(w.find('[data-testid="home-view"]').exists()).toBe(true);

    // 「开始对局」→ 用服务器默认配置建局,进入对局页,WS 已按 since=0 订阅
    await w.get('[data-testid="start-game"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="controls"]').exists()).toBe(true);
    expect(wsInstances).toHaveLength(1);
    expect(wsInstances[0]!.url).toContain('/ws/games/g-smoke?since=0');

    const ws = wsInstances[0]!;
    ws.onmessage!({ data: frame(1, { seq: 1, ts: 't', type: 'begin', gameId: 'g-smoke', first: 'red', red: { model: 'm-red' }, black: { model: 'm-black' } }) });
    ws.onmessage!({
      data: frame(2, {
        seq: 2,
        ts: 't',
        type: 'move',
        turn: 'red',
        move: { from: 'h3', to: 'e3', notation: '炮二平五' },
        analysis: '先手架中炮',
        elapsedMs: 2100,
        usage: { promptTokens: 1000, completionTokens: 120, costUsd: 0.0031 },
        legal: true,
      }),
    });
    await flushPromises();

    expect(w.findAll('.pc')).toHaveLength(32); // 棋盘点数不变(炮平移,无吃子)
    expect(w.text()).toContain('第1回合'); // 红方思考卡:已落子历史标「第1回合」(非「当前」)

    // 履历默认收起(不占棋盘);点顶部「对局履历」按钮展开可见着法
    await w.get('[data-testid="toggle-log"]').trigger('click');
    await flushPromises();
    expect(w.get('[data-testid="log-panel"]').text()).toContain('炮二平五');
    expect(w.get('[data-testid="meta-first"]').text()).toBe('红方'); // 先手(来自 begin.first)
    expect(w.get('[data-testid="meta-round"]').text()).toBe('1'); // 回合 1
    expect(w.get('[data-testid="meta-half"]').text()).toBe('1'); // 步数 1

    // 暂停 → 单步(仅暂停态可用)→ 继续 → REST 路由
    await w.get('[data-testid="play"]').trigger('click');
    await flushPromises();
    expect(restCalls).toContain('/api/games/g-smoke/pause');
    await w.get('[data-testid="step"]').trigger('click'); // paused → step 可用
    await flushPromises();
    expect(restCalls).toContain('/api/games/g-smoke/step');
    await w.get('[data-testid="play"]').trigger('click'); // paused → 继续
    await flushPromises();
    expect(restCalls).toContain('/api/games/g-smoke/resume');

    w.unmount();
  });
});

describe('App 深链观战(hash 路由)', () => {
  it('打开 #/g/<id> 直达对局页并订阅该局 WS;地址栏改 #/r/<id> 切回放', async () => {
    vi.stubGlobal('WebSocket', FakeWs as unknown as typeof WebSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        if (u.endsWith('/replay')) return new Response(JSON.stringify({ id: 'g-deep', events: [] }), { status: 200 });
        return new Response(JSON.stringify({ id: 'g-deep', status: 'paused', moveCount: 1 }), { status: 200 });
      }),
    );

    window.location.hash = '#/g/g-deep';
    const w = mount(App);
    await flushPromises();

    // 不经首页直达对局页(无首页、无表单),WS 订阅深链局
    expect(w.find('[data-testid="home-view"]').exists()).toBe(false);
    expect(w.find('[data-testid="controls"]').exists()).toBe(true);
    expect(wsInstances).toHaveLength(1);
    expect(wsInstances[0]!.url).toContain('/ws/games/g-deep?since=0');

    // 地址栏 hash 改到回放 → 视图切换
    window.location.hash = '#/r/g-deep';
    window.dispatchEvent(new Event('hashchange'));
    await flushPromises();
    expect(w.find('[data-testid="replay-view"]').exists()).toBe(true);

    w.unmount();
  });

  it('无 hash 落回首页对局列表', () => {
    window.location.hash = '#/';
    vi.stubGlobal('fetch', stubFetch());
    const w = mount(App);
    expect(w.find('[data-testid="home-view"]').exists()).toBe(true);
    w.unmount();
  });
});

describe('App 回放导航', () => {
  it('对局页点「回放」→ Replay 视图挂载并读 replay API;退出回放回首页列表', async () => {
    vi.stubGlobal('WebSocket', FakeWs as unknown as typeof WebSocket);
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        calls.push(u);
        if (u === '/api/logs') return new Response(JSON.stringify({ games: [] }), { status: 200 });
        if (u === '/api/games' && (init?.method ?? 'GET') === 'POST') return new Response(JSON.stringify({ id: 'g-smoke' }), { status: 201 });
        if (u.endsWith('/replay')) return new Response(JSON.stringify({ id: 'g-smoke', events: [] }), { status: 200 });
        return new Response(JSON.stringify({ id: 'g-smoke', status: 'paused', moveCount: 1 }), { status: 200 });
      }),
    );

    const w = mount(App);
    await w.get('[data-testid="start-game"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="controls"]').exists()).toBe(true);

    await w.get('[data-testid="replay-nav"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="replay-view"]').exists()).toBe(true);
    expect(calls).toContain('/api/games/g-smoke/replay');

    // 回放页「回到当前棋局」→ 直达实时观战(重挂 GameView,重新订阅 WS)
    await w.get('[data-testid="replay-to-game"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="controls"]').exists()).toBe(true);
    expect(wsInstances).toHaveLength(2); // 原观战连接已断,重挂后新订阅

    // 再进回放,「退出回放」→ 回首页列表
    await w.get('[data-testid="replay-nav"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="replay-view"]').exists()).toBe(true);
    await w.get('[data-testid="replay-exit"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="home-view"]').exists()).toBe(true);

    w.unmount();
  });
});