import { describe, it, expect } from 'vitest';
import { classify } from './judge';
import { isInCheck, legalMoves } from './moves';
import { initialBoard, codeToSq, sqToIdx, opposite } from './board';
import type { Board, Piece } from './board';

// 构造测试局面:90 长空盘,按 { 坐标代码: 棋子 } 放子(与 moves/attack 测试一致)
function emptyWith(records: Record<string, Piece>): Board {
  const b: Board = new Array<Piece | null>(90).fill(null);
  for (const [code, piece] of Object.entries(records)) {
    const sq = codeToSq(code);
    b[sqToIdx(sq.file, sq.rank)] = { ...piece };
  }
  return b;
}

// 镜像公证helper:格子 (f,r) → (8-f,9-r),side 互换,type 同
function mirror(b: Board): Board {
  const nb: Board = new Array<Piece | null>(90).fill(null);
  for (let idx = 0; idx < b.length; idx++) {
    const p = b[idx];
    if (!p) continue;
    const file = idx % 9;
    const rank = Math.floor(idx / 9);
    nb[sqToIdx(8 - file, 9 - rank)] = { side: opposite(p.side), type: p.type };
  }
  return nb;
}

// 真正将死的局面(核验修正 brief「双车锁 e 线」铅笔示例,brief 样例如按真实规则不构成将死):
//
//   e1 红帅;d1/f1/e2 三红卒把九宫内的所有相邻格封死;
//   e10 黑炮隔 e2 卒(恰一炮架)直打 e1 → 红被将;
//   红仅存的走法(e1 己方无子可吃、三卒前进一步)皆仍被将(炮架恒存,e2 卒移 e3 仍是惟一架)
//   → legalMoves 为空且 isInCheck 为真 → checkmate。
function mateBoard(): Board {
  return emptyWith({
    e1: { side: 'red', type: 'general' },
    d1: { side: 'red', type: 'pawn' },
    f1: { side: 'red', type: 'pawn' },
    e2: { side: 'red', type: 'pawn' },
    e10: { side: 'black', type: 'cannon' },
  });
}

// 困毙局面:红帅 e1 未被将军,但三个可退点全被黑车攻击——
//   d1(黑车 d2 控)、e2(黑车 d2 控)、f1(黑车 f3 控);红仅帅一子 → 无合法走 → stalemate。
function staleBoard(): Board {
  return emptyWith({
    e1: { side: 'red', type: 'general' },
    d2: { side: 'black', type: 'rook' },
    f3: { side: 'black', type: 'rook' },
  });
}

describe('classify(局面分类:将死 / 困毙 / 将军 / 进行中)', () => {
  it('将死:红帅被黑炮隔己卒将军,且帅被己方兵封死 → checkmate', () => {
    const b = mateBoard();
    expect(isInCheck(b, 'red')).toBe(true);
    expect(legalMoves(b, 'red')).toHaveLength(0);
    expect(classify(b, 'red')).toBe('checkmate');
  });
  it('镜像公证:同一布局换色后黑方同样被将死 → checkmate', () => {
    expect(classify(mirror(mateBoard()), 'black')).toBe('checkmate');
  });
  it('困毙:帅无合法走但未被将军 → stalemate(判负语义由裁判层处理)', () => {
    const b = staleBoard();
    expect(isInCheck(b, 'red')).toBe(false);
    expect(legalMoves(b, 'red')).toHaveLength(0);
    expect(classify(b, 'red')).toBe('stalemate');
  });
  it('镜像公证:困毙布局换色后黑方同样困毙 → stalemate', () => {
    expect(classify(mirror(staleBoard()), 'black')).toBe('stalemate');
  });
  it('将军:已被将军但有脱身着法 → check', () => {
    const b = emptyWith({ e1: { side: 'red', type: 'general' }, e10: { side: 'black', type: 'rook' } });
    expect(classify(b, 'red')).toBe('check');
  });
  it('进行中:标准初始布局红黑双方均非被将 → ongoing', () => {
    expect(classify(initialBoard(), 'red')).toBe('ongoing');
    expect(classify(initialBoard(), 'black')).toBe('ongoing');
  });
  it('核验修正:brief 铅笔样例「双车锁 e 线」按真实规则不构成将死,应为 ongoing', () => {
    // f10/h10 双车既不在 e 线也不攻击 e1;红帅可横移 d1/f1 脱险 → 并未被将
    const b = emptyWith({
      e1: { side: 'red', type: 'general' },
      e2: { side: 'red', type: 'pawn' },
      f10: { side: 'black', type: 'rook' },
      h10: { side: 'black', type: 'rook' },
    });
    expect(isInCheck(b, 'red')).toBe(false);
    expect(classify(b, 'red')).toBe('ongoing');
  });
});