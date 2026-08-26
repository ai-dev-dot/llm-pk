import { pieceAt, sqToCode, type Board, type Side } from './board';
import type { Move } from './moves';
import { isInCheck, legalMoves, rawMovesFor, simulateApply } from './moves';
import { normalize, parseMoveRaw } from './notation';

/**
 * 裁决 reason 码(与 français 对齐)。
 * - PARSER_INVALID:  结构解析不出 / 拼写错误(含未知棋种)
 * - PARSER_AMBIGUOUS:同线双(多)子但缺前/后或列号无法定址
 * - ILLEGAL_MOVE:    结构可解析但走法本体非法(走形/被挡/起点非己方/越界)
 * - SUICIDE:         走法形状合法,但走后己方被将军 / 将帅照面(送将)
 * - OK:              通过全部校验
 */
export type ReasonCode = 'PARSER_INVALID' | 'PARSER_AMBIGUOUS' | 'ILLEGAL_MOVE' | 'SUICIDE' | 'OK';

export type ResolveOutcome =
  | { ok: true; move: Move; code: 'OK' }
  | { ok: false; code: Exclude<ReasonCode, 'OK'> };

// ---------- 回合级缓存 ----------
// 契约:cacheKey 由调用方以 (gameId, halfMove, round) 拼出,唯一标识一次「待裁决时刻」;
// 同一 cacheKey 内 board/side 必须保持不变(否则缓存失效由调用方负责)。
// 分隔符 `|`:normalize 只保留 [A-Za-z0-9] 与 CJK,天然将其剔净;side 亦不含它,
// 故 (cacheKey, s, side) 拼入 key 后可唯一反解,即使 cacheKey 自身含 `|` 也不碰撞。
const SEP = '|';
const outcomeCache = new Map<string, ResolveOutcome>();
const legalCache = new Map<string, Move[]>();

/** 清空内部缓存(每局开始 / 测试夹具可调用)。 */
export function clearResolveCache(): void {
  outcomeCache.clear();
  legalCache.clear();
}

const sameMove = (a: Move, b: Move): boolean =>
  a.from.file === b.from.file && a.from.rank === b.from.rank && a.to.file === b.to.file && a.to.rank === b.to.rank;

const moveInList = (m: Move, list: readonly Move[]): boolean => list.some((x) => sameMove(x, m));

/** 解析层 reason → 裁决码。结构可判定的非合法走法一律归 ILLEGAL_MOVE。 */
function mapFailureReason(reason: string): Exclude<ReasonCode, 'OK'> {
  switch (reason) {
    case 'PARSER_INVALID':
    case 'UNKNOWN_PIECE': // 结构性拼写错误(如「牛三进一」)
      return 'PARSER_INVALID';
    case 'PARSER_AMBIGUOUS':
      return 'PARSER_AMBIGUOUS';
    case 'PIECE_NOT_FOUND': // 起点非本方棋子
    case 'OUT_OF_BOARD': // 落点越界
    case 'ILLEGAL_MOVE': // 防御:解析层已给非法
      return 'ILLEGAL_MOVE';
    default:
      return 'PARSER_INVALID';
  }
}

/** 送将特判:走法在该棋子原始走法内、却不在合法清单 → 走完己方被将军(或照面)。 */
function isSelfCheckMove(board: Board, side: Side, move: Move): boolean {
  const raw = rawMovesFor(board, move.from, side);
  if (!moveInList(move, raw)) return false;
  return isInCheck(simulateApply(board, move), side);
}

/** 合法清单:同一 cacheKey 内只算一次,供本回合多次打回重试复用。 */
function getLegalMoves(cacheKey: string | undefined, board: Board, side: Side): Move[] {
  const key = cacheKey === undefined ? null : `${cacheKey}${SEP}legal${SEP}${side}`;
  if (key !== null) {
    const hit = legalCache.get(key);
    if (hit !== undefined) return hit;
  }
  const list = legalMoves(board, side);
  if (key !== null) legalCache.set(key, list);
  return list;
}

function resolveLegality(move: Move, cacheKey: string | undefined, board: Board, side: Side): ResolveOutcome {
  const legal = getLegalMoves(cacheKey, board, side);
  if (moveInList(move, legal)) return { ok: true, move, code: 'OK' };
  if (isSelfCheckMove(board, side, move)) return { ok: false, code: 'SUICIDE' };
  return { ok: false, code: 'ILLEGAL_MOVE' };
}

/**
 * 回合裁决收口:文本 → ResolveOutcome。
 * 流程:normalize → parseMoveRaw(结构解析,不含合法性)→ 合法矩阵校验(缓存) → 送将特判。
 * 缓存:当提供 cacheKey 时,以 (cacheKey, normalized-text, side) 为键,同输入不重复解析;
 * 同一 cacheKey 内 legalMoves 只计算一次。
 */
export function parseResolve(text: string, board: Board, side: Side, cacheKey?: string): ResolveOutcome {
  const s = normalize(text);
  const key = cacheKey === undefined ? null : `${cacheKey}${SEP}${s}${SEP}${side}`;
  if (key !== null) {
    const hit = outcomeCache.get(key);
    if (hit !== undefined) return hit;
  }

  const r = parseMoveRaw(s, board, side);
  const outcome: ResolveOutcome = !r.ok
    ? { ok: false, code: mapFailureReason(r.reason) }
    : resolveLegality(r.move, cacheKey, board, side);

  if (key !== null) outcomeCache.set(key, outcome);
  return outcome;
}

// ---------- 中文打回讲评(不枚举合法走法) ----------

/** 马走「日」中「腿」被挡才算蹩腿;非日字步形状返回 false(归「不在此步」)。 */
function blockedHorseLeg(board: Board, move: Move): boolean {
  const df = move.to.file - move.from.file;
  const dr = move.to.rank - move.from.rank;
  if (Math.abs(df) === 2 && Math.abs(dr) === 1) {
    return pieceAt(board, { file: move.from.file + Math.sign(df), rank: move.from.rank }) !== null;
  }
  if (Math.abs(df) === 1 && Math.abs(dr) === 2) {
    return pieceAt(board, { file: move.from.file, rank: move.from.rank + Math.sign(dr) }) !== null;
  }
  return false;
}

function illegalMoveReason(move: Move | undefined, board: Board | undefined, side: Side | undefined): string {
  if (!move || !board || !side) {
    return '该走法在当前局面下不成立,请重新斟酌后再落子。';
  }
  const from = move.from;
  const to = move.to;
  const p = pieceAt(board, from);
  if (!p || p.side !== side) {
    return `起点 ${sqToCode(from)} 没有你的棋子,请确认要动的是哪一枚。`;
  }
  const occupant = pieceAt(board, to);
  if (occupant && occupant.side === side) {
    return `落点 ${sqToCode(to)} 上是己方棋子,不能吃己方。`;
  }
  const fromS = sqToCode(from);
  const toS = sqToCode(to);
  switch (p.type) {
    case 'horse': {
      if (blockedHorseLeg(board, move)) {
        return `马从 ${fromS} 跳到 ${toS} 被蹩腿(马腿位置被棋子挡住)。`;
      }
      return `马不能从 ${fromS} 走到 ${toS}(不在马的「日」字步上)。`;
    }
    case 'elephant': {
      // L6:先验「斜走两格」形状(|Δf|==|Δr|==2),形状不就再取中点 —— 否则小斜步会误报塞象眼。
      const df = to.file - from.file;
      const dr = to.rank - from.rank;
      if (Math.abs(df) === 2 && Math.abs(dr) === 2) {
        const eye = pieceAt(board, { file: from.file + df / 2, rank: from.rank + dr / 2 });
        if (eye !== null) return `象从 ${fromS} 跳到 ${toS} 被塞象眼,不能过。`;
      }
      if ((side === 'red' && to.rank > 4) || (side === 'black' && to.rank < 5)) return '象不能过河。';
      return `象从 ${fromS} 走到 ${toS} 不可能(象只能斜走两格)。`;
    }
    case 'advisor':
      return `士/仕不能从 ${fromS} 走到 ${toS}(只能在九宫内沿斜线走一格)。`;
    case 'general':
      return `将/帅不能从 ${fromS} 走到 ${toS}(需在九宫内沿直线走一格)。`;
    case 'rook':
      return `车不能从 ${fromS} 走到 ${toS}(车只能沿直线走,且路径不能有棋子阻挡)。`;
    case 'cannon':
      return `炮不能从 ${fromS} 落到 ${toS}(直行须无遮挡;吃子须恰好隔一个炮架)。`;
    case 'pawn':
      return `兵/卒不能从 ${fromS} 走到 ${toS}(只能前进,过河后方可横走,绝不后退)。`;
    default:
      return '该棋子不能这样走。';
  }
}

/**
 * 打回中文讲评。精确说明原因、不枚举合法走法。
 * move/board/side 可省:只有 ILLEGAL_MOVE 需要局面信息给出起因,缺省时给通用文案。
 */
export function engineReason(code: ReasonCode, move?: Move, board?: Board, side?: Side): string {
  switch (code) {
    case 'OK':
      return '走法有效。';
    case 'PARSER_INVALID':
      return '无法理解你的走法,请使用中文记谱或坐标(起点-终点)重新落子。';
    case 'PARSER_AMBIGUOUS':
      return '你的走法存在歧义,无法确认具体是哪一枚棋子,请补全列号或用坐标明确指认。';
    case 'SUICIDE':
      return '这步走完后己方将帅会被对方攻击(或将帅照面),属于「送将」,不能这样走。';
    case 'ILLEGAL_MOVE':
      return illegalMoveReason(move, board, side);
  }
}