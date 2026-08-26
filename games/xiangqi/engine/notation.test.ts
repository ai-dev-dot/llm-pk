import { describe, it, expect } from 'vitest';
import type { Board, Side } from './board';
import { cloneBoard, initialBoard, sqToIdx, sqToCode } from './board';
import { parseMove } from './notation';

/** 解析并断言成功,返回 Move */
function okMove(text: string, board: Board, side: Side) {
  const r = parseMove(text, board, side);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error('parseMove should have succeeded: ' + text);
  return r.move;
}

/** 只断言解析成功(不关心具体 Move) */
function okParse(text: string, board: Board, side: Side) {
  expect(parseMove(text, board, side).ok).toBe(true);
}

/** 断言解析失败并返回 reason */
function failReason(text: string, board: Board, side: Side): string {
  const r = parseMove(text, board, side);
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error('parseMove should have failed: ' + text);
  return r.reason;
}

/** 红方双车同线(file e,rank0 与 rank7)的棋盘,用于前/后歧义 */
function redRookPairBoard(): Board {
  const b = cloneBoard(initialBoard());
  b[sqToIdx(0, 0)] = null;
  b[sqToIdx(8, 0)] = null;
  b[sqToIdx(4, 0)] = { side: 'red', type: 'rook' };
  b[sqToIdx(4, 7)] = { side: 'red', type: 'rook' };
  return b;
}

/** 黑方双车同线(file e,rank5 与 rank8)的棋盘 */
function blackRookPairBoard(): Board {
  const b = cloneBoard(initialBoard());
  b[sqToIdx(0, 9)] = null;
  b[sqToIdx(8, 9)] = null;
  b[sqToIdx(4, 5)] = { side: 'black', type: 'rook' };
  b[sqToIdx(4, 8)] = { side: 'black', type: 'rook' };
  return b;
}

describe('坐标格式 h3-e3 / h3e3', () => {
  const b = initialBoard();
  it('h3-e3 直接通过并换算为 Move', () => {
    const m = okMove('h3-e3', b, 'red');
    expect(sqToCode(m.from)).toBe('h3');
    expect(sqToCode(m.to)).toBe('e3');
  });
  it('无分隔符 h3e3 同样通过', () => {
    const m = okMove('h3e3', b, 'red');
    expect(sqToCode(m.from)).toBe('h3');
    expect(sqToCode(m.to)).toBe('e3');
  });
  it('空格/大小写/全角一律容忍', () => {
    okParse(' h 3 - e 3 ', b, 'red');
    okParse('H3-E3', b, 'red');
    okParse('ｈ３ｅ３', b, 'red');
  });
  it('黑方坐标 a10-a9 合法通过', () => {
    const m = okMove('a10-a9', b, 'black');
    expect(sqToCode(m.from)).toBe('a10');
    expect(sqToCode(m.to)).toBe('a9');
  });
  it('起点为空或敌方子 → PIECE_NOT_FOUND', () => {
    expect(failReason('a2-e2', b, 'red')).toBe('PIECE_NOT_FOUND');   // a2 空位
    expect(failReason('h3-e3', b, 'black')).toBe('PIECE_NOT_FOUND'); // 红炮非黑方
  });
  it('坐标合法但走法非法 → ILLEGAL_MOVE(越己方车/马)', () => {
    expect(failReason('i1-a1', b, 'red')).toBe('ILLEGAL_MOVE');
  });
  it('乱码/越界坐标 → PARSER_INVALID', () => {
    expect(failReason('a11b1', b, 'red')).toBe('PARSER_INVALID');
    expect(failReason('z1z2', b, 'red')).toBe('PARSER_INVALID');
    expect(failReason('h3x', b, 'red')).toBe('PARSER_INVALID');
  });
});

describe('中文记谱(红)', () => {
  const b = initialBoard();
  it('炮二平五 → h3-e3', () => {
    const m = okMove('炮二平五', b, 'red');
    expect(sqToCode(m.from)).toBe('h3');
    expect(sqToCode(m.to)).toBe('e3');
  });
  it('阿拉伯数字 炮2平5 等价', () => {
    const m = okMove('炮2平5', b, 'red');
    expect(sqToCode(m.from)).toBe('h3');
    expect(sqToCode(m.to)).toBe('e3');
  });
  it('马八进七 → b1-c3', () => {
    const m = okMove('马八进七', b, 'red');
    expect(sqToCode(m.from)).toBe('b1');
    expect(sqToCode(m.to)).toBe('c3');
  });
  it('兵五进一 → e4-e5', () => {
    const m = okMove('兵五进一', b, 'red');
    expect(sqToCode(m.from)).toBe('e4');
    expect(sqToCode(m.to)).toBe('e5');
  });
  it('车一进二 → i1-i3(i4 兵挡路,进五会非法)', () => {
    const m = okMove('车一进二', b, 'red');
    expect(sqToCode(m.from)).toBe('i1');
    expect(sqToCode(m.to)).toBe('i3');
  });
  it('车一退一(退到底线外)→ OUT_OF_BOARD', () => {
    expect(failReason('车一退一', b, 'red')).toBe('OUT_OF_BOARD');
  });
  it('红方中盘车退一(车九退一)→ a6-a5', () => {
    const mb = cloneBoard(initialBoard());
    mb[sqToIdx(0, 0)] = null;
    mb[sqToIdx(8, 0)] = null;
    mb[sqToIdx(0, 5)] = { side: 'red', type: 'rook' };
    const m = okMove('车九退一', mb, 'red');
    expect(sqToCode(m.from)).toBe('a6');
    expect(sqToCode(m.to)).toBe('a5');
  });
});

describe('中文记谱(黑)', () => {
  const b = initialBoard();
  it('马8进7 → h10-g8', () => {
    const m = okMove('马8进7', b, 'black');
    expect(sqToCode(m.from)).toBe('h10');
    expect(sqToCode(m.to)).toBe('g8');
  });
  it('卒5进1 → e7-e6', () => {
    const m = okMove('卒5进1', b, 'black');
    expect(sqToCode(m.from)).toBe('e7');
    expect(sqToCode(m.to)).toBe('e6');
  });
  it('炮8平5 → h8-e8', () => {
    const m = okMove('炮8平5', b, 'black');
    expect(sqToCode(m.from)).toBe('h8');
    expect(sqToCode(m.to)).toBe('e8');
  });
  it('士4进5 → d10-e9', () => {
    const m = okMove('士4进5', b, 'black');
    expect(sqToCode(m.from)).toBe('d10');
    expect(sqToCode(m.to)).toBe('e9');
  });
});

describe('空格/全角容忍(中文)', () => {
  const b = initialBoard();
  it('带空格、括号、句号均能解析', () => {
    const m = okMove(' 炮 二 平 五 ', b, 'red');
    expect(sqToCode(m.from)).toBe('h3');
    expect(sqToCode(m.to)).toBe('e3');
    okParse('（炮二平五）', b, 'red');
    okParse('炮二平五。', b, 'red');
  });
});

describe('前/后 同线双子歧义', () => {
  it('红:前车进一 → 前排车 e8-e9;后车进一 → e1-e2', () => {
    const rb = redRookPairBoard();
    const front = okMove('前车进一', rb, 'red');
    expect(sqToCode(front.from)).toBe('e8');
    expect(sqToCode(front.to)).toBe('e9');
    const back = okMove('后车进一', rb, 'red');
    expect(sqToCode(back.from)).toBe('e1');
    expect(sqToCode(back.to)).toBe('e2');
  });
  it('红:前车退一 → e8-e7', () => {
    const rb = redRookPairBoard();
    const m = okMove('前车退一', rb, 'red');
    expect(sqToCode(m.from)).toBe('e8');
    expect(sqToCode(m.to)).toBe('e7');
  });
  it('繁体 後車進一 → 后排车 e1-e2', () => {
    const rb = redRookPairBoard();
    const m = okMove('後車進一', rb, 'red');
    expect(sqToCode(m.from)).toBe('e1');
    expect(sqToCode(m.to)).toBe('e2');
  });
  it('黑:前车进一 → e6-e5;后车进一 → e9-e8', () => {
    const bb = blackRookPairBoard();
    const front = okMove('前车进一', bb, 'black');
    expect(sqToCode(front.from)).toBe('e6');
    expect(sqToCode(front.to)).toBe('e5');
    const back = okMove('后车进一', bb, 'black');
    expect(sqToCode(back.from)).toBe('e9');
    expect(sqToCode(back.to)).toBe('e8');
  });
  it('同线双子缺前/后 → PARSER_AMBIGUOUS(绝不猜测)', () => {
    expect(failReason('车五进一', redRookPairBoard(), 'red')).toBe('PARSER_AMBIGUOUS');
    expect(failReason('车5进1', blackRookPairBoard(), 'black')).toBe('PARSER_AMBIGUOUS');
  });
});

describe('非法/未识别', () => {
  const b = initialBoard();
  it('未知棋种 → UNKNOWN_Piece', () => {
    expect(failReason('牛三进一', b, 'red')).toBe('UNKNOWN_Piece');
  });
  it('马/象/士 用「平」→ PARSER_INVALID', () => {
    expect(failReason('马二平五', b, 'red')).toBe('PARSER_INVALID');
  });
  it('未过河兵平走 → ILLEGAL_MOVE', () => {
    expect(failReason('兵五平四', b, 'red')).toBe('ILLEGAL_MOVE');
  });
  it('被己方阻断(炮过不去)→ ILLEGAL_MOVE', () => {
    expect(failReason('炮二平九', b, 'red')).toBe('ILLEGAL_MOVE');
  });
  it('兵退走 → ILLEGAL_MOVE', () => {
    expect(failReason('兵五退一', b, 'red')).toBe('ILLEGAL_MOVE');
  });
  it('无列号、前后缀缺失 → PARSER_INVALID', () => {
    expect(failReason('车进一', b, 'red')).toBe('PARSER_INVALID');
  });
  it('纯乱文 → PARSER_INVALID', () => {
    expect(failReason('随便说说', b, 'red')).toBe('PARSER_INVALID');
    expect(failReason('', b, 'red')).toBe('PARSER_INVALID');
  });
});