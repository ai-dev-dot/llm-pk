import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cloneBoard, initialBoard, sqToIdx, type Board } from './board';
import type { Move } from './moves';

// --- 模块级 spy:只做调用计数,仍委托真实实现(借 io) ---
vi.mock('./notation', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./notation')>();
  return { ...mod, parseMoveRaw: vi.fn(mod.parseMoveRaw) };
});
vi.mock('./moves', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./moves')>();
  return { ...mod, legalMoves: vi.fn(mod.legalMoves) };
});

import * as notation from './notation';
import { legalMoves, moveToKey } from './moves';
import { clearResolveCache, engineReason, parseResolve } from './resolver';

/** 断言 outcome 的失败码;成功时抛错。 */
function codeOf(r: ReturnType<typeof parseResolve>): string {
  if (r.ok) throw new Error('expected failure outcome, got ok:' + JSON.stringify(r));
  return r.code;
}

/** 构造:红方双车同线(file e,rank0 与 rank7) */
function redRookPairBoard(): Board {
  const b = cloneBoard(initialBoard());
  b[sqToIdx(0, 0)] = null;
  b[sqToIdx(8, 0)] = null;
  b[sqToIdx(4, 0)] = { side: 'red', type: 'rook' };
  b[sqToIdx(4, 7)] = { side: 'red', type: 'rook' };
  return b;
}

/** 构造:清空 e 线,放 红帅e1 / 红车e4 / 黑将e10 —— 车 e4→d4 即送将(照面) */
function facingSuicideBoard(): Board {
  const b = cloneBoard(initialBoard());
  for (let r = 0; r < 10; r++) b[sqToIdx(4, r)] = null;
  b[sqToIdx(4, 0)] = { side: 'red', type: 'general' };
  b[sqToIdx(4, 3)] = { side: 'red', type: 'rook' };
  b[sqToIdx(4, 9)] = { side: 'black', type: 'general' };
  return b;
}

/** 构造:红马 h3、g3 有己方兵挡马腿,h3→f2 被蹩腿 */
function blockedHorseBoard(): Board {
  const b = cloneBoard(initialBoard());
  b[sqToIdx(7, 2)] = { side: 'red', type: 'horse' };
  b[sqToIdx(6, 2)] = { side: 'red', type: 'pawn' };
  return b;
}

describe('parseResolve 裁决码', () => {
  beforeEach(() => {
    clearResolveCache();
    vi.clearAllMocks();
  });

  it('合法走法(炮二平五)→ ok:true, code OK,换算出 Move', () => {
    const r = parseResolve('炮二平五', initialBoard(), 'red');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('should be ok');
    expect(r.code).toBe('OK');
    expect(r.move.from).toEqual({ file: 7, rank: 2 });
    expect(r.move.to).toEqual({ file: 4, rank: 2 });
  });

  it('黑方坐标合法走法 → OK', () => {
    const r = parseResolve('a10-a9', initialBoard(), 'black');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('should be ok');
    expect(r.code).toBe('OK');
  });

  it('乱码/空串 → PARSER_INVALID', () => {
    expect(codeOf(parseResolve('随便说说', initialBoard(), 'red'))).toBe('PARSER_INVALID');
    expect(codeOf(parseResolve('', initialBoard(), 'red'))).toBe('PARSER_INVALID');
  });

  it('未知棋种(牛三进一)→ PARSER_INVALID', () => {
    expect(codeOf(parseResolve('牛三进一', initialBoard(), 'red'))).toBe('PARSER_INVALID');
  });

  it('同线双子缺前/后 → PARSER_AMBIGUOUS(绝不猜测)', () => {
    expect(codeOf(parseResolve('车五进一', redRookPairBoard(), 'red'))).toBe('PARSER_AMBIGUOUS');
  });

  it('坐标起点非本方棋子 → ILLEGAL_MOVE', () => {
    expect(codeOf(parseResolve('h3-e3', initialBoard(), 'black'))).toBe('ILLEGAL_MOVE');
  });

  it('写作合法但本体非法(车跳马步)→ ILLEGAL_MOVE', () => {
    expect(codeOf(parseResolve('i1-h2', initialBoard(), 'red'))).toBe('ILLEGAL_MOVE');
  });

  it('马被蹩腿(h3→f2,腿 g3 有兵)→ ILLEGAL_MOVE 而非 SUICIDE', () => {
    expect(codeOf(parseResolve('h3-f2', blockedHorseBoard(), 'red'))).toBe('ILLEGAL_MOVE');
  });

  it('车 e4→d4 走后将帅照面 → SUICIDE 特判', () => {
    const r = parseResolve('e4-d4', facingSuicideBoard(), 'red');
    expect(r.ok).toBe(false);
    expect(codeOf(r)).toBe('SUICIDE');
  });

  it('中文记谱本体非法(兵五退一)→ ILLEGAL_MOVE', () => {
    expect(codeOf(parseResolve('兵五退一', initialBoard(), 'red'))).toBe('ILLEGAL_MOVE');
  });
});

describe('parseResolve 缓存(评审采纳:每回合只算一次)', () => {
  beforeEach(() => {
    clearResolveCache();
    vi.clearAllMocks();
  });

  it('同一 (cacheKey,text):第二次命中缓存,parseMoveRaw 只调用一次', () => {
    const b = initialBoard();
    const mk = () => vi.mocked(notation.parseMoveRaw);
    parseResolve('炮二平五', b, 'red', 'gA:10:3');
    parseResolve('炮二平五', b, 'red', 'gA:10:3');
    expect(mk()).toHaveBeenCalledTimes(1);
  });

  it('不同 cacheKey → 不命中缓存,各自解析', () => {
    const b = initialBoard();
    parseResolve('炮二平五', b, 'red', 'gA:10:3');
    parseResolve('炮二平五', b, 'red', 'gA:10:4');
    expect(vi.mocked(notation.parseMoveRaw)).toHaveBeenCalledTimes(2);
  });

  it('不提供 cacheKey → 不做缓存,每次独立解析', () => {
    const b = initialBoard();
    parseResolve('炮二平五', b, 'red');
    parseResolve('炮二平五', b, 'red');
    expect(vi.mocked(notation.parseMoveRaw)).toHaveBeenCalledTimes(2);
  });

  it('同一 round 内不同 text:同盘合法清单(legalMoves)只算一次', () => {
    const b = initialBoard();
    expect(parseResolve('炮二平五', b, 'red', 'gA:10:3').ok).toBe(true);
    expect(parseResolve('马八进七', b, 'red', 'gA:10:3').ok).toBe(true);
    expect(vi.mocked(legalMoves)).toHaveBeenCalledTimes(1);
  });

  it('缓存键区分 side:同 (cacheKey,text) 红黑各解析一次', () => {
    parseResolve('h3-e3', initialBoard(), 'red', 'gA:10:3');
    parseResolve('h3-e3', initialBoard(), 'black', 'gA:10:3');
    expect(vi.mocked(notation.parseMoveRaw)).toHaveBeenCalledTimes(2);
  });

  it('打回重试复用:首次非法文本算过 legalMoves 后,重试新文本不再重算', () => {
    const b = initialBoard();
    expect(codeOf(parseResolve('兵五退一', b, 'red', 'gA:10:3'))).toBe('ILLEGAL_MOVE');
    expect(codeOf(parseResolve('兵五平四', b, 'red', 'gA:10:3'))).toBe('ILLEGAL_MOVE');
    expect(vi.mocked(legalMoves)).toHaveBeenCalledTimes(1);
  });
});

describe('engineReason 打回讲评(中文、不列答案)', () => {
  beforeEach(() => clearResolveCache());

  it('PARSER_INVALID → 中文提示写法格式,不含坐标答案', () => {
    const r = engineReason('PARSER_INVALID');
    expect(r).toContain('无法理解');
    expect(r).toContain('记谱');
    expect(r).toContain('坐标');
  });

  it('PARSER_AMBIGUOUS → 提示歧义与补列号', () => {
    const r = engineReason('PARSER_AMBIGUOUS');
    expect(r).toContain('歧义');
  });

  it('SUICIDE 特判 → 明确送将/照面,绝不列合法走', () => {
    const r = engineReason('SUICIDE');
    expect(r).toContain('送将');
    expect(r).not.toMatch(/[a-i](10|[1-9])-[a-i](10|[1-9])/);
  });

  it('OK → 走法有效文案', () => {
    expect(engineReason('OK')).toContain('走法有效');
  });

  it('ILLEGAL_MOVE 无 move/board 时给通用打回,不泄清单', () => {
    const r = engineReason('ILLEGAL_MOVE');
    expect(r).toContain('不成立');
    expect(r).not.toMatch(/[a-i](10|[1-9])-[a-i](10|[1-9])/);
  });

  it('ILLEGAL_MOVE 蹩腿精确点名,且不枚举任何本局面合法走法', () => {
    const b = blockedHorseBoard();
    const move: Move = { from: { file: 7, rank: 2 }, to: { file: 5, rank: 1 } };
    const r = engineReason('ILLEGAL_MOVE', move, b, 'red');
    expect(r).toContain('蹩腿');
    for (const m of legalMoves(b, 'red')) {
      expect(r).not.toContain(moveToKey(m));
    }
  });

  it('ILLEGAL_MOVE 车斜走无路 → 点名棋子与起因', () => {
    const b = initialBoard();
    const move: Move = { from: { file: 8, rank: 0 }, to: { file: 7, rank: 1 } };
    const r = engineReason('ILLEGAL_MOVE', move, b, 'red');
    expect(r).toContain('车');
    for (const m of legalMoves(b, 'red')) {
      expect(r).not.toContain(moveToKey(m));
    }
  });
});