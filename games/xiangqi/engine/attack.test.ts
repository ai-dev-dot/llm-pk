import { describe, it, expect } from 'vitest';
import { isInCheck, isGeneralFacing, simulateApply, requireApply, moveToKey, legalMoves } from './attack';
import { rawMovesFor } from './moves';
import { codeToSq, sqToCode, sqToIdx } from './board';
import type { Board, Piece, Side } from './board';

// 构造测试局面:90 长空盘,按 { 坐标代码: 棋子 } 放子(与 moves.test 一致的 Record 对象形式)
function emptyWith(records: Record<string, Piece>): Board {
  const b: Board = new Array<Piece | null>(90).fill(null);
  for (const [code, piece] of Object.entries(records)) {
    const sq = codeToSq(code);
    b[sqToIdx(sq.file, sq.rank)] = { ...piece };
  }
  return b;
}

// 把合法走法的 to 坐标转成代码方便断言语义
const legalTos = (b: Board, side: Side, fromCode: string): string[] =>
  legalMoves(b, side).filter(m => sqToCode(m.from) === fromCode).map(m => sqToCode(m.to)).sort();

describe('isInCheck(将军判定)', () => {
  it('无被将:红帅 e1 不被黑车 a10 攻击 → false', () => {
    const b = emptyWith({ e1: { side: 'red', type: 'general' }, a10: { side: 'black', type: 'rook' } });
    expect(isInCheck(b, 'red')).toBe(false);
  });
  it('车将军:e 线无遮挡,e10 黑车直指 e1 红帅', () => {
    const b = emptyWith({ e1: { side: 'red', type: 'general' }, e10: { side: 'black', type: 'rook' } });
    expect(isInCheck(b, 'red')).toBe(true);
    expect(isInCheck(b, 'black')).toBe(false);   // 黑方自身未受将
  });
  it('车有子遮挡则不将军:e2 红兵挡在 e10 黑车与 e1 红帅之间', () => {
    const b = emptyWith({ e1: { side: 'red', type: 'general' }, e10: { side: 'black', type: 'rook' }, e2: { side: 'red', type: 'pawn' } });
    expect(isInCheck(b, 'red')).toBe(false);
  });
  it('马将军:d8 黑马跳日(horse step)直指 e6 红帅', () => {
    const b = emptyWith({ e6: { side: 'red', type: 'general' }, d8: { side: 'black', type: 'horse' } });
    expect(isInCheck(b, 'red')).toBe(true);
  });
  it('炮将军:恰一只炮架 e5 红兵,e10 黑炮隔架打 e1 红帅', () => {
    const b = emptyWith({ e1: { side: 'red', type: 'general' }, e10: { side: 'black', type: 'cannon' }, e5: { side: 'red', type: 'pawn' } });
    expect(isInCheck(b, 'red')).toBe(true);
  });
  it('炮无炮架则不将军:e10 黑炮与 e1 红帅之间全空', () => {
    const b = emptyWith({ e1: { side: 'red', type: 'general' }, e10: { side: 'black', type: 'cannon' } });
    expect(isInCheck(b, 'red')).toBe(false);
  });
  it('将帅照面视同被将军:双方互将', () => {
    const b = emptyWith({ e1: { side: 'red', type: 'general' }, e10: { side: 'black', type: 'general' } });
    expect(isInCheck(b, 'red')).toBe(true);
    expect(isInCheck(b, 'black')).toBe(true);
  });
});

describe('isGeneralFacing(将帅照面)', () => {
  it('同列且中间全空 → true', () => {
    const b = emptyWith({ e1: { side: 'red', type: 'general' }, e10: { side: 'black', type: 'general' } });
    expect(isGeneralFacing(b)).toBe(true);
  });
  it('同列但中间有子遮挡 → false', () => {
    const b = emptyWith({ e1: { side: 'red', type: 'general' }, e10: { side: 'black', type: 'general' }, e6: { side: 'red', type: 'pawn' } });
    expect(isGeneralFacing(b)).toBe(false);
  });
  it('不同列 → false', () => {
    const b = emptyWith({ d1: { side: 'red', type: 'general' }, e10: { side: 'black', type: 'general' } });
    expect(isGeneralFacing(b)).toBe(false);
  });
});

describe('simulateApply / requireApply / moveToKey', () => {
  it('simulateApply 返回克隆新盘:可吃子并清空原位,原盘不变', () => {
    const b = emptyWith({ a1: { side: 'red', type: 'rook' }, a5: { side: 'black', type: 'pawn' } });
    const nb = simulateApply(b, { from: codeToSq('a1'), to: codeToSq('a5') });
    expect(nb).not.toBe(b);
    expect(b[0]).toEqual({ side: 'red', type: 'rook' });        // 原盘未动
    expect(b[sqToIdx(0, 4)]).toEqual({ side: 'black', type: 'pawn' });
    expect(nb[0]).toBeNull();                                    // from 清空
    expect(nb[sqToIdx(0, 4)]).toEqual({ side: 'red', type: 'rook' }); // 吃到 a5,黑卒落下
  });
  it('requireApply:from 无子时抛错', () => {
    const b = emptyWith({ a1: { side: 'red', type: 'rook' } });
    expect(() => requireApply(b, { from: codeToSq('c1'), to: codeToSq('c2') })).toThrow();
    expect(requireApply(b, { from: codeToSq('a1'), to: codeToSq('a3') })[sqToIdx(0, 2)]).toEqual({ side: 'red', type: 'rook' });
  });
  it('moveToKey:标准记谱 <from>-<to> 形式', () => {
    expect(moveToKey({ from: codeToSq('e5'), to: codeToSq('c7') })).toBe('e5-c7');
  });
});

describe('legalMoves(送将过滤)', () => {
  it('走后不得送将(士入炮口成架):d1 仕若 e2 与 e10 黑炮恰好构成一架打 e1 帅 → 非法', () => {
    const b = emptyWith({ e1: { side: 'red', type: 'general' }, d1: { side: 'red', type: 'advisor' }, e10: { side: 'black', type: 'cannon' } });
    // 钉住成因:模拟 d1→e2 后红方确实处于被将军
    expect(isInCheck(simulateApply(b, { from: codeToSq('d1'), to: codeToSq('e2') }), 'red')).toBe(true);
    expect(legalTos(b, 'red', 'd1')).toEqual([]);            // 唯一可走 e2 被过滤
    expect(legalTos(b, 'red', 'e1')).toEqual(['e2', 'f1']);  // 帅可避:横向移开或升到 e2(无架安全)
  });
  it('走后不得送将(垫子离开 e 线失遮):e2 仕若离开,e10 黑车直射 e1 帅 → 非法', () => {
    const b = emptyWith({ e1: { side: 'red', type: 'general' }, e10: { side: 'black', type: 'rook' }, e2: { side: 'red', type: 'advisor' } });
    expect(legalTos(b, 'red', 'e2')).toEqual([]);            // e2 唯一遮蔽,任意离开皆送将
    expect(legalMoves(b, 'red').map(m => sqToCode(m.to)).sort()).toEqual(['d1', 'f1']); // 帅横移出 e 线脱险
  });
  it('无送将风险时 legalMoves 与 rawMovesFor 一致(车空盘 17 步)', () => {
    const b = emptyWith({ a1: { side: 'red', type: 'rook' } });
    const raw = rawMovesFor(b, codeToSq('a1'), 'red');
    expect(legalMoves(b, 'red')).toHaveLength(raw.length);
    expect(legalMoves(b, 'red').map(m => sqToCode(m.to)).sort()).toEqual(raw.map(m => sqToCode(m.to)).sort());
  });
  it('将帅不可照面:照面时帅不能走 e2(仍照面),但可横移 d1/f1 脱脸(修正 brief 铅笔期望 0→2)', () => {
    const b = emptyWith({ e1: { side: 'red', type: 'general' }, e10: { side: 'black', type: 'general' } });
    expect(isGeneralFacing(b)).toBe(true);
    const ms = legalMoves(b, 'red');
    expect(ms.map(m => sqToCode(m.from) + '-' + sqToCode(m.to)).sort()).toEqual(['e1-d1', 'e1-f1']);
    expect(ms).toHaveLength(2);   // brief 原写 0(误);真实规则:横移避脸合法
  });
});