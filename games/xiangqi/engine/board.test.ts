import { describe, it, expect } from 'vitest';
import { initialBoard, pieceAt, cloneBoard, opposite, codeToSq, sqToCode } from './board';
import type { Board, Piece, Side } from './board';
import { sqToIdx } from './board';

// 构造测试局面:空棋盘上在指定 sq 放子
const emptyWith = (entries: Array<[string, Side | 'null']>): Board => {
  const b: Board = new Array<Piece | null>(90).fill(null);
  for (const [code, v] of entries) {
    if (v === 'null') continue;
    const sq = codeToSq(code);
    b[sqToIdx(sq.file, sq.rank)] = { side: v, type: sq.rank <= 4 ? 'general' : 'pawn' };
  }
  return b;
};

describe('初始布局 Board', () => {
  it('初始布局:红帅于e1,红炮于b3/h3,黑将e10,兵近河界', () => {
    const b = initialBoard();
    expect(pieceAt(b, codeToSq('e1'))).toEqual({ side: 'red', type: 'general' });
    expect(pieceAt(b, codeToSq('b3'))).toEqual({ side: 'red', type: 'cannon' });
    expect(pieceAt(b, codeToSq('h3'))).toEqual({ side: 'red', type: 'cannon' });
    expect(pieceAt(b, codeToSq('e10'))!.side).toBe('black');
    expect(pieceAt(b, codeToSq('a4'))!.side).toBe('red');   // 红兵 b4,d4,f4,h4,a? 兵在行4
  });

  it('红方底线 rank0 为 車馬相仕帥仕相馬車', () => {
    const b = initialBoard();
    const bottom: Array<[string, string]> = [
      ['a1', 'rook'], ['b1', 'horse'], ['c1', 'elephant'], ['d1', 'advisor'], ['e1', 'general'],
      ['f1', 'advisor'], ['g1', 'elephant'], ['h1', 'horse'], ['i1', 'rook'],
    ];
    for (const [code, type] of bottom) {
      expect(pieceAt(b, codeToSq(code))).toEqual({ side: 'red', type });
    }
    // 红炮在 b3/h3
    expect(pieceAt(b, codeToSq('b3'))).toEqual({ side: 'red', type: 'cannon' });
    expect(pieceAt(b, codeToSq('h3'))).toEqual({ side: 'red', type: 'cannon' });
    // 红兵在 a4,c4,e4,g4,i4(阵中遇中文"兵在行4",file 偶数列)
    for (const f of ['a', 'c', 'e', 'g', 'i']) {
      expect(pieceAt(b, codeToSq(f + '4'))).toEqual({ side: 'red', type: 'pawn' });
    }
  });

  it('黑方为红方上下镜像:底线 rank9,炮 rank7,卒 rank6', () => {
    const b = initialBoard();
    const bottom: Array<[string, string]> = [
      ['a10', 'rook'], ['b10', 'horse'], ['c10', 'elephant'], ['d10', 'advisor'], ['e10', 'general'],
      ['f10', 'advisor'], ['g10', 'elephant'], ['h10', 'horse'], ['i10', 'rook'],
    ];
    for (const [code, type] of bottom) {
      expect(pieceAt(b, codeToSq(code))).toEqual({ side: 'black', type });
    }
    expect(pieceAt(b, codeToSq('b8'))).toEqual({ side: 'black', type: 'cannon' });
    expect(pieceAt(b, codeToSq('h8'))).toEqual({ side: 'black', type: 'cannon' });
    for (const f of ['a', 'c', 'e', 'g', 'i']) {
      expect(pieceAt(b, codeToSq(f + '7'))).toEqual({ side: 'black', type: 'pawn' });
    }
  });

  it('棋盘恰 90 格,双方各 16 子,其余为空', () => {
    const b = initialBoard();
    expect(b).toHaveLength(90);
    const red = b.filter(p => p?.side === 'red').length;
    const black = b.filter(p => p?.side === 'black').length;
    const empty = b.filter(p => p === null).length;
    expect(red).toBe(16);
    expect(black).toBe(16);
    expect(empty).toBe(90 - 32);
    // 空位读取返回 null
    expect(pieceAt(b, codeToSq('d5'))).toBeNull();
  });

  it('cloneBoard 深拷贝:改副本不影响原局', () => {
    const b = initialBoard();
    const c = cloneBoard(b);
    expect(c).toEqual(b);
    const target = sqToIdx(codeToSq('d5').file, codeToSq('d5').rank);
    c[target] = { side: 'red', type: 'pawn' };
    expect(c[target]).toEqual({ side: 'red', type: 'pawn' });
    expect(b[target]).toBeNull();
  });

  it('opposite 互换双方', () => {
    expect(opposite('red' as Side)).toBe('black');
    expect(opposite('black' as Side)).toBe('red');
  });

  it('emptyWith 辅助组装测试局面', () => {
    const b = emptyWith([['e1', 'red'], ['e10', 'black'], ['d5', 'null']]);
    expect(pieceAt(b, codeToSq('e1'))).not.toBeNull();
    expect(pieceAt(b, codeToSq('e10'))).not.toBeNull();
    expect(pieceAt(b, codeToSq('d5'))).toBeNull();
    expect(pieceAt(b, codeToSq('a4'))).toBeNull();
  });
});