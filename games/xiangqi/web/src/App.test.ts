//
// App 端到端冒烟(Task 19 手工验收的自动化形态):
// 提交新局表单 → createGame(fetch stub)→ 进入 GameView → WS(fake WebSocket)
// 推 begin/move 帧 → 棋盘/记谱/成本联动;再演练 pause/resume/step 交接。
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

afterEach(() => {
  wsInstances.length = 0;
  vi.unstubAllGlobals();
});

describe('App 全流程冒烟', () => {
  it('建局→WS 事件→棋盘/记谱/成本渲染;pause/resume/step 发 REST', async () => {
    vi.stubGlobal('WebSocket', FakeWs as unknown as typeof WebSocket);
    const restCalls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u === '/api/games') return new Response(JSON.stringify({ id: 'g-smoke' }), { status: 201 });
        restCalls.push(u);
        return new Response(JSON.stringify({ id: 'g-smoke', status: 'paused', moveCount: 1 }), { status: 200 });
      }),
    );

    const w = mount(App);
    // 初始为表单
    expect(w.find('form[data-testid="new-game-form"]').exists()).toBe(true);

    // 填表并提交
    const red = w.get('fieldset[data-side="red"]');
    const black = w.get('fieldset[data-side="black"]');
    for (const fs of [red, black]) {
      fs.find('input[placeholder*="sk-"]').setValue('k');
      fs.find('input[placeholder*="claude"]').setValue('m');
      fs.find('input[placeholder*="api.anthropic"]').setValue('https://api.anthropic.com/v1');
    }
    await w.get('form').trigger('submit');
    await flushPromises();

    // 进入对局页,WS 已按 since=0 订阅
    expect(w.find('[data-testid="controls"]').exists()).toBe(true);
    expect(wsInstances).toHaveLength(1);
    expect(wsInstances[0]!.url).toContain('/ws/games/g-smoke?since=0');

    const ws = wsInstances[0]!;
    ws.onmessage!({ data: frame(1, { seq: 1, ts: 't', type: 'begin', gameId: 'g-smoke', red: { model: 'm-red' }, black: { model: 'm-black' } }) });
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
    expect(w.text()).toContain('炮二平五'); // 记谱履历
    expect(w.get('[data-testid="meta-cost"]').text()).toContain('$0.0031'); // 成本
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

describe('App 回放导航', () => {
  it('对局页点「回放」→ Replay 视图挂载并读 replay API;退出回放回表单', async () => {
    vi.stubGlobal('WebSocket', FakeWs as unknown as typeof WebSocket);
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        calls.push(u);
        if (u.endsWith('/replay')) return new Response(JSON.stringify({ id: 'g-smoke', events: [] }), { status: 200 });
        if (u === '/api/games') return new Response(JSON.stringify({ id: 'g-smoke' }), { status: 201 });
        return new Response(JSON.stringify({ id: 'g-smoke', status: 'paused', moveCount: 1 }), { status: 200 });
      }),
    );

    const w = mount(App);
    const red = w.get('fieldset[data-side="red"]');
    const black = w.get('fieldset[data-side="black"]');
    for (const fs of [red, black]) {
      fs.find('input[placeholder*="sk-"]').setValue('k');
      fs.find('input[placeholder*="claude"]').setValue('m');
      fs.find('input[placeholder*="api.anthropic"]').setValue('https://api.anthropic.com/v1');
    }
    await w.get('form').trigger('submit');
    await flushPromises();
    expect(w.find('[data-testid="controls"]').exists()).toBe(true);

    await w.get('[data-testid="replay-nav"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="replay-view"]').exists()).toBe(true);
    expect(calls).toContain('/api/games/g-smoke/replay');

    await w.get('[data-testid="replay-exit"]').trigger('click');
    await flushPromises();
    expect(w.find('form[data-testid="new-game-form"]').exists()).toBe(true);

    w.unmount();
  });
});