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
/** 九宫:file 3..5;红 rank 0..2、黑 rank 7..9 */
const inPalace = (file: number, rank: number, side: Side): boolean => {
  if (file < 3 || file > 5) return false;
  return side === 'red' ? rank >= 0 && rank <= 2 : rank >= 7 && rank <= 9;
};

const ELEPHANT_STEPS: ReadonlyArray<readonly [number, number]> = [
  [2, 2], [-2, 2], [2, -2], [-2, -2],
];

/**
 * 象/相:沿对角线跳两格(±2,±2)。
 * 塞象眼:途经的对角中点(Δ±1,±1)有子则不可跳。
 * 不得过河:红相目标 rank<=4,黑象目标 rank>=5(留在己侧 5 行)。
 * 越界目标丢弃;目标格为敌方含吃、己方剔除。
 */
export function elephantMoves(b: Board, sq: Sq, side: Side): Move[] {
  const res: Move[] = [];
  for (const [df, dr] of ELEPHANT_STEPS) {
    const eye: Sq = { file: sq.file + df / 2, rank: sq.rank + dr / 2 };
    if (pieceAt(b, eye) !== null) continue;                 // 塞象眼
    const to: Sq = { file: sq.file + df, rank: sq.rank + dr };
    if (!inBoard(to.file, to.rank)) continue;
    if (side === 'red' && to.rank > 4) continue;            // 红相不过河
    if (side === 'black' && to.rank < 5) continue;          // 黑象不过河
    if (!canOccupy(b, to, side)) continue;
    res.push({ from: sq, to });
  }
  return res;
}

const ADVISOR_STEPS: ReadonlyArray<readonly [number, number]> = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
];

/**
 * 士/仕:在己方九宫内沿对角线走一步(±1,±1)。
 * 越出九宫/棋盘的目标丢弃;目标格为敌方含吃、己方剔除。
 */
export function advisorMoves(b: Board, sq: Sq, side: Side): Move[] {
  const res: Move[] = [];
  for (const [df, dr] of ADVISOR_STEPS) {
    const to: Sq = { file: sq.file + df, rank: sq.rank + dr };
    if (!inPalace(to.file, to.rank, side)) continue;
    if (!canOccupy(b, to, side)) continue;
    res.push({ from: sq, to });
  }
  return res;
}

const GENERAL_STEPS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

/**
 * 帅/将:在己方九宫内直走一步(仅横/竖,不可斜向)。
 * 将帅照面否决由后续送将任务处理,本函数只按九宫+直一步生成。
 * 越出九宫/棋盘的目标丢弃;目标格为敌方含吃、己方剔除。
 */
export function generalMoves(b: Board, sq: Sq, side: Side): Move[] {
  const res: Move[] = [];
  for (const [df, dr] of GENERAL_STEPS) {
    const to: Sq = { file: sq.file + df, rank: sq.rank + dr };
    if (!inPalace(to.file, to.rank, side)) continue;
    if (!canOccupy(b, to, side)) continue;
    res.push({ from: sq, to });
  }
  return res;
}

const ROOK_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

/**
 * 车:沿横/竖四个方向直线行走。
 * 复用 lineMoves:空格并入;遇己方停止且不含;遇敌方含吃后停止;越界停止。
 * 无蹩腿/射程限制。结果为原始走法(送将等由后续任务过滤)。
 */
export function rookMoves(b: Board, sq: Sq, side: Side): Move[] {
  return ROOK_DIRS.flatMap(([df, dr]) => lineMoves(b, sq, df, dr, side));
}

/**
 * 炮:沿横/竖四方向直线扫描。
 * - 遇到第一个炮架前:所有空位均为非吃走法(与 isPathClear 语义一致,但自行扫描以计炮架与目标)。
 * - 越过第一个炮架后:其后的第一个子若为敌方则可吃(恰好一架语义);己方不可吃;
 *   无论吃否,遇到该子后即停(不越第二个架子)。
 * - 炮架本身不可作为落点;架后空位亦不可落。
 */
export function cannonMoves(b: Board, sq: Sq, side: Side): Move[] {
  const res: Move[] = [];
  for (const [df, dr] of ROOK_DIRS) {
    let f = sq.file + df;
    let r = sq.rank + dr;
    let crossed = false;   // 是否已越过第一个炮架
    while (inBoard(f, r)) {
      const p = pieceAt(b, { file: f, rank: r });
      if (!crossed) {
        if (p === null) {
          res.push({ from: sq, to: { file: f, rank: r } });   // 空走
        } else {
          crossed = true;   // 记下第一个炮架,不落此格
        }
      } else if (p !== null) {
        if (p.side !== side) res.push({ from: sq, to: { file: f, rank: r } });  // 恰一架后吃敌
        break;   // 遇到架后第一个子,无论吃否均停止
      }
      f += df;
      r += dr;
    }
  }
  return res;
}

export function rawMovesFor(b: Board, sq: Sq, side: Side, _threats?: unknown): Move[] {
  const p = pieceAt(b, sq);
  if (!p || p.side !== side) return [];
  switch (p.type) {
    case 'rook': return rookMoves(b, sq, side);
    case 'cannon': return cannonMoves(b, sq, side);
    case 'horse': return horseMoves(b, sq, side);
    case 'elephant': return elephantMoves(b, sq, side);
    case 'advisor': return advisorMoves(b, sq, side);
    case 'general': return generalMoves(b, sq, side);
    case 'pawn': return pawnMoves(b, sq, side);
  }
}