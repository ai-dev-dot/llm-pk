//
// GameView 慢放队列竞态回归(T21):连续快速走子(上一步动画未落完时下一步已到达)时,
// 队列必须基于「事实局面链」演进——不得取滞后的 displayBoard 快照(否则 applyMoveToPieces
// 在旧局面找不到 from 位子 → 兜底在目标格生造 pawn,观战误显示「红兵」)。
// 复用 motk rAF:jsdom 无 requestAnimationFrame,慢放队列会挂在第一次 raf。
//
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import GameView from './GameView.vue';

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
    /* 测试内保持 */
  }
}
const frame = (seq: number, event: unknown) => JSON.stringify({ seq, event });
const beginEv = () => ({ seq: 1, ts: 't', type: 'begin', gameId: 'g-chain', first: 'red', red: { model: 'm' }, black: { model: 'm' } });

afterEach(() => {
  wsInstances.length = 0;
  vi.unstubAllGlobals();
});

describe('GameView 慢放队列(竞态回归)', () => {
  it('快速连发多步(含 隔兵吃卒):e7 渲染红「砲」而非兜底「兵」;e4 红兵保留', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      cb();
      return 1;
    });
    vi.stubGlobal('WebSocket', FakeWs as unknown as typeof WebSocket);
    const w = mount(GameView, { props: { gameId: 'g-chain' } });
    const ws = wsInstances[0]!;
    ws.onmessage!({ data: frame(1, beginEv()) });
    // 不等逐帧动画动画完成,连续推三步:红炮 b3→e3、黑炮 h8→e8、红炮 e3 隔 e4 兵吃 e7 黑卒
    ws.onmessage!({ data: frame(2, { seq: 2, ts: 't', type: 'move', turn: 'red', move: { from: 'b3', to: 'e3' }, legal: true }) });
    ws.onmessage!({ data: frame(3, { seq: 3, ts: 't', type: 'move', turn: 'black', move: { from: 'h8', to: 'e8' }, legal: true }) });
    ws.onmessage!({ data: frame(4, { seq: 4, ts: 't', type: 'move', turn: 'red', move: { from: 'e3', to: 'e7' }, legal: true }) });
    // 等慢放队列全部排完(默认 speed=1,每步 hover/path/落子约 1.6s)
    await new Promise((r) => setTimeout(r, 7000));

    const e7 = w.find('.pc[data-file="4"][data-rank="6"]');
    expect(e7.exists()).toBe(true);
    expect(e7.text()).toContain('砲'); // 红炮吃掉黑卒,目标格是「砲」而非被生造的「兵」/残留的「卒」
    expect(e7.text()).not.toContain('兵');
    const e4 = w.find('.pc[data-file="4"][data-rank="3"]');
    expect(e4.exists()).toBe(true);
    expect(e4.text()).toContain('兵'); // 炮架红兵未被误食
    w.unmount();
  }, 20000);
});
