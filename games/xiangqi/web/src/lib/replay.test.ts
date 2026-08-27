//
// 回放纯函数(Task 20)测试:
// - boardAt(events, k) 从事件列表反推局面,与实时 useGame 逐事件累加一致(双跑 diff 的纯函数侧);
// - moveSeqPoints / nextSeq / prevSeq 为时间轴(seq 轴)提供快照点;
// - movesAt / costAt / rejectCountAt / resultAt / reviewOf / modelsAt 派生数据与 useGame 状态对齐。
//
import { describe, expect, it, vi } from 'vitest';
import {
  applyMoveToPieces,
  boardAt,
  costAt,
  initialPiecesWithUid,
  modelsAt,
  movesAt,
  nextSeq,
  prevSeq,
  rejectCountAt,
  resultAt,
  reviewOf,
  seqPointsOf,
  type UidPiece,
} from './replay';
import { useGame } from '../composables/useGame';
import { recordsFromBoard } from './board';
import { initialBoard } from '../../../engine/board';
import { codeToSq } from '../../../engine/types';
import type { BeginEvent, FinishEvent, GameEvent, MoveEvent, ReviewEvent, Usage } from '../../../server/game-log';
import type { Side } from '../../../engine/types';

/* ---------- 事件构造(与 useGame 测试同坐标约定) ---------- */

const usage = (costUsd = 0.003, prompt = 1000, comp = 120): Usage => ({ promptTokens: prompt, completionTokens: comp, costUsd });

function replayEvents(): GameEvent[] {
  const begin: BeginEvent = {
    seq: 1,
    ts: 't',
    type: 'begin',
    gameId: 'g1',
    first: 'red',
    red: { model: 'mR' },
    black: { model: 'mB' },
    rules: { drawRepeat: 3, illegalAttemptsLimit: 3, maxTotalMoves: 200, networkRetries: 3, timeoutMs: 120000, carrySelfAnalysisN: 6, contextBudgetTokens: 32000 },
  };
  const m = (seq: number, turn: Side, from: string, to: string, extra: Partial<MoveEvent> = {}): MoveEvent =>
    ({ seq, ts: 't', type: 'move', turn, move: { from, to, notation: `${from}-${to}` }, legal: true, ...extra }) as MoveEvent;

  return [
    begin,
    m(2, 'red', 'h3', 'e3', { analysis: '架中炮', elapsedMs: 2000, usage: usage(0.003) }),
    m(3, 'black', 'h8', 'e8', { elapsedMs: 1800, usage: usage(0.004) }),
    m(4, 'red', 'e4', 'e7', { elapsedMs: 2400, usage: usage(0.001, 500, 60) }), // 红兵吃黑卒(4,3)→(4,6)
    { seq: 5, ts: 't', type: 'review', summary: '红方中局兑子后取得胜势', keyPoints: ['中局兑子', '残局取胜'], model: 'review-m', elapsedMs: 3000, usage: usage(0.0024, 600, 90) } as ReviewEvent,
    { seq: 6, ts: 't', type: 'illegal-attempt', side: 'black', round: 1, reason: '马被蹩腿', violations: { pre: 0, post: 1 }, attempt: { text: '马2进3' } },
    m(7, 'red', 'b1', 'a3', { legal: false }), // 非法帧:两个链路都应跳过、不入盘
    m(8, 'black', 'g7', 'g6', { elapsedMs: 1200, usage: usage(0.002, 400, 50) }), // 黑卒(6,6)→(6,5)
    { seq: 9, ts: 't', type: 'finish', winner: 'red', reason: 'checkmate', ruleViolations: { red: { pre: 0, post: 0 }, black: { pre: 0, post: 1 } } } as FinishEvent,
  ];
}

/** 期望时间轴步点:[0, 合法 move seq, finish seq]。seq7 非法不入。 */
const STEP_SEQS = [0, 2, 3, 4, 8, 9];

/* ---------- fake WS(供与 useGame 双跑 diff) ---------- */

interface FakeWs {
  url: string;
  onopen: (ev: unknown) => void;
  onmessage: (ev: { data: unknown }) => void;
  onclose: (ev: unknown) => void;
  onerror: (ev: unknown) => void;
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
      close: () => ws.onclose(null),
    };
    sockets.push(ws);
    return ws;
  });
  return { factory, sockets };
}

const frame = (seq: number, event: unknown) => JSON.stringify({ seq, event });

describe('boardAt —— 纯函数重放', () => {
  it('初始:boardAt(events, 0) 即 32 子初始局面', () => {
    const b = boardAt(replayEvents(), 0);
    expect(b).toHaveLength(recordsFromBoard(initialBoard()).length);
    expect(b).toEqual(initialPiecesWithUid());
  });

  it('与逐事件累加一致:任意步点 boardAt(k) === applyMoveToPieces 手工累加结果', () => {
    const evts = replayEvents();
    for (const t of STEP_SEQS) {
      let acc: UidPiece[] = initialPiecesWithUid();
      for (const e of evts) {
        if (e.seq > t) break;
        if (e.type !== 'move' || e.legal === false) continue;
        acc = applyMoveToPieces(acc, codeToSq(e.move.from), codeToSq(e.move.to), e.seq, e.turn);
      }
      expect(boardAt(evts, t)).toEqual(acc);
    }
  });

  it('与 useGame 实时累加一致(双跑 diff):逐事件推入 WS,boardAt(g.events, seq) ≡ g.board', () => {
    const { factory, sockets } = makeFactory();
    const g = useGame('g1', { wsFactory: factory });
    for (const e of replayEvents()) {
      sockets[0]!.onmessage({ data: frame(e.seq, e) });
      expect(boardAt(g.events, e.seq)).toEqual(g.board);
    }
    // 吃子一次(seq4):32 - 1 = 31
    expect(g.board).toHaveLength(31);
    expect(boardAt(g.events, 4)).toHaveLength(31);
    g.controls.destroy();
  });

  it('cutoff:boardAt 只应用 seq ≤ 目标 的合法 move;review/illegal-attempt/finish 均不动盘面', () => {
    const evts = replayEvents();
    const end = boardAt(evts, 9);
    expect(end).toHaveLength(31);
    // review(5) 与 illegal-attempt(6) 之间盘面不变
    expect(boardAt(evts, 5)).toEqual(boardAt(evts, 6));
    // finish(9) 不改盘面(终局盘面 = 最后一步后)
    expect(boardAt(evts, 8)).toEqual(boardAt(evts, 9));
    // 非法 move(7) 不改盘面
    expect(boardAt(evts, 7)).toEqual(boardAt(evts, 6));
  });
});

describe('seqPointsOf / nextSeq / prevSeq —— seq 时间轴', () => {
  it('步点 = [0, 合法 move seq, finish seq];非法帧不入', () => {
    const sp = seqPointsOf(replayEvents());
    expect(sp.steps).toEqual(STEP_SEQS);
    expect(sp.finishSeq).toBe(9);
  });

  it('空事件:steps=[0], finish=null', () => {
    expect(seqPointsOf([])).toEqual({ steps: [0], finishSeq: null });
  });

  it('nextSeq / prevSeq:前后快照点(端点不发生越界)', () => {
    const steps = STEP_SEQS;
    expect(nextSeq(steps, 0)).toBe(2);
    expect(nextSeq(steps, 4)).toBe(8);
    expect(nextSeq(steps, 9)).toBe(9); // 端点无 next
    expect(prevSeq(steps, 8)).toBe(4);
    expect(prevSeq(steps, 3)).toBe(2);
    expect(prevSeq(steps, 0)).toBe(0); // 起点无 prev
    expect(prevSeq(steps, 7)).toBe(4); // 落在两点之间取前
  });
});

describe('movesAt / costAt / rejectCountAt / resultAt / modelsAt / reviewOf —— 派生数据', () => {
  it('movesAt:仅合法 move、按 seq 截止;从/to 转坐标', () => {
    const ms = movesAt(replayEvents(), 4);
    expect(ms).toHaveLength(3);
    expect(ms[0]!.turn).toBe('red');
    expect(ms[0]!.from).toEqual({ file: 7, rank: 2 });
    expect(ms[0]!.to).toEqual({ file: 4, rank: 2 });
    expect(ms[1]!.notation).toBe('h8-e8');
    expect(ms[2]!.moveCode).toBe('e4-e7');
    // 非法帧(7)不入、review(5)不是 move
    expect(movesAt(replayEvents(), 9)).toHaveLength(4);
  });

  it('costAt:move 分方累计、review 只入总账;按 seq 截止', () => {
    const c4 = costAt(replayEvents(), 4);
    expect(c4.red.costUsd).toBeCloseTo(0.004, 6); // 0.003 + 0.001
    expect(c4.black.costUsd).toBeCloseTo(0.004, 6); // 0.004
    expect(c4.total.costUsd).toBeCloseTo(0.008, 6); // review(5) 未计入
    expect(c4.red.elapsedMs).toBe(2000 + 2400);
    expect(c4.red.promptTokens).toBe(1500);

    const c9 = costAt(replayEvents(), 9);
    expect(c9.black.costUsd).toBeCloseTo(0.006, 6); // 0.004 + 0.002
    expect(c9.total.costUsd).toBeCloseTo(0.0124, 6); // + review 0.0024
  });

  it('costAt 与 useGame.costSummary 对齐', () => {
    const { factory, sockets } = makeFactory();
    const g = useGame('g1', { wsFactory: factory });
    for (const e of replayEvents()) sockets[0]!.onmessage({ data: frame(e.seq, e) });
    expect(costAt(g.events, g.lastSeq)).toEqual(g.costSummary);
    expect(g.costSummary.total.costUsd).toBeCloseTo(0.0124, 6);
    expect(g.costSummary.red.costUsd).toBeCloseTo(0.004, 6); // review 不入红方
    g.controls.destroy();
  });

  it('rejectCountAt / resultAt / modelsAt / reviewOf', () => {
    const evts = replayEvents();
    expect(rejectCountAt(evts, 6)).toEqual({ red: 0, black: 1 });
    expect(rejectCountAt(evts, 5)).toEqual({ red: 0, black: 0 });
    expect(resultAt(evts, 8)).toBeNull();
    expect(resultAt(evts, 9)?.winner).toBe('red');
    expect(resultAt(evts, 9)?.reason).toBe('checkmate');
    expect(resultAt(evts, 9)?.ruleViolations.black.total).toBe(1);
    expect(modelsAt(evts, 0)).toBeNull();
    expect(modelsAt(evts, 2)).toEqual({ red: 'mR', black: 'mB' });
    expect(reviewOf(evts)?.summary).toBe('红方中局兑子后取得胜势');
    expect(reviewOf(evts)?.keyPoints).toEqual(['中局兑子', '残局取胜']);
  });
});