//
// Replay 视图测试:挂载 + 读 replay API(fetch stub)→ 棋盘/履历/时间轴;步进/回退/
// 拖动以 seq 为轴;到终局显示「单局·未换色」注记与复盘降级提示;失败态有返回入口。
//
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import Replay from './Replay.vue';
import type { BeginEvent, FinishEvent, GameEvent, MoveEvent } from '../../../server/game-log';

const baseEvents = (): GameEvent[] => {
  const begin: BeginEvent = {
    seq: 1,
    ts: 't',
    type: 'begin',
    gameId: 'g',
    red: { model: 'mR' },
    black: { model: 'mB' },
    rules: { drawRepeat: 3, illegalAttemptsLimit: 3, maxTotalMoves: 200, networkRetries: 3, timeoutMs: 120000, carrySelfAnalysisN: 6, contextBudgetTokens: 32000 },
  };
  const m = (seq: number, turn: 'red' | 'black', from: string, to: string, notation: string): MoveEvent =>
    ({ seq, ts: 't', type: 'move', turn, move: { from, to, notation }, legal: true }) as MoveEvent;
  return [
    begin,
    m(2, 'red', 'h3', 'e3', '炮二平五'),
    m(3, 'black', 'h8', 'e8', '炮8平5'),
    { seq: 4, ts: 't', type: 'finish', winner: 'red', reason: 'checkmate', ruleViolations: { red: { pre: 0, post: 0 }, black: { pre: 0, post: 1 } } } as FinishEvent,
  ];
};

const stubFetch = (events: GameEvent[]) =>
  vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith('/replay')) return new Response(JSON.stringify({ id: 'g', events }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 404 });
  });

describe('Replay 视图', () => {
  it('加载后:初始棋盘 32 子、履历空、时间轴 max=finish seq;步进后棋盘更新', async () => {
    vi.stubGlobal('fetch', stubFetch(baseEvents()));
    const w = mount(Replay, { props: { gameId: 'g' } });
    await flushPromises();

    expect(w.find('[data-testid="replay-view"]').exists()).toBe(true);
    expect(w.findAll('.pc')).toHaveLength(32);
    expect(w.get('[data-testid="replay-half"]').text()).toBe('0');
    expect((w.get('[data-testid="replay-slider"]').element as HTMLInputElement).max).toBe('4');

    // 单步 0 → 2:红炮到 e3
    await w.get('[data-testid="replay-step"]').trigger('click');
    await flushPromises();
    expect(w.get('[data-testid="replay-half"]').text()).toBe('1');
    expect(w.text()).toContain('炮二平五');
    const e3 = w.findAll('.pc').find((pc) => pc.attributes('data-file') === '4' && pc.attributes('data-rank') === '2');
    expect(e3?.attributes('data-type')).toBe('cannon');

    // 回退:回到初始
    await w.get('[data-testid="replay-back"]').trigger('click');
    await flushPromises();
    expect(w.get('[data-testid="replay-half"]').text()).toBe('0');

    w.unmount();
    vi.unstubAllGlobals();
  });

  it('拖动到 finish seq:终局横幅含「单局·未换色」注记、复盘缺位降级提示', async () => {
    vi.stubGlobal('fetch', stubFetch(baseEvents()));
    const w = mount(Replay, { props: { gameId: 'g' } });
    await flushPromises();

    const slider = w.get('[data-testid="replay-slider"]');
    await slider.setValue('4');
    await flushPromises();

    expect(w.get('[data-testid="replay-result"]').text()).toBe('红方 胜');
    expect(w.get('[data-testid="replay-note"]').text()).toContain('单局 · 未换色,胜负不作模型强弱结论');
    expect(w.get('[data-testid="review-degraded"]').text()).toMatch(/生成中|不可用/);

    w.unmount();
    vi.unstubAllGlobals();
  });

  it('抓取失败:错误横幅 + 返回按钮 emit exit', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: '对局不存在' } }), { status: 404 }));
    vi.stubGlobal('fetch', fetcher);
    const w = mount(Replay, { props: { gameId: 'nope' } });
    await flushPromises();

    expect(w.get('[data-testid="replay-error"]').text()).toContain('对局不存在');
    await w.get('[data-testid="replay-error"] button').trigger('click');
    expect(w.emitted('exit')).toHaveLength(1);

    w.unmount();
    vi.unstubAllGlobals();
  });
});