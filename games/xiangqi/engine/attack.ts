import { cloneBoard, pieceAt, opposite, sqToCode, sqToIdx } from './board';
import type { Board, Side, Sq } from './board';
import { rawMovesFor, type Move } from './moves';

/** 找该方将/帅所在格子;棋盘上无则返回 null(视为非被将) */
function findGeneral(b: Board, side: Side): Sq | null {
  for (let i = 0; i < b.length; i++) {
    const p = b[i];
    if (p && p.side === side && p.type === 'general') return { file: i % 9, rank: Math.floor(i / 9) };
  }
  return null;
}

/**
 * 将帅照面:双方将帅同列且二者之间无任何棋子。
 * 纯几何判定,不要求将帅都在九宫内(原始阵形恒满足,恶意摆位也不妨)。
 */
export function isGeneralFacing(b: Board): boolean {
  const red = findGeneral(b, 'red');
  const black = findGeneral(b, 'black');
  if (!red || !black) return false;
  if (red.file !== black.file) return false;
  const lo = Math.min(red.rank, black.rank);
  const hi = Math.max(red.rank, black.rank);
  for (let r = lo + 1; r < hi; r++) {
    if (pieceAt(b, { file: red.file, rank: r }) !== null) return false;
  }
  return true;
}

/**
 * 该方是否处于被将军:
 * 1. 对方任一枚子的原始走法(rawMovesFor,不含送将递归)落在己方将/帅格;
 * 2. 或双方将帅照面(等价于将帅互攻)。
 */
export function isInCheck(b: Board, side: Side): boolean {
  const gen = findGeneral(b, side);
  if (gen === null) return false;
  const enemy: Side = opposite(side);
  for (let i = 0; i < b.length; i++) {
    const p = b[i];
    if (!p || p.side !== enemy) continue;
    const sq = { file: i % 9, rank: Math.floor(i / 9) };
    for (const m of rawMovesFor(b, sq, enemy)) {
      if (m.to.file === gen.file && m.to.rank === gen.rank) return true;
    }
  }
  return isGeneralFacing(b);
}

/**
 * 试走:基于克隆盘移动一枚棋子(吃子覆盖在 to、from 清空),返回新盘,不改原盘。
 * 不做任何合法性校验;from 无子时仅返回无变化的克隆盘。
 */
export function simulateApply(b: Board, move: Move): Board {
  const nb = cloneBoard(b);
  const fromIdx = sqToIdx(move.from.file, move.from.rank);
  const toIdx = sqToIdx(move.to.file, move.to.rank);
  nb[toIdx] = nb[fromIdx];
  nb[fromIdx] = null;
  return nb;
}

/** 严格版 simulateApply:from 必须存在棋子否则抛错。 */
export function requireApply(b: Board, move: Move): Board {
  if (pieceAt(b, move.from) === null) throw new Error(`requireApply: from 格无子 (${sqToCode(move.from)})`);
  return simulateApply(b, move);
}

/** 走法键:标准记谱 <from>-<to> 形式,如 "e5-c7"。 */
export const moveToKey = (m: Move): string => `${sqToCode(m.from)}-${sqToCode(m.to)}`;

/**
 * 合法走法:对某方全部棋子的 rawMovesFor 候选,逐个 simulateApply 后在“新盘”上
 * 又判断该方 isInCheck —— 为 false 的保留,从而滤掉「送将/自陷照面」。
 */
export function legalMoves(b: Board, side: Side): Move[] {
  const res: Move[] = [];
  for (let i = 0; i < b.length; i++) {
    const p = b[i];
    if (!p || p.side !== side) continue;
    const sq: Sq = { file: i % 9, rank: Math.floor(i / 9) };
    for (const m of rawMovesFor(b, sq, side)) {
      if (!isInCheck(simulateApply(b, m), side)) res.push(m);
    }
  }
  return res;
}