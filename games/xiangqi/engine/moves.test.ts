import { describe, it, expect } from 'vitest';
import { rawMovesFor, isPathClear, lineMoves } from './moves';
import { initialBoard, sqToIdx } from './board';
import { codeToSq, sqToCode } from './board';
import type { Board, Piece, Side } from './board';

// 构造测试局面:90 长空盘,按 { 坐标代码: 棋子 } 放子(与 brief 一致的 Record 对象形式)
function emptyWith(records: Record<string, Piece>): Board {
  const b: Board = new Array<Piece | null>(90).fill(null);
  for (const [code, piece] of Object.entries(records)) {
    const sq = codeToSq(code);
    b[sqToIdx(sq.file, sq.rank)] = { ...piece };
  }
  return b;
}

const moves = (b: Board, code: string, side: Side): string[] =>
  rawMovesFor(b, codeToSq(code), side).map(m => sqToCode(m.to));

describe('兵(pawn)走法', () => {
  it('红兵未过河只能前进;过河后可前进+横走,绝不后退', () => {
    // 建单子小棋盘:红兵 a5(rank4) — 未过河(河界在 rank4/5 之间;红兵 rank<5 尚未过河)
    const board = emptyWith({ 'a5': { side: 'red', type: 'pawn' } });
    expect(moves(board, 'a5', 'red')).toEqual(['a6']);          // 只能前进
    const board2 = emptyWith({ 'a6': { side: 'red', type: 'pawn' } }); // 已过河(rank>=5)
    expect(moves(board2, 'a6', 'red').sort()).toEqual(['a7', 'b6']);   // 前进+横走;a5 为后退,禁止
  });
  it('红兵到底线 rank9 后仅能横走', () => {
    const board = emptyWith({ 'a10': { side: 'red', type: 'pawn' } });
    expect(moves(board, 'a10', 'red')).toEqual(['b10']);        // 前进越界,仅横走
  });
  it('黑卒方向相反:未过河仅推进;过河后可横走;到底线 rank0 仅横走', () => {
    const board = emptyWith({ 'a9': { side: 'black', type: 'pawn' } });  // rank8 未过河(黑 rank<=4 才算过河)
    expect(moves(board, 'a9', 'black')).toEqual(['a8']);
    const board2 = emptyWith({ 'a5': { side: 'black', type: 'pawn' } }); // rank4 已过河
    expect(moves(board2, 'a5', 'black').sort()).toEqual(['a4', 'b5']);
    const board3 = emptyWith({ 'a1': { side: 'black', type: 'pawn' } }); // rank0 底线
    expect(moves(board3, 'a1', 'black')).toEqual(['b1']);
  });
  it('兵前进路被己方挡则不能进;目标格为敌方则可吃', () => {
    const board = emptyWith({ 'a5': { side: 'red', type: 'pawn' }, 'a6': { side: 'red', type: 'pawn' } });
    expect(moves(board, 'a5', 'red')).toEqual([]);              // 未过河且前进被己方挡
    const board2 = emptyWith({ 'a5': { side: 'red', type: 'pawn' }, 'a6': { side: 'black', type: 'pawn' } });
    expect(moves(board2, 'a5', 'red')).toEqual(['a6']);         // 吃黑子
    const board3 = emptyWith({ 'a6': { side: 'red', type: 'pawn' }, 'a7': { side: 'red', type: 'pawn' } });
    expect(moves(board3, 'a6', 'red')).toEqual(['b6']);         // 已过河;前进被己方挡,仅横走
  });
});

describe('马(horse)走法', () => {
  it('角落马 8 方向裁剪后全部可达(无蹩腿)', () => {
    const board = emptyWith({ 'c1': { side: 'red', type: 'horse' } });
    expect(moves(board, 'c1', 'red').sort()).toEqual(['a2', 'b3', 'd3', 'e2']);
  });
  it('方向邻格占子则蹩腿:c2 卒蹩掉 b3/d3 两条腿', () => {
    const board = emptyWith({ 'c1': { side: 'red', type: 'horse' }, 'c2': { side: 'red', type: 'pawn' } });
    expect(moves(board, 'c1', 'red').sort()).toEqual(['a2', 'e2']);
  });
  it('b1 卒蹩掉 a2;d1 卒蹩掉 e2', () => {
    const board = emptyWith({ 'c1': { side: 'red', type: 'horse' }, 'b1': { side: 'red', type: 'pawn' } });
    expect(moves(board, 'c1', 'red').sort()).toEqual(['b3', 'd3', 'e2']);
    const board2 = emptyWith({ 'c1': { side: 'red', type: 'horse' }, 'd1': { side: 'red', type: 'pawn' } });
    expect(moves(board2, 'c1', 'red').sort()).toEqual(['a2', 'b3', 'd3']);
  });
  it('马可吃目标格敌子;目标格己方子不入走法', () => {
    const board = emptyWith({ 'c1': { side: 'red', type: 'horse' }, 'a2': { side: 'black', type: 'pawn' } });
    expect(moves(board, 'c1', 'red')).toContain('a2');          // 吃黑
    const board2 = emptyWith({ 'c1': { side: 'red', type: 'horse' }, 'a2': { side: 'red', type: 'pawn' } });
    expect(moves(board2, 'c1', 'red')).not.toContain('a2');
  });
});

describe('共享直线 helper(供后续车/炮/象复用)', () => {
  it('lineMoves 沿方向扫:遇己方止(不含)/ 遇敌方含吃后停 / 越界止', () => {
    const b = initialBoard();  // a1 红车,a4 红兵
    const hs = lineMoves(b, codeToSq('a1'), 0, 1, 'red');
    expect(hs.map(m => sqToCode(m.to))).toEqual(['a2', 'a3']);
    const b2 = emptyWith({ 'a1': { side: 'red', type: 'rook' }, 'a3': { side: 'black', type: 'pawn' } });
    const hs2 = lineMoves(b2, codeToSq('a1'), 0, 1, 'red');
    expect(hs2.map(m => sqToCode(m.to))).toEqual(['a2', 'a3']); // a3 可吃含入,随后停
  });
  it('isPathClear 仅当中间格全空(端点不论)', () => {
    const b = emptyWith({ 'a1': { side: 'red', type: 'rook' }, 'a4': { side: 'red', type: 'pawn' } });
    expect(isPathClear(b, codeToSq('a1'), codeToSq('a4'))).toBe(true);  // 中间 a2/a3 空
    const b2 = emptyWith({ 'a1': { side: 'red', type: 'rook' }, 'a3': { side: 'black', type: 'pawn' }, 'a4': { side: 'red', type: 'pawn' } });
    expect(isPathClear(b2, codeToSq('a1'), codeToSq('a4'))).toBe(false); // a3 挡路
    expect(isPathClear(b2, codeToSq('a1'), codeToSq('a3'))).toBe(true);  // 至 a3 无中间格
  });
});

describe('象(elephant)走法', () => {
  it('黑象被塞象眼:c10 黑象 + d9 卒塞 e8 方向,但 a8 方向眼空可达', () => {
    // d9=(3,8) 是 c10=(2,9)→e8=(4,7) 的象眼中点,塞的是 e8 向;
    // a8=(0,7) 向眼中点 b9=(1,8) 无子,不可不达(修正 brief 期望 0 → 1)
    const board = emptyWith({ 'c10': { side: 'black', type: 'elephant' }, 'd9': { side: 'black', type: 'pawn' } });
    expect(moves(board, 'c10', 'black').sort()).toEqual(['a8']);
  });
  it('红相田字跳且不过河(红 rank<=4)', () => {
    const board = emptyWith({ 'c5': { side: 'red', type: 'elephant' } });
    expect(moves(board, 'c5', 'red').sort()).toEqual(['a3', 'e3']); // a7/e7 过河剔除
  });
  it('黑象不过河(黑 rank>=5)', () => {
    const board = emptyWith({ 'e5': { side: 'black', type: 'elephant' } });
    expect(moves(board, 'e5', 'black').sort()).toEqual(['c7', 'g7']); // c3/g3 在红侧剔除
  });
  it('象眼有子则该方向跳无效;四向眼全塞则无走法', () => {
    const board = emptyWith({ 'c3': { side: 'red', type: 'elephant' }, 'd2': { side: 'red', type: 'pawn' } });
    expect(moves(board, 'c3', 'red').sort()).toEqual(['a1', 'a5', 'e5']); // e1 向被 d2 塞眼
    const board2 = emptyWith({
      'c3': { side: 'red', type: 'elephant' },
      'b2': { side: 'red', type: 'pawn' }, 'd2': { side: 'red', type: 'pawn' },
      'b4': { side: 'red', type: 'pawn' }, 'd4': { side: 'red', type: 'pawn' },
    });
    expect(moves(board2, 'c3', 'red')).toEqual([]); // a1/e1/a5/e5 四向眼全被塞
  });
  it('象可吃目标格敌子;目标格己方子剔除', () => {
    const board = emptyWith({ 'c3': { side: 'red', type: 'elephant' }, 'e1': { side: 'black', type: 'pawn' } });
    expect(moves(board, 'c3', 'red')).toContain('e1');
    const board2 = emptyWith({ 'c3': { side: 'red', type: 'elephant' }, 'e1': { side: 'red', type: 'pawn' } });
    expect(moves(board2, 'c3', 'red')).not.toContain('e1');
  });
});

describe('士(advisor)走法', () => {
  it('红仕九宫斜一步;e1 帅存在时 d1 仕只能到 e2', () => {
    const board = emptyWith({ 'e1': { side: 'red', type: 'general' }, 'd1': { side: 'red', type: 'advisor' } });
    expect(moves(board, 'd1', 'red').sort()).toEqual(['e2']); // c2 出宫;e2 唯一宫内斜点
  });
  it('仕不能出九宫(九宫边界裁剪)', () => {
    const board = emptyWith({ 'd2': { side: 'red', type: 'advisor' } });
    expect(moves(board, 'd2', 'red').sort()).toEqual(['e1', 'e3']); // c1/c3 出宫(file2)
  });
  it('黑仕在己方九宫斜一步', () => {
    const board = emptyWith({ 'e10': { side: 'black', type: 'advisor' } });
    expect(moves(board, 'e10', 'black').sort()).toEqual(['d9', 'f9']);
  });
  it('仕可吃敌子;不能直走/横走', () => {
    const board = emptyWith({ 'd1': { side: 'red', type: 'advisor' }, 'e2': { side: 'black', type: 'pawn' } });
    expect(moves(board, 'd1', 'red')).toContain('e2');
    const board2 = emptyWith({ 'd1': { side: 'red', type: 'advisor' }, 'e1': { side: 'black', type: 'pawn' } });
    expect(moves(board2, 'd1', 'red')).not.toContain('e1'); // 直移到 e1 不可
  });
});

describe('帅/将(general)走法', () => {
  it('红帅九宫直一步:e1 可到 d1/e2/f1;不斜走', () => {
    const board = emptyWith({ 'e1': { side: 'red', type: 'general' } });
    expect(moves(board, 'e1', 'red').sort()).toEqual(['d1', 'e2', 'f1']); // d2/f2 为斜点,剔除
  });
  it('帅在九宫中心四向皆可', () => {
    const board = emptyWith({ 'e2': { side: 'red', type: 'general' } });
    expect(moves(board, 'e2', 'red').sort()).toEqual(['d2', 'e1', 'e3', 'f2']); // d1/f1/d3/f3 斜点不可
  });
  it('黑将九宫直一步且不出宫', () => {
    const board = emptyWith({ 'e10': { side: 'black', type: 'general' } });
    expect(moves(board, 'e10', 'black').sort()).toEqual(['d10', 'e9', 'f10']); // rank10 越界出宫
  });
  it('帅不能斜走(即使目标在九宫内)', () => {
    const board = emptyWith({ 'e2': { side: 'red', type: 'general' } });
    const hs = moves(board, 'e2', 'red');
    expect([...hs].sort()).toEqual(['d2', 'e1', 'e3', 'f2']);
    for (const diag of ['d1', 'f1', 'd3', 'f3']) expect(hs).not.toContain(diag);
  });
  it('帅可吃敌子;己方剔除', () => {
    const board = emptyWith({ 'e2': { side: 'red', type: 'general' }, 'f2': { side: 'black', type: 'pawn' } });
    expect(moves(board, 'e2', 'red')).toContain('f2');
    const board2 = emptyWith({ 'e2': { side: 'red', type: 'general' }, 'f2': { side: 'red', type: 'pawn' } });
    expect(moves(board2, 'e2', 'red')).not.toContain('f2');
  });
});