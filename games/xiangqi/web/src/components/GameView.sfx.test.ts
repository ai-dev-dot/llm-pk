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
});