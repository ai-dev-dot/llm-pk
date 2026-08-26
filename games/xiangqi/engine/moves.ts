import type { Board, Side } from './board';
import { pieceAt } from './board';
import type { Sq } from './board';

export interface Move { from: Sq; to: Sq }

const inBoard = (file: number, rank: number): boolean =>
  file >= 0 && file < 9 && rank >= 0 && rank < 10;

const canOccupy = (b: Board, sq: Sq, side: Side): boolean => {
  const p = pieceAt(b, sq);
  return p === null || p.side !== side;
};

/**
 * 直线单向步进:沿 (df,dr) 方向一格一格走。
 * 遇空格并入;遇己方棋子停止且不含;遇敌方棋子含吃后停止;越界停止。
 * 供车/炮等直线棋种复用。
 */
export function lineMoves(b: Board, from: Sq, df: number, dr: number, side: Side): Move[] {
  const res: Move[] = [];
  let f = from.file + df;
  let r = from.rank + dr;
  while (inBoard(f, r)) {
    const p = pieceAt(b, { file: f, rank: r });
    if (p === null) {
      res.push({ from, to: { file: f, rank: r } });
    } else {
      if (p.side !== side) res.push({ from, to: { file: f, rank: r } });
      break;
    }
    f += df;
    r += dr;
  }
  return res;
}

/**
 * 直线路径(from 到 to 之间,不含端点)是否全空。
 * 仅支持水平 / 垂直 / 对角直线(供车/炮/象后续复用);from===to 返回 false。
 */
export function isPathClear(b: Board, from: Sq, to: Sq): boolean {
  const df = to.file - from.file;
  const dr = to.rank - from.rank;
  if (df === 0 && dr === 0) return false;
  if (df !== 0 && dr !== 0 && Math.abs(df) !== Math.abs(dr)) return false; // 非直线
  const len = Math.max(Math.abs(df), Math.abs(dr));
  const sf = df / len;
  const sr = dr / len;
  let f = from.file + sf;
  let r = from.rank + sr;
  while (f !== to.file || r !== to.rank) {
    if (pieceAt(b, { file: f, rank: r }) !== null) return false;
    f += sf;
    r += sr;
  }
  return true;
}

/** 红方 rank 递增,黑方递减 */
export const dirSideOf = (side: Side): number => (side === 'red' ? 1 : -1);

/**
 * 兵/卒:只能向对方方向前进;过河(红 rank>=5 / 黑 rank<=4)后方可横向 file±1;绝不后退。
 * 到对方底线后前进越界,仅余横走(即 classic 规则兵到底线只能横走)。
 */
export function pawnMoves(b: Board, sq: Sq, side: Side): Move[] {
  const d = dirSideOf(side);
  const res: Move[] = [];
  const fwd: Sq = { file: sq.file, rank: sq.rank + d };
  if (inBoard(fwd.file, fwd.rank) && canOccupy(b, fwd, side)) res.push({ from: sq, to: fwd });
  const crossed = side === 'red' ? sq.rank >= 5 : sq.rank <= 4;
  if (crossed) {
    for (const df of [-1, 1]) {
      const to: Sq = { file: sq.file + df, rank: sq.rank };
      if (inBoard(to.file, to.rank) && canOccupy(b, to, side)) res.push({ from: sq, to });
    }
  }
  return res;
}

const HORSE_STEPS: ReadonlyArray<readonly [number, number]> = [
  [1, 2], [-1, 2], [1, -2], [-1, -2],
  [2, 1], [-2, 1], [2, -1], [-2, -1],
];

/**
 * 马:走「日」。目标 = 起点 ±2 一格、另维 ±1。
 * 蹩腿:在 ±2 方向上,该维相邻一步位有子则不可跳
 * (file 方向 ±2 → 看 (file±1, 当前rank);rank 方向 ±2 → 看 (当前file, rank±1))。
 * 越界目标丢弃;目标格为敌方含吃、己方剔除。
 */
export function horseMoves(b: Board, sq: Sq, side: Side): Move[] {
  const res: Move[] = [];
  for (const [df, dr] of HORSE_STEPS) {
    const to: Sq = { file: sq.file + df, rank: sq.rank + dr };
    if (!inBoard(to.file, to.rank)) continue;
    const leg: Sq = Math.abs(df) === 2
      ? { file: sq.file + Math.sign(df), rank: sq.rank }
      : { file: sq.file, rank: sq.rank + Math.sign(dr) };
    if (pieceAt(b, leg) !== null) continue;
    if (!canOccupy(b, to, side)) continue;
    res.push({ from: sq, to });
  }
  return res;
}

/**
 * 某棋子的原始走法(不含送将校验,送将由后续任务过滤)。
 * - 该格无子或非本方棋子时返回 []。
 * - 目标格为敌方棋子可吃(并入结果),己方棋子剔除。
 * - threats 保留参数位(送将/照面过滤使用),本阶段忽略。
 */
export function rawMovesFor(b: Board, sq: Sq, side: Side, _threats?: unknown): Move[] {
  const p = pieceAt(b, sq);
  if (!p || p.side !== side) return [];
  switch (p.type) {
    case 'pawn': return pawnMoves(b, sq, side);
    case 'horse': return horseMoves(b, sq, side);
    default: return [];   // 其余棋种由后续任务实现
  }
}