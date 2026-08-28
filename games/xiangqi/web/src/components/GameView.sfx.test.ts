//
// GameView 音效接线(B5):move/captured 事件触发 sfx.play;🔊/🔇 切换调用 setMuted。
// 通过 vi.mock 断言 sfx 模块被正确调用。
//
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import GameView from './GameView.vue';

vi.mock('../lib/sfx', () => ({
  play: vi.fn(),
  setMuted: vi.fn(),
  unlock: vi.fn(),
  isMuted: () => false,
}));

import { play, setMuted } from '../lib/sfx';

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
    /* 测试内保持连接 */
  }
}

const frame = (seq: number, event: unknown) => JSON.stringify({ seq, event });
const beginEv = () => ({ seq: 1, ts: 't', type: 'begin', gameId: 'g-sfx', red: { model: 'm' }, black: { model: 'm' } });

afterEach(() => {
  wsInstances.length = 0;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('GameView 音效接线 B5', () => {
  it('非吃子 move → play("move");吃子 move(子数下降)→ play("capture")', async () => {
    vi.stubGlobal('WebSocket', FakeWs as unknown as typeof WebSocket);
    mount(GameView, { props: { gameId: 'g-sfx' } });
    const ws = wsInstances[0]!;
    ws.onmessage!({ data: frame(1, beginEv()) });
    // 红炮二平五→e3 无吃子 → move 音
    ws.onmessage!({ data: frame(2, { seq: 2, ts: 't', type: 'move', turn: 'red', move: { from: 'h3', to: 'e3' }, legal: true }) });
    await flushPromises();
    expect(play).toHaveBeenLastCalledWith('move');

    // 红兵 e4→e7 吃黑卒 → capture 音
    ws.onmessage!({ data: frame(3, { seq: 3, ts: 't', type: 'move', turn: 'red', move: { from: 'e4', to: 'e7' }, legal: true }) });
    await flushPromises();
    expect(play).toHaveBeenLastCalledWith('capture');
  });

  it('check 事件 → play("check");finish 事件 → play("finish")', async () => {
    vi.stubGlobal('WebSocket', FakeWs as unknown as typeof WebSocket);
    mount(GameView, { props: { gameId: 'g-sfx' } });
    const ws = wsInstances[0]!;
    ws.onmessage!({ data: frame(1, beginEv()) });

    ws.onmessage!({ data: frame(2, { seq: 2, ts: 't', type: 'check', side: 'black' }) });
    await flushPromises();
    expect(play).toHaveBeenLastCalledWith('check');

    ws.onmessage!({
      data: frame(3, { seq: 3, ts: 't', type: 'finish', winner: 'red', reason: 'checkmate', ruleViolations: { red: { pre: 0, post: 0 }, black: { pre: 0, post: 1 } } }),
    });
    await flushPromises();
    expect(play).toHaveBeenLastCalledWith('finish');
  });

  it('思考计时徽章:begin 后标「红方思考中」;红落子后切「黑方」', async () => {
    vi.stubGlobal('WebSocket', FakeWs as unknown as typeof WebSocket);
    const w = mount(GameView, { props: { gameId: 'g-sfx' } });
    const ws = wsInstances[0]!;
    ws.onmessage!({ data: frame(1, beginEv()) });
    await flushPromises();
    expect(w.find('[data-testid="think-timer"]').exists()).toBe(true);
    expect(w.get('[data-testid="think-timer"]').text()).toContain('红方');

    ws.onmessage!({ data: frame(2, { seq: 2, ts: 't', type: 'move', turn: 'red', move: { from: 'h3', to: 'e3' }, legal: true }) });
    await flushPromises();
    expect(w.get('[data-testid="think-timer"]').text()).toContain('黑方');

    w.unmount();
  });

  it('重开需确认:点「↺重开」先弹确认;确认才 emit restart,取消不 emit', async () => {
    vi.stubGlobal('WebSocket', FakeWs as unknown as typeof WebSocket);
    const w = mount(GameView, { props: { gameId: 'g-sfx' } });
    wsInstances[0]!.onmessage!({ data: frame(1, beginEv()) });
    await flushPromises();

    await w.get('[data-testid="restart"]').trigger('click');
    expect(w.find('[data-testid="confirm-mask"]').exists()).toBe(true);
    expect(w.emitted('restart')).toBeUndefined(); // 未确认前不触发

    await w.get('[data-testid="confirm-restart"]').trigger('click');
    await flushPromises();
    expect(w.emitted('restart')).toHaveLength(1); // 确认后放行
    expect(w.find('[data-testid="confirm-mask"]').exists()).toBe(false);
    w.unmount();
  });

  it('重开确认可取消:取消后不 emit restart', async () => {
    vi.stubGlobal('WebSocket', FakeWs as unknown as typeof WebSocket);
    const w = mount(GameView, { props: { gameId: 'g-sfx' } });
    await w.get('[data-testid="restart"]').trigger('click');
    await w.get('.confirm-actions .btn').trigger('click'); // 「取消」
    await flushPromises();
    expect(w.emitted('restart')).toBeUndefined();
    expect(w.find('[data-testid="confirm-mask"]').exists()).toBe(false);
    w.unmount();
  });

  it('静音钮切换 → setMuted 真 toggle(且经手势解锁)', async () => {
    vi.stubGlobal('WebSocket', FakeWs as unknown as typeof WebSocket);
    const w = mount(GameView, { props: { gameId: 'g-sfx' } });
    wsInstances[0]!.onmessage!({ data: frame(1, beginEv()) });
    await flushPromises();
    await w.get('[data-testid="mute"]').trigger('click');
    await flushPromises();
    expect(setMuted).toHaveBeenLastCalledWith(true);
    await w.get('[data-testid="mute"]').trigger('click');
    await flushPromises();
    expect(setMuted).toHaveBeenLastCalledWith(false);
  });

  it('裁判 toast:illegal-attempt 事件 → 显示「*方已经 n 次未遵守规则,被打回」;连续打回刷新同一条', async () => {
    vi.stubGlobal('WebSocket', FakeWs as unknown as typeof WebSocket);
    const w = mount(GameView, { props: { gameId: 'g-sfx' } });
    const ws = wsInstances[0]!;
    ws.onmessage!({ data: frame(1, beginEv()) });
    ws.onmessage!({
      data: frame(2, { seq: 2, ts: 't', type: 'illegal-attempt', side: 'black', round: 1, reason: '马腿被绊', violations: { pre: 1, post: 0 } }),
    });
    await flushPromises();
    expect(w.get('[data-testid="referee-toast"]').text()).toContain('黑方 已经 1 次未遵守规则,被打回');

    // 第二次打回 → 同一条更新计数(不叠加多条)
    ws.onmessage!({
      data: frame(3, { seq: 3, ts: 't', type: 'illegal-attempt', side: 'black', round: 2, reason: '送将', violations: { pre: 1, post: 1 } }),
    });
    await flushPromises();
    const toast = w.get('[data-testid="referee-toast"]').text();
    expect(toast).toContain('黑方 已经 2 次未遵守规则,被打回');
    expect(w.findAll('[data-testid="referee-toast"]')).toHaveLength(1);
    w.unmount();
  });

  it('超时挂起 UI:timeout 事件 → 对应方「已超时 + 重试」条;点击重试 POST /:id/retry 并解除挂起', async () => {
    vi.stubGlobal('WebSocket', FakeWs as unknown as typeof WebSocket);
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        if (u.endsWith('/retry')) {
          calls.push(u);
          return new Response(JSON.stringify({ id: 'g-sfx', status: 'running', stuck: null }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      }),
    );
    const w = mount(GameView, { props: { gameId: 'g-sfx' } });
    const ws = wsInstances[0]!;
    ws.onmessage!({ data: frame(1, beginEv()) });
    ws.onmessage!({ data: frame(2, { seq: 2, ts: 't', type: 'timeout', side: 'red', cause: 'network-exhausted' }) });
    await flushPromises();

    expect(w.find('[data-testid="stuck-red"]').exists()).toBe(true);
    expect(w.get('[data-testid="stuck-red"]').text()).toContain('网络断连');
    expect(w.get('[data-testid="stuck-red"]').text()).toContain('重试');
    expect(w.find('[data-testid="stuck-black"]').exists()).toBe(false);

    await w.get('[data-testid="retry-red"]').trigger('click');
    await flushPromises();
    expect(calls).toContain('/api/games/g-sfx/retry');
    // retry 成功 → 挂起解除,超时条消失
    expect(w.find('[data-testid="stuck-red"]').exists()).toBe(false);
    w.unmount();
  });
});