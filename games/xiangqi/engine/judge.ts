import { legalMoves, isInCheck } from './moves';
import type { Board, Side } from './board';

export type Phase = 'ongoing' | 'check' | 'checkmate' | 'stalemate';

/**
 * 局面分类(仅作分类;胜负推导由裁判层/后续任务负责):
 * - legalMoves 为空且被将军 → 'checkmate'(将死)
 * - legalMoves 为空且未被将军 → 'stalemate'(困毙——中国象棋困毙为负,但此处只分类)
 * - 有合法走且被将军 → 'check'
 * - 有合法走且未被将军 → 'ongoing'
 */
export function classify(b: Board, side: Side): Phase {
  const hasMoves = legalMoves(b, side).length > 0;
  const inCheck = isInCheck(b, side);
  if (!hasMoves) return inCheck ? 'checkmate' : 'stalemate';
  return inCheck ? 'check' : 'ongoing';
}