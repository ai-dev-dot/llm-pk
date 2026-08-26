import { PieceType, Side, Sq, codeToSq, sqToCode, sqKey } from './types';

// 重新导出坐标体系等类型工具,便于测试/上层单点 import
export { PieceType, Side, Sq, codeToSq, sqToCode, sqKey } from './types';

export interface Piece { side: Side; type: PieceType }
export type Board = (Piece | null)[];   // 恒长 90

export const BOARD_SIZE = 90;

// 索引 idx = rank*9 + file;file 0..8(列a..i),rank 0..9(行1..10)
export const sqToIdx = (file: number, rank: number): number => rank * 9 + file;

const emptyBoard = (): Board => new Array<Piece | null>(BOARD_SIZE).fill(null);

const RED_BOTTOM: PieceType[] = ['rook', 'horse', 'elephant', 'advisor', 'general', 'advisor', 'elephant', 'horse', 'rook'];

/**
 * 标准初始布局:
 * 红 rank0 底线 車馬相仕帥仕相馬車,炮在 rank2 的 file1/7,兵在 rank3 的 file0/2/4/6/8;
 * 黑方上下镜像:rank9 底线,炮 rank7,卒 rank6。
 */
export function initialBoard(): Board {
  const b = emptyBoard();
  for (let f = 0; f < 9; f++) {
    b[sqToIdx(f, 0)] = { side: 'red', type: RED_BOTTOM[f] };
    b[sqToIdx(f, 9)] = { side: 'black', type: RED_BOTTOM[f] };
  }
  for (const f of [1, 7]) {
    b[sqToIdx(f, 2)] = { side: 'red', type: 'cannon' };
    b[sqToIdx(f, 7)] = { side: 'black', type: 'cannon' };
  }
  for (const f of [0, 2, 4, 6, 8]) {
    b[sqToIdx(f, 3)] = { side: 'red', type: 'pawn' };
    b[sqToIdx(f, 6)] = { side: 'black', type: 'pawn' };
  }
  return b;
}

/** 读取某格子的棋子;空位返回 null */
export function pieceAt(b: Board, sq: Sq): Piece | null {
  return b[sqToIdx(sq.file, sq.rank)] ?? null;
}

/** 复制局面(数组浅拷贝;Piece 视为不可变) */
export function cloneBoard(b: Board): Board {
  return [...b];
}

/** 返回对家 */
export function opposite(side: Side): Side {
  return side === 'red' ? 'black' : 'red';
}