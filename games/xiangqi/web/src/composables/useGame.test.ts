//
// useGame 状态机测试(TDD):
// - move 事件推进棋盘(起点移子/吃子清除/换手);finish 置 phase;illegal-attempt 累计打回;
// - usage 累加成本/耗时;player-message 累积流式思考;
// - 断线重连:fake WS 断言第二次连接 url `since=<lastSeq>`、补发事件不被重复应用。
//
import { describe, expect, it, vi } from 'vitest';
import { createGame, useGame } from './useGame';
import type { MoveEvent, FinishEvent, IllegalAttemptEvent, BeginEvent, Usage } from '../../../server/game-log';
import type { Side } from '../../../engine/types';
import { initialBoard } from '../../../engine/board';
import { recordsFromBoard } from '../lib/board';

/* ---------- fake WS ---------- */

type Handler = (data: unknown) => void;
interface FakeWs {
  url: string;
  onopen: Handler;
  onmessage: (ev: { data: unknown }) => void;
  onclose: Handler;
  onerror: Handler;
  close: () => void;
}

function makeFactory() {
  const sockets: FakeWs[] = [];
  const factory = vi.fn((url: string) => {
    const ws: FakeWs = {
      url,
      onopen: () => undefined,
      onmessage: () => undefined,
      onclose: () => undefined,
      onerror: () => undefined,
      close: () => {
        // 模拟服务端/网络关闭:触发 onclose(框架注册的 handleClose)
        ws.onclose(null);
      },
    };
    sockets.push(ws);
    return ws;
  });
  return { factory, sockets };
}

const frame = (seq: number, event: unknown) => JSON.stringify({ seq, event });

function moveEv(partial: Partial<MoveEvent>): MoveEvent {
  return {
    seq: 0,
    ts: 't',
    type: 'move',
    turn: 'red',
    move: { from: 'h3', to: 'e3' },
    legal: true,
    ...partial,
  } as MoveEvent;
}

const usage5 = (costUsd = 0.005): Usage => ({ promptTokens: 1000, completionTokens: 120, costUsd });

function beginEv(): BeginEvent {
  return {
    seq: 1,
    ts: 't',
    type: 'begin',
    gameId: 'g1',
    first: 'red',
    red: { model: 'red-m' },
    black: { model: 'black-m' },
    rules: { drawRepeat: 3, illegalAttemptsLimit: 3, maxTotalMoves: 200, networkRetries: 3, timeoutMs: 120000, carrySelfAnalysisN: 6, contextBudgetTokens: 32000 },
  };
}

/* ---------- createGame ---------- */

describe('createGame', () => {
  it('POST /api/games 返回 { id }', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'g-abc' }), { status: 201 }));
    const res = await createGame({ red: { baseUrl: 'u', apiKey: 'k', model: 'm1' }, black: { baseUrl: 'u', apiKey: 'k', model: 'm2' } }, fetcher as unknown as typeof fetch);
    expect(res.id).toBe('g-abc');
    expect(fetcher).toHaveBeenCalledWith('/api/games', expect.objectContaining({ method: 'POST' }));
  });

  it('HTTP 400 抛 hint', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'x', hint: '补上 model' } }), { status: 400 }));
    await expect(
      createGame({ red: { baseUrl: 'u', apiKey: 'k', model: '' }, black: { baseUrl: 'u', apiKey: 'k', model: '' } }, fetcher as unknown as typeof fetch),
    ).rejects.toThrow('补上 model');
  });
});

/* ---------- useGame:初始状态 ---------- */

describe('useGame 初始态', () => {
  it('board 即 initialBoard 的 32 子;phase=connecting', () => {
    const { factory } = makeFactory();
    const g = useGame('g1', { wsFactory: factory });
    expect(g.board).toHaveLength(recordsFromBoard(initialBoard()).length);
    expect(g.phase).toBe('connecting');
    expect(g.lastMove).toBeNull();
    expect(factory).toHaveBeenCalledWith(expect.stringContaining('since=0'));
    g.controls.destroy();
  });

  it('begin 事件:phase=running、记录红黑 model', () => {
    const { factory, sockets } = makeFactory();
    const g = useGame('g1', { wsFactory: factory });
    sockets[0]!.onmessage({ data: frame(1, beginEv()) });
    expect(g.phase).toBe('running');
    expect(g.models.red).toBe('red-m');
    expect(g.models.black).toBe('black-m');
    g.controls.destroy();
  });
});

/* ---------- move 推进棋盘 ---------- */

describe('useGame move 推进', () => {
  it('move 事件:起点子移到终点、吃子移除、换手、lastMove 设置', () => {
    const { factory, sockets } = makeFactory();
    const g = useGame('g1', { wsFactory: factory });
    sockets[0]!.onmessage({ data: frame(1, beginEv()) });

    // 红炮二平五:h3(7,2) → e3(4,2)
    sockets[0]!.onmessage({
      data: frame(2, moveEv({ seq: 2, turn: 'red', move: { from: 'h3', to: 'e3' }, analysis: '架中炮', usage: usage5() })),
    });

    const at = (file: number, rank: number) => g.board.find((p) => p.file === file && p.rank === rank);
    expect(at(7, 2)).toBeUndefined(); // 起点已走
    expect(at(4, 2)?.type).toBe('cannon'); // 终点有红炮
    expect(g.lastMove).toEqual({ from: { file: 7, rank: 2 }, to: { file: 4, rank: 2 } });
    expect(g.turn).toBe('black'); // 换手
    expect(g.board).toHaveLength(32); // 无吃子,仍 32 子
    g.controls.destroy();
  });

  it('move 吃子:目标黑卒被移除,总子减一', () => {
    const { factory, sockets } = makeFactory();
    const g = useGame('g1', { wsFactory: factory });
    sockets[0]!.onmessage({ data: frame(1, beginEv()) });

    // 红兵四进三吃黑卒:(4,3)→(4,6)
    sockets[0]!.onmessage({
      data: frame(2, moveEv({ seq: 2, turn: 'red', move: { from: 'e4', to: 'e7' } })),
    });
    expect(g.board).toHaveLength(31);
    const at = (file: number, rank: number) => g.board.find((p) => p.file === file && p.rank === rank);
    expect(at(4, 6)?.type).toBe('pawn');
    expect(at(4, 6)?.side).toBe('red');
    g.controls.destroy();
  });

  it('稳定 uid:同一棋子走子前后 uid 不变;被吃子 uid 不再出现', () => {
    const { factory, sockets } = makeFactory();
    const g = useGame('g1', { wsFactory: factory });
    sockets[0]!.onmessage({ data: frame(1, beginEv()) });
    const before = g.board.find((p) => p.file === 7 && p.rank === 2)!.uid;
    sockets[0]!.onmessage({ data: frame(2, moveEv({ seq: 2, turn: 'red', move: { from: 'h3', to: 'e3' } })) });
    const after = g.board.find((p) => p.file === 4 && p.rank === 2)!.uid;
    expect(after).toBe(before);
    g.controls.destroy();
  });

  it('usage 按方累加 costUsd/token 与耗时', () => {
    const { factory, sockets } = makeFactory();
    const g = useGame('g1', { wsFactory: factory });
    sockets[0]!.onmessage({ data: frame(1, beginEv()) });
    sockets[0]!.onmessage({
      data: frame(2, moveEv({ seq: 2, turn: 'red', move: { from: 'h3', to: 'e3' }, usage: usage5(0.003), elapsedMs: 2100 })),
    });
    sockets[0]!.onmessage({
      data: frame(3, moveEv({ seq: 3, turn: 'black', move: { from: 'h8', to: 'e8', notation: '炮8平5' }, usage: usage5(0.004), elapsedMs: 1800 })),
    });
    expect(g.costSummary.red.promptTokens).toBe(1000);
    expect(g.costSummary.red.completionTokens).toBe(120);
    expect(g.costSummary.red.costUsd).toBeCloseTo(0.003, 6);
    expect(g.costSummary.red.elapsedMs).toBe(2100);
    expect(g.costSummary.black.costUsd).toBeCloseTo(0.004, 6);
    expect(g.costSummary.total.costUsd).toBeCloseTo(0.007, 6);
    g.controls.destroy();
  });

  it('illegal-attempt:按方累计打回并记录 reason;finish:phase=finished + result', () => {
    const { factory, sockets } = makeFactory();
    const g = useGame('g1', { wsFactory: factory });
    sockets[0]!.onmessage({ data: frame(1, beginEv()) });
    const illegal: IllegalAttemptEvent = {
      seq: 2,
      ts: 't',
      type: 'illegal-attempt',
      side: 'red',
      round: 1,
      reason: '马被蹩腿',
      violations: { pre: 1, post: 0 },
      attempt: { text: '马二进三' },
    };
    sockets[0]!.onmessage({ data: frame(2, illegal) });
    expect(g.rejectCount.red).toBe(1);
    expect(g.rejections[0]!.reason).toBe('马被蹩腿');

    const finish: FinishEvent = {
      seq: 3,
      ts: 't',
      type: 'finish',
      winner: 'black',
      reason: 'illegal-moves',
      ruleViolations: { red: { pre: 2, post: 1 }, black: { pre: 0, post: 0 } },
    };
    sockets[0]!.onmessage({ data: frame(3, finish) });
    expect(g.phase).toBe('finished');
    expect(g.result?.winner).toBe('black');
    expect(g.result?.ruleViolations.red.total).toBe(3);
    g.controls.destroy();
  });

  it('player-message(thought)累积流式文本', () => {
    const { factory, sockets } = makeFactory();
    const g = useGame('g1', { wsFactory: factory });
    sockets[0]!.onmessage({ data: frame(1, beginEv()) });
    sockets[0]!.onmessage({ data: frame(2, { seq: 2, ts: 't', type: 'player-message', side: 'red', phase: 'thought', content: '先手' }) });
    sockets[0]!.onmessage({ data: frame(3, { seq: 3, ts: 't', type: 'player-message', side: 'red', phase: 'thought', content: '架中炮' }) });
    expect(g.liveThoughts.red).toBe('先手架中炮');
    g.controls.destroy();
  });

  it('同 seq 补发(seq ≤ lastSeq)不重复应用', () => {
    const { factory, sockets } = makeFactory();
    const g = useGame('g1', { wsFactory: factory });
    sockets[0]!.onmessage({ data: frame(1, beginEv()) });
    sockets[0]!.onmessage({ data: frame(2, moveEv({ seq: 2, turn: 'red', move: { from: 'h3', to: 'e3' } })) });
    // 重复补发同一步(seq=2)
    sockets[0]!.onmessage({ data: frame(2, moveEv({ seq: 2, turn: 'red', move: { from: 'h3', to: 'e3' } })) });
    expect(g.moves).toHaveLength(1);
    g.controls.destroy();
  });
it('review 事件入 state.review;usage 只归 total,不分方(T20)', () => {
    const { factory, sockets } = makeFactory();
    const g = useGame('g1', { wsFactory: factory });
    sockets[0]!.onmessage({ data: frame(1, beginEv()) });
    sockets[0]!.onmessage({
      data: frame(2, { seq: 2, ts: 't', type: 'review', summary: '红方中局抓住机会', keyPoints: ['中炮'], model: 'cm', elapsedMs: 3000, usage: { promptTokens: 600, completionTokens: 90, costUsd: 0.0024 } }),
    });
    expect(g.review?.summary).toBe('红方中局抓住机会');
    expect(g.review?.keyPoints).toEqual(['中炮']);
    expect(g.costSummary.total.costUsd).toBeCloseTo(0.0024, 6);
    expect(g.costSummary.total.elapsedMs).toBe(3000);
    expect(g.costSummary.red.costUsd).toBe(0);
    expect(g.costSummary.black.costUsd).toBe(0);
    g.controls.destroy();
  });

  it('重连成功后退避计数归零:连续两次断线重连,delay() 均从 attempt=0 起(T20)', async () => {
    vi.useFakeTimers();
    const attempts: number[] = [];
    const { factory, sockets } = makeFactory();
    const g = useGame('g1', { wsFactory: factory, reconnectDelayMs: (a) => { attempts.push(a); return 1; } });

    sockets[0]!.onopen(null); // 首次连上 → 归零
    sockets[0]!.close(); // 断线 → delay(0)
    await vi.runAllTimersAsync(); // 重连 #2
    expect(factory).toHaveBeenCalledTimes(2);

    sockets[1]!.onopen(null); // 二次连上 → 再次归零
    sockets[1]!.close(); // 再断 → 仍应从 0 起
    expect(attempts).toEqual([0, 0]); // 无归零时第二次会是 1

    g.controls.destroy();
    vi.useRealTimers();
  });
});

/* ---------- 断线重连 since 续传 ---------- */

describe('useGame 断线续传', () => {
  it('重连 url 携带 since=lastSeq;仅应用 > lastSeq 的补发帧', async () => {
    vi.useFakeTimers();
    const { factory, sockets } = makeFactory();
    const g = useGame('g1', { wsFactory: factory, reconnectDelayMs: () => 1 });

    sockets[0]!.onmessage({ data: frame(1, beginEv()) });
    sockets[0]!.onmessage({ data: frame(2, moveEv({ seq: 2, turn: 'red', move: { from: 'h3', to: 'e3' } })) });
    sockets[0]!.onmessage({ data: frame(3, moveEv({ seq: 3, turn: 'black', move: { from: 'h8', to: 'e8', notation: '炮8平5' } })) });
    expect(g.lastSeq).toBe(3);

    sockets[0]!.close(); // 断线
    expect(factory).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync(); // 触发重连

    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory.mock.calls[1]![0]).toContain('since=3');

    // 补发 seq=3(已应用)不重复走子;seq=4 应用
    sockets[1]!.onmessage({ data: frame(3, moveEv({ seq: 3, turn: 'black', move: { from: 'h8', to: 'e8' } })) });
    sockets[1]!.onmessage({ data: frame(4, moveEv({ seq: 4, turn: 'red', move: { from: 'b1', to: 'a3' } })) });
    expect(g.moves).toHaveLength(3);
    expect(g.board.find((p) => p.file === 0 && p.rank === 2)?.type).toBe('horse');
    g.controls.destroy();
    vi.useRealTimers();
  });

  it('GAME_NOT_FOUND 错误帧:phase=error、不无限重连', async () => {
    vi.useFakeTimers();
    const { factory, sockets } = makeFactory();
    const g = useGame('no-such', { wsFactory: factory, reconnectDelayMs: () => 1 });
    sockets[0]!.onmessage({ data: JSON.stringify({ seq: 0, event: { type: 'error', code: 'GAME_NOT_FOUND', message: '对局不存在' } }) });
    expect(g.phase).toBe('error');
    sockets[0]!.close();
    await vi.runAllTimersAsync();
    expect(factory).toHaveBeenCalledTimes(1); // 未重连
    g.controls.destroy();
    vi.useRealTimers();
  });

  it('controls: pause/resume/step 发 REST;pause 置本地 phase=paused', async () => {
    const { factory, sockets } = makeFactory();
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      const action = (init?.method ?? 'GET').toLowerCase();
      void action;
      return new Response(JSON.stringify({ id: 'g1', status: 'paused', moveCount: 1 }), { status: 200 });
    });
    const g = useGame('g1', { wsFactory: factory, fetcher: fetcher as unknown as typeof fetch });
    sockets[0]!.onmessage({ data: frame(1, beginEv()) });
    await g.controls.pause();
    expect(calls).toContain('/api/games/g1/pause');
    expect(g.phase).toBe('paused');
    await g.controls.resume();
    expect(calls).toContain('/api/games/g1/resume');
    expect(g.phase).toBe('running');
    await g.controls.step();
    expect(calls).toContain('/api/games/g1/step');
    g.controls.destroy();
  });

  it('G3 seq:0 的 player-message 帧不被丢弃、也不推进 lastSeq', () => {
    const { factory, sockets } = makeFactory();
    const g = useGame('g1', { wsFactory: factory });
    // server 实时流式:seq:0 player-message 帧在 begin(seq 1)之前/之后都可能到达
    sockets[0]!.onmessage({ data: JSON.stringify({ seq: 0, event: { seq: 0, ts: 't', type: 'player-message', side: 'red', phase: 'thought', content: '先手' } }) });
    expect(g.liveThoughts.red).toBe('先手');
    sockets[0]!.onmessage({ data: frame(1, beginEv()) });
    sockets[0]!.onmessage({ data: JSON.stringify({ seq: 0, event: { seq: 0, ts: 't', type: 'player-message', side: 'red', phase: 'thought', content: '架中炮' } }) });
    expect(g.liveThoughts.red).toBe('先手架中炮');
    // lastSeq 不被 seq:0 污染:随后 seq2 move 正常应用并推进到 2
    expect(g.lastSeq).toBe(1);
    sockets[0]!.onmessage({ data: frame(2, moveEv({ seq: 2, turn: 'red', move: { from: 'h3', to: 'e3' } })) });
    expect(g.lastSeq).toBe(2);
    expect(g.moves).toHaveLength(1);
    g.controls.destroy();
  });
});