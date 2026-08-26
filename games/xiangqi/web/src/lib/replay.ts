//
// 回放纯函数库(Task 20) —— 绝无副作用、绝不触 arena 运行时。
// 事件数组 → 局面/履历/成本/结果等派生数据,以事件 `seq` 为轴(seq ≤ 目标即已发生)。
// 算法与实时 useGame 的重放同源:useGame 亦使用本模块的 applyMoveToPieces/isOnBoard,
// 确保「回放 vs 实时」零重演偏差(双跑 diff 的纯函数侧)。
//
import { codeToSq, type Side, type Sq } from '../../../engine/types';
import { initialBoard } from '../../../engine/board';
import type { GameEvent, Usage } from '../../../server/game-log';
import { recordsFromBoard, type PieceRec } from './board';

/* ---------- 公开类型 ---------- */

export interface UidPiece extends PieceRec {
  uid: string;
}

export interface ReplayMoveRecord {
  seq: number;
  turn: Side;
  from: Sq;
  to: Sq;
  moveCode: string; // 如 'h3-e3'
  notation?: string;
  analysis?: string;
  elapsedMs?: number;
  usage?: Usage;
}

export interface SideCostSnapshot {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  elapsedMs: number;
}

export interface CostSnapshot {
  red: SideCostSnapshot;
  black: SideCostSnapshot;
  total: SideCostSnapshot;
}

export interface SideViolationsSnapshot {
  pre: number;
  post: number;
  total: number;
}

export interface ResultSnapshot {
  winner: Side | 'draw';
  reason: string;
  ruleViolations: { red: SideViolationsSnapshot; black: SideViolationsSnapshot };
}

export interface ReviewSnapshot {
  summary: string;
  keyPoints?: string[];
  model?: string;
  elapsedMs?: number;
  usage?: Usage;
}

export interface SeqPoints {
  /** 时间轴锚点(seq):0 + 合法 move seq + finish seq(若有)。拖动/步进只落锚点。 */
  steps: number[];
  finishSeq: number | null;
}

/* ---------- 小工具 ---------- */

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export const isOnBoard = (s: Sq): boolean =>
  Number.isInteger(s.file) && Number.isInteger(s.rank) && s.file >= 0 && s.file < 9 && s.rank >= 0 && s.rank < 10;

const findAt = (list: UidPiece[], sq: Sq): number => list.findIndex((p) => p.file === sq.file && p.rank === sq.rank);

/* ---------- 初始局面(显式 uid,确定性;回放/实时一致) ---------- */

export function initialPiecesWithUid(): UidPiece[] {
  return recordsFromBoard(initialBoard()).map((p, i) => ({ ...p, uid: `${p.side}:${p.type}:${i}` }));
}

/* ---------- 走子应用(实时与回放共用同一条代码路径) ---------- */

export function applyMoveToPieces(listInput: UidPiece[], from: Sq, to: Sq, evtSeq: number, side: Side): UidPiece[] {
  const list = listInput.slice();
  const fromIdx = findAt(list, from);
  if (fromIdx < 0) {
    // 数据异常:起点未定位到子(极端/被篡改帧)→ 兜底新建,避免画板缺子
    list.push({ side, type: 'pawn', file: to.file, rank: to.rank, uid: `evt:${evtSeq}` });
    return list;
  }
  const mover = list.splice(fromIdx, 1)[0]!;
  const toIdx = findAt(list, to);
  if (toIdx >= 0) list.splice(toIdx, 1); // 吃子
  list.push({ ...mover, file: to.file, rank: to.rank });
  return list;
}

/* ---------- 局面重放:boardAt(seq) 纯函数 ---------- */

export function boardAt(events: GameEvent[], targetSeq: number): UidPiece[] {
  let board = initialPiecesWithUid();
  for (const e of events) {
    if (e.seq > targetSeq) break; // 事件按 seq 升序(append-only 日志语义)
    if (e.type !== 'move') continue; // begin/draw/finish/review/illegal-attempt/check… 均不动盘面
    if (e.legal === false) continue; // 非法留痕不入盘(与 useGame 一致)
    const from = codeToSq(e.move.from);
    const to = codeToSq(e.move.to);
    if (!isOnBoard(from) || !isOnBoard(to)) continue;
    board = applyMoveToPieces(board, from, to, e.seq, e.turn);
  }
  return board;
}

/* ---------- 时间轴锚点(seq 轴) ---------- */

export function seqPointsOf(events: GameEvent[]): SeqPoints {
  const steps: number[] = [0];
  let finishSeq: number | null = null;
  for (const e of events) {
    if (e.type === 'move' && e.legal !== false) steps.push(e.seq);
    else if (e.type === 'finish') finishSeq = e.seq;
  }
  if (finishSeq !== null) steps.push(finishSeq);
  steps.sort((a, b) => a - b);
  return { steps: [...new Set(steps)], finishSeq };
}

/** 下一锚点;已在末尾/越界返回 cur(无操作)。 */
export function nextSeq(steps: number[], cur: number): number {
  for (const s of steps) if (s > cur) return s;
  return cur;
}

/** 上一锚点;在起点返回 cur(无操作)。 */
export function prevSeq(steps: number[], cur: number): number {
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i]! < cur) return steps[i]!;
  return cur;
}

/* ---------- 派生数据(均为纯函数,seq 截止) ---------- */

export function movesAt(events: GameEvent[], targetSeq: number): ReplayMoveRecord[] {
  const out: ReplayMoveRecord[] = [];
  for (const e of events) {
    if (e.seq > targetSeq) break;
    if (e.type !== 'move' || e.legal === false) continue;
    const from = codeToSq(e.move.from);
    const to = codeToSq(e.move.to);
    if (!isOnBoard(from) || !isOnBoard(to)) continue;
    out.push({
      seq: e.seq,
      turn: e.turn,
      from,
      to,
      moveCode: `${e.move.from}-${e.move.to}`,
      notation: e.move.notation,
      analysis: e.analysis,
      elapsedMs: e.elapsedMs,
      usage: e.usage,
    });
  }
  return out;
}

export function costAt(events: GameEvent[], targetSeq: number): CostSnapshot {
  const zero = (): SideCostSnapshot => ({ promptTokens: 0, completionTokens: 0, costUsd: 0, elapsedMs: 0 });
  const red = zero();
  const black = zero();
  const total = zero();
  const fold = (sc: SideCostSnapshot, u: Usage, elapsed?: number): void => {
    sc.promptTokens += num(u.promptTokens);
    sc.completionTokens += num(u.completionTokens);
    sc.costUsd += num(u.costUsd);
    if (typeof elapsed === 'number' && Number.isFinite(elapsed)) sc.elapsedMs += elapsed;
  };
  for (const e of events) {
    if (e.seq > targetSeq) break;
    if (e.type === 'move' && e.usage) {
      const side = e.turn === 'red' ? red : black;
      fold(side, e.usage, e.elapsedMs);
      fold(total, e.usage, e.elapsedMs);
    } else if (e.type === 'review' && e.usage) {
      // 复盘成本无行棋方,只入总账(与 useGame 一致)
      fold(total, e.usage, e.elapsedMs);
    }
  }
  return { red, black, total };
}

export function rejectCountAt(events: GameEvent[], targetSeq: number): { red: number; black: number } {
  const c = { red: 0, black: 0 };
  for (const e of events) {
    if (e.seq > targetSeq) break;
    if (e.type === 'illegal-attempt') c[e.side] += 1;
  }
  return c;
}

export function resultAt(events: GameEvent[], targetSeq: number): ResultSnapshot | null {
  let out: ResultSnapshot | null = null;
  for (const e of events) {
    if (e.seq > targetSeq) continue;
    if (e.type !== 'finish') continue;
    const rv = e.ruleViolations;
    out = {
      winner: e.winner,
      reason: e.reason,
      ruleViolations: {
        red: { pre: num(rv?.red?.pre), post: num(rv?.red?.post), total: num(rv?.red?.pre) + num(rv?.red?.post) },
        black: { pre: num(rv?.black?.pre), post: num(rv?.black?.post), total: num(rv?.black?.pre) + num(rv?.black?.post) },
      },
    };
  }
  return out;
}

export function modelsAt(events: GameEvent[], targetSeq: number): { red?: string; black?: string } | null {
  let out: { red?: string; black?: string } | null = null;
  for (const e of events) {
    if (e.seq > targetSeq) continue;
    if (e.type === 'begin') out = { red: e.red?.model, black: e.black?.model };
  }
  return out;
}

/** 整局复盘摘要:只看事件里最后一个 review 事件(与当前 seq 无关,赛后才出现)。 */
export function reviewOf(events: GameEvent[]): ReviewSnapshot | null {
  let out: ReviewSnapshot | null = null;
  for (const e of events) {
    if (e.type !== 'review') continue;
    out = { summary: e.summary, keyPoints: e.keyPoints, model: e.model, elapsedMs: e.elapsedMs, usage: e.usage };
  }
  return out;
}