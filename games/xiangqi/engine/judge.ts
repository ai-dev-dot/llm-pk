import { legalMoves, isInCheck } from './moves';
import type { Board, Side } from './board';

export type Phase = 'ongoing' | 'check' | 'checkmate' | 'stalemate';

/** 和棋原因稳定码:重复局面 / 无可胜子力 / 步数上限。非和棋时为 null。 */
export type DrawReason = 'draw-repeat' | 'draw-no-mating-material' | 'draw-max-moves';

export type ClassifyAllType = Phase | 'draw';

/** classifyAll 输入:棋盘 + 轮走方 + 半回合计数 + 总步数 + 快照历史(由调度器填充)。 */
export interface JudgeState {
  board: Board;
  turn: Side;
  halfMoves: number;
  moveCount: number;
  history: string[];
}

export interface ClassifyAllResult {
  type: ClassifyAllType;
  reason: DrawReason | null;
}

/** 步数上限默认 200 半回合(spec: maxTotalMoves 可配)。 */
const DEFAULT_MAX_TOTAL_MOVES = 200;

/** 重复局面判和阈值默认 3 次(spec: drawRepeat 可配)。 */
const DEFAULT_DRAW_REPEAT = 3;

/** 进攻子力:车 / 马 / 炮 / 兵卒;仅剩将帅与仕相(士象)类防守子力即判无可胜子力。 */
function hasMatingMaterial(b: Board): boolean {
  return b.some(
    (p) => p !== null && (p.type === 'rook' || p.type === 'horse' || p.type === 'cannon' || p.type === 'pawn'),
  );
}

/**
 * 局面快照键:棋盘 90 格棋子序列 + 当前行棋方。
 * 每格编码:非空格 `side[0]+type[0]`(如 'rg' 红帅、'bc' 黑炮),空位 '.';
 * 末尾 `|` + turn。调度器每步后 push 该键到 history,供重复局面判定(count≥drawRepeat 判和,默认 3)复用。
 */
export function snapshotKey(b: Board, turn: Side): string {
  let s = '';
  for (const p of b) s += p === null ? '.' : p.side[0] + p.type[0];
  return s + '|' + turn;
}

/**
 * 局面综合判定(分类 + 和棋三态),判定次序:
 * 1. 将死 / 困毙(真实规则胜负优先于和棋);
 * 2. 步数上限:moveCount ≥ maxTotalMoves(默认 200)→ draw-max-moves;
 * 3. 无可胜子力:双方均无车马炮兵 → draw-no-mating-material;
 * 4. 重复局面:同 (board, turn) 快照在 history 计次 ≥3 → draw-repeat;
 * 5. 其余:check / ongoing(reason=null)。
 */
export function classifyAll(
  state: JudgeState,
  maxTotalMoves: number = DEFAULT_MAX_TOTAL_MOVES,
  drawRepeat: number = DEFAULT_DRAW_REPEAT,
): ClassifyAllResult {
  const { board, turn, moveCount, history } = state;
  const phase = classify(board, turn);
  if (phase === 'checkmate' || phase === 'stalemate') return { type: phase, reason: null };
  if (moveCount >= maxTotalMoves) return { type: 'draw', reason: 'draw-max-moves' };
  if (!hasMatingMaterial(board)) return { type: 'draw', reason: 'draw-no-mating-material' };
  const key = snapshotKey(board, turn);
  let repeats = 0;
  for (const k of history) if (k === key) repeats++;
  if (repeats >= drawRepeat) return { type: 'draw', reason: 'draw-repeat' };
  return { type: phase, reason: null };
}

/**
 * 局面分类(仅作分类;胜负推导由裁判层/后续任务负责):
 * - legalMoves 为空且被将军 → 'checkmate'(将死)
 * - legalMoves 为空且未被将军 → 'stalemate'(困毙——中国象棋困毙为负,但此处只分类)
 * - 有合法走且被将军 → 'check'
 * - 有合法走且未被将军 → 'ongoing'
 */
export function classify(b: Board, side: Side): Phase {
  const hasMoves = legalMoves(b, side).length > 0;
  const inCheck = isInCheck(b, side);
  if (!hasMoves) return inCheck ? 'checkmate' : 'stalemate';
  return inCheck ? 'check' : 'ongoing';
}