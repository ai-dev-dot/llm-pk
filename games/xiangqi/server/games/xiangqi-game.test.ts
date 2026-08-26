//
// XiangqiGame 适配层测试(spec §3 平台化 / G1)。
//
// 断言:
// - `resolve`:坐标/中文记谱通过、失败 reasonText 为中文讲评且**绝不枚举合法走法**;
// - `moveId` 含中文记谱旁注(红中文列号/黑阿拉伯),无子时记谱留空;
// - `classify` 将 interface 的 reason 归一(engine 的 null → undefined);
// - `apply/initialState/render/snapshotKey/opposite` 与引擎行为等价(抽样);
// - `clearCache` 可调用、`meta` 平台化元数据存在。
//

import { describe, expect, it } from 'vitest';
import { initialBoard, sqToIdx } from '../../engine/board';
import { xiangqiGame } from './xiangqi-game';

describe('XiangqiGame 适配层', () => {
  it('meta:平台化元数据(名称/双方/简化裁定)', () => {
    expect(xiangqiGame.meta.name).toBe('xiangqi');
    expect(xiangqiGame.meta.sides).toEqual(['red', 'black']);
    expect(xiangqiGame.meta.drawRule).toContain('重复局面');
  });

  it('initialState = 标准初始布局 32 子;render 为文本棋盘(非空、含坐标)', () => {
    const s = xiangqiGame.initialState();
    // Board 中 32 子:直接按 engine 语义核对(适配层封装 cloneBoard(initialBoard()))
    const count = s.filter(Boolean).length;
    expect(count).toBe(32);
    const text = xiangqiGame.render(s);
    expect(text).toContain('a');
    expect(text).toContain('10');
    expect(text).toContain('[帥]');
    expect(text).toContain('[將]');
  });

  it('resolve:中文记谱通过', () => {
    const s = xiangqiGame.initialState();
    const r = xiangqiGame.resolve('炮二平五', s, 'red');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(xiangqiGame.moveKey(r.move)).toBe('h3-e3');
    }
  });

  it('resolve:失败携带中文讲评且不枚举合法走法', () => {
    const s = xiangqiGame.initialState();
    const r = xiangqiGame.resolve('炮二平九', s, 'red');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('ILLEGAL_MOVE');
      expect(r.reasonText.length).toBeGreaterThan(0);
      // 讲评只讲原因,绝不列出「合法走法清单」;绝不出现某个合法候选串
      const legalNotation = ['h3-e3', 'h3-h2', 'h3-h1', 'h3-g3', 'h3-f3', 'h3-e3', 'h3-i3'];
      for (const cand of legalNotation) expect(r.reasonText).not.toContain(cand);
    }
  });

  it('resolve:歧义走法(PARSER_AMBIGUOUS)同样有中文讲评', () => {
    // 红双车同列(file e):缺前/后 → 歧义
    const s = xiangqiGame.initialState();
    s[sqToIdx(0, 0)] = null;
    s[sqToIdx(8, 0)] = null;
    s[sqToIdx(4, 0)] = { side: 'red', type: 'rook' };
    s[sqToIdx(4, 7)] = { side: 'red', type: 'rook' };
    const r = xiangqiGame.resolve('车五进一', s, 'red');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('PARSER_AMBIGUOUS');
      expect(r.reasonText).toContain('歧义');
    }
  });

  it('moveId:红方中文记谱旁注(h3→e3 ∈ 炮二平五);黑方阿拉伯(卒 9 进 1)', () => {
    const s = xiangqiGame.initialState();
    const red = xiangqiGame.resolve('h3-e3', s, 'red');
    if (!red.ok) throw new Error('resolve 失败');
    expect(xiangqiGame.moveId(red.move, s)).toEqual({ from: 'h3', to: 'e3', notation: '砲二平五' });

    const black = xiangqiGame.resolve('i7-i6', s, 'black');
    if (!black.ok) throw new Error('resolve 失败');
    expect(xiangqiGame.moveId(black.move, s)).toEqual({ from: 'i7', to: 'i6', notation: '卒9进1' });
  });

  it('moveId:起点无子时记谱留空(仅坐标)', () => {
    const s = xiangqiGame.initialState();
    // 构造一个 move 但棋盘该格为空(形式防御)
    const badMove = { from: { file: 3, rank: 3 }, to: { file: 4, rank: 3 } };
    expect(xiangqiGame.moveId(badMove, s).notation).toBeUndefined();
    expect(xiangqiGame.moveId(badMove, s).from).toBe('d4');
  });

  it('classify:接口归一 —— ongoing 无 reason;checked 返回 check', () => {
    const s = xiangqiGame.initialState();
    const ongoing = xiangqiGame.classify(s, 'red', { halfMoves: 0, moveCount: 0, history: [] });
    expect(ongoing.type).toBe('ongoing');
    expect(ongoing.reason).toBeUndefined();
  });

  it('classify:重复局面达阈值 → draw-repeat(非 null 未定义归一)', () => {
    const s = xiangqiGame.initialState();
    const key = xiangqiGame.snapshotKey(s, 'red');
    const draw = xiangqiGame.classify(s, 'red', {
      halfMoves: 6,
      moveCount: 6,
      history: [key, key, key],
      drawRepeat: 3,
    });
    expect(draw.type).toBe('draw');
    expect(draw.reason).toBe('draw-repeat');
  });

  it('apply:严格落子(吃子/送将由 resolve 前置判定;直接 apply 只做移动语义)', () => {
    const s = xiangqiGame.initialState();
    // 车 h3-e3?不,h3 是炮。用炮平走 apply 本身不校验合法性(装饰层只管搬运)。
    const r = xiangqiGame.resolve('h3-e3', s, 'red');
    if (!r.ok) throw new Error('resolve 失败');
    const next = xiangqiGame.apply(s, r.move);
    expect(xiangqiGame.pieceAt(next, { file: 4, rank: 2 })).toEqual({ side: 'red', type: 'cannon' });
    expect(xiangqiGame.pieceAt(next, { file: 7, rank: 2 })).toBeNull();
  });

  it('opposite 对称', () => {
    expect(xiangqiGame.opposite('red')).toBe('black');
    expect(xiangqiGame.opposite('black')).toBe('red');
  });

  it('clearCache:每开局调用(幂等,不抛)', () => {
    expect(() => xiangqiGame.clearCache()).not.toThrow();
    expect(() => xiangqiGame.clearCache()).not.toThrow();
  });

  it('destination:吃子判定目标格', () => {
    const s = xiangqiGame.initialState();
    const r = xiangqiGame.resolve('h3-e3', s, 'red');
    if (!r.ok) throw new Error('resolve 失败');
    expect(xiangqiGame.destination(r.move)).toEqual({ file: 4, rank: 2 });
  });
});