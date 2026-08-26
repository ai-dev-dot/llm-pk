//
// useReplay 组合器测试:纯事件回放(绝不触 arena 运行时)。
// - 加载 GET /:id/replay → phase=ready,board=初始;
// - 步进/回退/拖动(seekTo)以 seq 为轴,board 与 boardAt(events, cur) 一致;
// - 播放自动推进至结尾并停止;抓取失败 → phase=error。
//
import { describe, expect, it, vi } from 'vitest';
import { useReplay } from './useReplay';
import { boardAt, initialPiecesWithUid } from '../lib/replay';
import type { BeginEvent, FinishEvent, GameEvent, MoveEvent, ReviewEvent } from '../../../server/game-log';
import type { Side } from '../../../engine/types';

const usage = (costUsd: number) => ({ promptTokens: 1000, completionTokens: 120, costUsd });

function replayEvents(): GameEvent[] {
  const begin: BeginEvent = {
    seq: 1,
    ts: 't',
    type: 'begin',
    gameId: 'g',
    red: { model: 'mR' },
    black: { model: 'mB' },
    rules: { drawRepeat: 3, illegalAttemptsLimit: 3, maxTotalMoves: 200, networkRetries: 3, timeoutMs: 120000, carrySelfAnalysisN: 6, contextBudgetTokens: 32000 },
  };
  const m = (seq: number, turn: Side, from: string, to: string): MoveEvent =>
    ({ seq, ts: 't', type: 'move', turn, move: { from, to, notation: `${from}-${to}` }, legal: true, usage: usage(0.001) }) as MoveEvent;
  return [
    begin,
    m(2, 'red', 'h3', 'e3'),
    m(3, 'black', 'h8', 'e8'),
    m(4, 'red', 'e4', 'e7'),
    { seq: 5, ts: 't', type: 'review', summary: '复盘摘要', keyPoints: ['要点'] } as ReviewEvent,
    m(6, 'black', 'g7', 'g6'), // 黑卒(6,6)→(6,5)
    { seq: 7, ts: 't', type: 'finish', winner: 'red', reason: 'checkmate', ruleViolations: { red: { pre: 0, post: 0 }, black: { pre: 0, post: 1 } } } as FinishEvent,
  ];
}

const fakeFetcher = (events: GameEvent[]) => {
  const fn = vi.fn(async (url: string | URL | Request) => {
    expect(String(url)).toBe('/api/games/g/replay');
    return new Response(JSON.stringify({ id: 'g', events }), { status: 200 });
  });
  return fn as unknown as typeof fetch;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('useReplay', () => {
  it('加载:phase=ready、board=初始、cur=0、steps 含 finish', async () => {
    const r = useReplay('g', { fetcher: fakeFetcher(replayEvents()), baseStepMs: 1 });
    await sleep(10);
    expect(r.phase).toBe('ready');
    expect(r.cur).toBe(0);
    expect(r.board).toEqual(initialPiecesWithUid());
    expect(r.steps).toEqual([0, 2, 3, 4, 6, 7]);
    expect(r.review?.summary).toBe('复盘摘要');
    expect(r.result).toBeNull();
    r.controls.destroy();
  });

  it('step/back:以 seq 快照点前进/回退,board ≡ boardAt(events, cur)', async () => {
    const evts = replayEvents();
    const r = useReplay('g', { fetcher: fakeFetcher(evts), baseStepMs: 1 });
    await sleep(10);

    r.controls.step(); // 0 → 2
    expect(r.cur).toBe(2);
    expect(r.board).toEqual(boardAt(evts, 2));
    expect(r.moves).toHaveLength(1);

    r.controls.step(); // 2 → 3
    r.controls.step(); // 3 → 4
    expect(r.moves).toHaveLength(3);
    expect(r.board).toHaveLength(31); // e4→e7 吃子

    r.controls.back(); // 4 → 3
    expect(r.cur).toBe(3);
    expect(r.board).toEqual(boardAt(evts, 3));
    expect(r.board).toHaveLength(32);

    r.controls.back(); // 3 → 2
    expect(r.cur).toBe(2);

    r.controls.back(); // 2 → 0
    expect(r.cur).toBe(0);
    expect(r.board).toEqual(initialPiecesWithUid());

    r.controls.back(); // 端点:不再回退
    expect(r.cur).toBe(0);
    r.controls.destroy();
  });

  it('seekTo(拖动):任意 seq 夹取到 [0, maxStep];到 finish 显示终局结果', async () => {
    const evts = replayEvents();
    const r = useReplay('g', { fetcher: fakeFetcher(evts), baseStepMs: 1 });
    await sleep(10);

    r.controls.seekTo(7); // finish seq
    expect(r.cur).toBe(7);
    expect(r.result?.winner).toBe('red');
    expect(boardAt(evts, 7)).toEqual(r.board);

    r.controls.seekTo(999); // 越界夹取
    expect(r.cur).toBe(7);
    r.controls.seekTo(-5); // 下界夹取
    expect(r.cur).toBe(0);
    r.controls.destroy();
  });

  it('play:从当前推进到最后快照点后自动停止', async () => {
    const r = useReplay('g', { fetcher: fakeFetcher(replayEvents()), baseStepMs: 5 });
    await sleep(10);
    r.controls.play();
    expect(r.playing).toBe(true);
    await vi.waitFor(() => expect(r.playing).toBe(false), { timeout: 2000, interval: 5 });
    expect(r.cur).toBe(7);
    expect(r.result?.winner).toBe('red');
    r.controls.destroy();
  });

  it('play 到结尾后再播放:回到 0 重播', async () => {
    const r = useReplay('g', { fetcher: fakeFetcher(replayEvents()), baseStepMs: 5 });
    await sleep(10);
    r.controls.seekTo(7);
    r.controls.play();
    await vi.waitFor(() => expect(r.cur).toBeLessThan(7), { timeout: 2000, interval: 5 }); // 已从 0 重新起播
    r.controls.destroy();
  });

  it('抓取失败:phase=error 带 message,不影响棋盘展示(仍为初始局面)', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: '对局不存在' } }), { status: 404 }));
    const r = useReplay('nope', { fetcher: fetcher as unknown as typeof fetch });
    await sleep(10);
    expect(r.phase).toBe('error');
    expect(r.error).toBe('对局不存在');
    expect(r.board).toHaveLength(32);
    r.controls.destroy();
  });
});