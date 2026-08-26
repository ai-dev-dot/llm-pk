//
// 前端板型工具:90 长数组 Board(engine) ↔ {side,type,file,rank} 记录数组。
// 只做数据形状转发(单一来源仍是 engine);不在此实现任何引擎规则。
//
import type { Board } from '../../../engine/board';
import type { PieceType, Side } from '../../../engine/types';

/** 单子记录:任意排序的棋子数组,file 0..8 / rank 0..9(engine 坐标)。 */
export interface PieceRec {
  side: Side;
  type: PieceType;
  file: number; // 0..8(列 a..i)
  rank: number; // 0..9(0=红底,9=黑顶)
}

/** 组件 `pieces` prop 的两种可接受形态。 */
export type PiecesInput = PieceRec[] | Board;

/** `idx = rank*9 + file`(与 engine/board.ts 一致)。 */
export const sqIdx = (file: number, rank: number): number => rank * 9 + file;

/** 90 长数组(恒长 90,空位 null)→ 记录数组。 */
export function recordsFromBoard(board: Board): PieceRec[] {
  const out: PieceRec[] = [];
  board.forEach((p, idx) => {
    if (p) out.push({ side: p.side, type: p.type, file: idx % 9, rank: Math.floor(idx / 9) });
  });
  return out;
}

/**
 * 形状判别:90 长数组视为 Board;否则视为记录数组。
 * 一局至多 32 子,记录数组不可能长度为 90,故以长度判别是安全的。
 */
export function isBoardArray(v: unknown): v is Board {
  return Array.isArray(v) && v.length === 90;
}

/** 统一为记录数组。 */
export function normalizePieces(input: PiecesInput): PieceRec[] {
  return isBoardArray(input) ? recordsFromBoard(input) : (input as PieceRec[]);
}