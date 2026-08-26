import type { Board, Side, Sq } from './board';
import { pieceAt } from './board';
import { legalMoves, type Move } from './moves';

export type ParseResult = { ok: true; move: Move } | { ok: false; reason: string };

type Action = 'advance' | 'retreat' | 'lane';   // 进 / 退 / 平

// ---------- 归一化:全角→半角、去空白与标点、小写化 ----------
const HALF_MAP: Record<string, string> = {};
for (let i = 0; i < 10; i++) HALF_MAP[String.fromCharCode(0xff10 + i)] = String(i);
for (let i = 0; i < 26; i++) {
  HALF_MAP[String.fromCharCode(0xff21 + i)] = String.fromCharCode(0x41 + i);   // Ａ-Ｚ
  HALF_MAP[String.fromCharCode(0xff41 + i)] = String.fromCharCode(0x61 + i);   // ａ-ｚ
}

/** 归一化:全角→半角、去空白与标点、小写化。导出供 resolver 缓存键与 raw 解析复用。 */
export function normalize(text: string): string {
  let out = '';
  for (const ch of text) {
    const half = HALF_MAP[ch];
    if (half !== undefined) { out += half; continue; }
    // 保留 ASCII 字母数字与 CJK 统一表意文字(空格/标点/括号/连字符等一律丢弃)
    if (/[A-Za-z0-9]/.test(ch) || (ch >= '一' && ch <= '鿿')) { out += ch; continue; }
  }
  return out.toLowerCase();
}

function digit(ch: string): number | null {
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
  switch (ch) {
    case '一': return 1;
    case '二': return 2;
    case '三': return 3;
    case '四': return 4;
    case '五': return 5;
    case '六': return 6;
    case '七': return 7;
    case '八': return 8;
    case '九': return 9;
    case '十': return 10;
    default: return null;
  }
}

/**
 * 中文记谱列号 → 内部 file。
 * 红方观者视角 1..9 路 = file 8..0(红 1 路最右);黑方 1..9 路 = file 0..8(黑 1 路最左)。
 */
const fileOfColumn = (side: Side, col: number): number => (side === 'red' ? 9 - col : col - 1);

const inBoardRank = (rank: number): boolean => rank >= 0 && rank < 10;

const PIECE_CHARS: Record<string, string> = {
  车: 'rook', 車: 'rook',
  马: 'horse', 馬: 'horse',
  炮: 'cannon', 砲: 'cannon',
  象: 'elephant', 相: 'elephant',
  士: 'advisor', 仕: 'advisor',
  将: 'general', 將: 'general', 帅: 'general', 帥: 'general',
  兵: 'pawn', 卒: 'pawn',
};

// 坐标:a1-a10..i1-i10,可带/不带分隔符(归一化后分隔符已去除)
const COORD_RE = /^([a-i])(10|[1-9])([a-i])(10|[1-9])$/;
// 中文记谱:[前/後?]棋子[列号?]进退平[数字]
const CN_RE = /^([前后後])?([一-鿿])([一二三四五六七八九十0-9])?([进進退平])([一二三四五六七八九十0-9])$/;

function inBoard(s: Sq): boolean {
  return s.file >= 0 && s.file < 9 && s.rank >= 0 && s.rank < 10;
}

/**
 * 统一合规校验:坐标与中文记谱最终都收敛为 Move。
 * 起点必须是本方棋子,且该走法必须出现在该方合法走法(含送将过滤)中,否则打回。
 */
function validateMove(board: Board, side: Side, move: Move): ParseResult {
  if (!inBoard(move.from) || !inBoard(move.to)) return { ok: false, reason: 'OUT_OF_BOARD' };
  const p = pieceAt(board, move.from);
  if (!p || p.side !== side) return { ok: false, reason: 'PIECE_NOT_FOUND' };
  for (const lm of legalMoves(board, side)) {
    if (lm.from.file === move.from.file && lm.from.rank === move.from.rank
      && lm.to.file === move.to.file && lm.to.rank === move.to.rank) {
      return { ok: true, move };
    }
  }
  return { ok: false, reason: 'ILLEGAL_MOVE' };
}

/**
 * 由 already-resolved 的起点棋子与 进/退/平 计算目标格(不含合法性)。
 * - 车/炮/兵/将(直线):进/退 N 步,平 N 为目的列号。
 * - 马/象/士(斜行):进/退 N 为目的列号,行差由棋种几何决定;无「平」。
 */
function computeTarget(
  side: Side,
  type: string,
  from: Sq,
  action: Action,
  num: number,
): { ok: true; move: Move } | { ok: false; reason: string } {
  const diag = type === 'horse' || type === 'elephant' || type === 'advisor';
  const fwd = side === 'red' ? 1 : -1;   // 进 的 rank 增量(黑在顶,进 = rank 递减)
  let to: Sq;

  if (action === 'lane') {
    if (diag) return { ok: false, reason: 'PARSER_INVALID' };   // 马/象/士 无「平」
    const f = fileOfColumn(side, num);
    if (f < 0 || f > 8) return { ok: false, reason: 'OUT_OF_BOARD' };
    to = { file: f, rank: from.rank };
  } else {
    const sign = action === 'advance' ? fwd : -fwd;
    if (diag) {
      const f = fileOfColumn(side, num);
      if (f < 0 || f > 8) return { ok: false, reason: 'OUT_OF_BOARD' };
      const df = Math.abs(f - from.file);
      const mag = type === 'horse'
        ? (df === 1 ? 2 : df === 2 ? 1 : 0)
        : type === 'elephant'
          ? (df === 2 ? 2 : 0)
          : (df === 1 ? 1 : 0);
      if (mag === 0) return { ok: false, reason: 'PARSER_INVALID' };
      to = { file: f, rank: from.rank + sign * mag };
    } else {
      to = { file: from.file, rank: from.rank + sign * num };
    }
  }

  if (!inBoard(to)) return { ok: false, reason: 'OUT_OF_BOARD' };
  return { ok: true, move: { from, to } };
}

function parseChinese(s: string, board: Board, side: Side): ParseResult {
  const m = CN_RE.exec(s);
  if (!m) return { ok: false, reason: 'PARSER_INVALID' };

  const type = PIECE_CHARS[m[2]!];
  if (!type) return { ok: false, reason: 'UNKNOWN_PIECE' };

  const col = m[3] == null ? null : digit(m[3]);
  const num = digit(m[5]);
  if (num === null || (col === null && !m[1])) return { ok: false, reason: 'PARSER_INVALID' };
  const action: Action = m[4] === '退' ? 'retreat' : m[4] === '平' ? 'lane' : 'advance';

  // 收集该方全部同型棋子
  const cands: Sq[] = [];
  for (let i = 0; i < board.length; i++) {
    const p = board[i];
    if (p && p.side === side && p.type === type) cands.push({ file: i % 9, rank: Math.floor(i / 9) });
  }
  if (cands.length === 0) return { ok: false, reason: 'PIECE_NOT_FOUND' };

  const colFile = col === null ? null : fileOfColumn(side, col);
  let from: Sq;

  if (m[1]) {
    // 前/后:同线(同 file)双子使用,列号通常省去;绝不猜测,多解一律歧义
    const byFile = new Map<number, Sq[]>();
    for (const c of cands) {
      const arr = byFile.get(c.file);
      if (arr) arr.push(c); else byFile.set(c.file, [c]);
    }
    // 含 ≥2 枚同型子的 file;若有两个以上这样的 file 且无列号定址,无法确定「前/后」指哪一列 → 歧义
    const pairFiles = [...byFile.entries()].filter(([, arr]) => arr.length >= 2);
    let pool: Sq[] | null = null;
    if (pairFiles.length === 1 && (colFile === null || pairFiles[0][0] === colFile)) {
      pool = pairFiles[0][1];
    } else if (pairFiles.length === 0 && colFile !== null && cands.length === 1) {
      pool = cands;   // 退化:唯一同型子且带列号
    }
    if (pool === null) return { ok: false, reason: 'PARSER_AMBIGUOUS' };
    // 前 = 靠近敌方;红 rank 大、黑 rank 小
    const sorted = [...pool].sort((a, b) => (side === 'red' ? b.rank - a.rank : a.rank - b.rank));
    from = m[1] === '前' ? sorted[0] : sorted[sorted.length - 1];
  } else {
    const onCol = cands.filter((c) => c.file === colFile!);
    if (onCol.length === 0) return { ok: false, reason: 'PIECE_NOT_FOUND' };
    if (onCol.length > 1) return { ok: false, reason: 'PARSER_AMBIGUOUS' };
    from = onCol[0];
  }

  const t = computeTarget(side, type, from, action, num);
  if (!t.ok) return t;
  // 仅返回结构可解析的走法;合法性校验由上层(parseMove / resolver parseResolve)统一做。
  return { ok: true, move: t.move };
}

/**
 * 结构解析(不含合法性):自由文本 → 具体走法。
 * 只做:归一化、坐标/中文记谱语法、棋子定位与起点归属;
 * 不做 legalMoves 校验(与 parseMove 的区别在后者追加 validateMove)。
 * 供 resolver/打回诊断复用:解析层一次,合法性矩阵按回合缓存,避免重复计算。
 */
export function parseMoveRaw(text: string, board: Board, side: Side): ParseResult {
  const s = normalize(text);
  if (s.length === 0) return { ok: false, reason: 'PARSER_INVALID' };

  const c = COORD_RE.exec(s);
  if (c) {
    const move: Move = {
      from: { file: c[1]!.charCodeAt(0) - 97, rank: Number(c[2]) - 1 },
      to: { file: c[3]!.charCodeAt(0) - 97, rank: Number(c[4]) - 1 },
    };
    const p = pieceAt(board, move.from);
    if (!p || p.side !== side) return { ok: false, reason: 'PIECE_NOT_FOUND' };
    return { ok: true, move };
  }
  return parseChinese(s, board, side);
}

/**
 * 自由文本 → 已校验走法(含合法矩阵过滤;送将/非法统一 ILLEGAL_MOVE)。
 * 支持:坐标 `h3-e3`/`h3e3`、中文记谱(红/黑双向,含同线双子前/后)、空格/全角词法容错。
 * 解析不出/歧义/非法一律 { ok:false } 并带稳定 reason。
 */
export function parseMove(text: string, board: Board, side: Side): ParseResult {
  const r = parseMoveRaw(text, board, side);
  if (!r.ok) return r;
  return validateMove(board, side, r.move);
}