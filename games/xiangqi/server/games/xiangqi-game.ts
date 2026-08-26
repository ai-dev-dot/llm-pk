//
// XiangqiGame —— 象棋规则实现(适配 `Game<Board, Move>`,spec §3 平台化)。
//
// 职责:唯一封印 engine 全部纯函数的适配层,`arena` 只依赖本实现的接口方法。
// - 不新增任何规则逻辑:initialState/render/apply/pieceAt/snapshotKey/moveId/moveKey/
//   resolve/classify/clearCache 全部委托 engine 既有纯函数;
// - `resolve` 收敛「自由文本 → 裁决」:parseResolve(解析+合法+送将+缓存)失败时用
//   `parseMoveRaw` 取尝试走法 + `engineReason` 产出中文讲评(绝不枚举合法走法,原则 D);
// - `moveId` 附中文记谱旁注(`moveToChinese`,参照展示);
// - 红黑共用**同一实例**(begin 只读 meta;裁决无 side 分支)——公证正确性由 235 项引擎测试担保。
//

import type { Board, Side } from '../../engine/board';
import { cloneBoard, initialBoard, opposite, pieceAt, sqToCode } from '../../engine/board';
import { moveToKey, requireApply } from '../../engine/attack';
import { classifyAll, snapshotKey } from '../../engine/judge';
import { moveToChinese, parseMoveRaw } from '../../engine/notation';
import { clearResolveCache, engineReason, parseResolve } from '../../engine/resolver';
import { renderAscii } from '../../engine/render';
import type { Move } from '../../engine/moves';
import type { Game, PieceInfo, ResolveOutcome } from '../game';

/** 自由文本走法 → 裁决(含打回讲评)。缓存语义与 arena 旧实现完全一致(cacheKey 透传)。 */
function resolveText(text: string, board: Board, side: Side, cacheKey?: string): ResolveOutcome<Move> {
  const outcome = parseResolve(text, board, side, cacheKey);
  if (outcome.ok) return { ok: true, code: 'OK', move: outcome.move };
  // 打回讲评需要「尝试的走法」给具体起因(马蹩腿/塞象眼…),引擎层 parseMoveRaw 可回取。
  const parsed = parseMoveRaw(text, board, side);
  const reasonText = engineReason(outcome.code, parsed.ok ? parsed.move : undefined, board, side);
  const attempt = parsed.ok ? { move: parsed.move } : {};
  return { ok: false, code: outcome.code, reasonText, ...attempt };
}

/** 单个长期实例:竞技场把 gameId/finish 生命周期交给 arena,本对象只承载规则。 */
export const xiangqiGame: Game<Board, Move> = {
  meta: {
    name: 'xiangqi',
    sides: ['red', 'black'],
    drawRule: '简化裁定:重复局面 / 无进攻子力 / 步数上限判和,不作长将长捉精细裁定。',
  },

  initialState: () => cloneBoard(initialBoard()),

  render: (board) => renderAscii(board),

  apply: (board, move) => requireApply(board, move),

  pieceAt: (board, sq): PieceInfo | null => {
    const p = pieceAt(board, sq);
    return p ? { side: p.side, type: p.type } : null;
  },

  opposite: (side) => opposite(side),

  snapshotKey: (board, turn) => snapshotKey(board, turn),

  squareId: (sq) => sqToCode(sq),

  destination: (move) => move.to,

  moveId: (move, board) => {
    // 走前局面下 from 的棋子即行棋方;盘面异常无子则记谱留空(日志仍带坐标)。
    const p = pieceAt(board, move.from);
    const notation = p ? moveToChinese(move, board, p.side) : undefined;
    return { from: sqToCode(move.from), to: sqToCode(move.to), notation };
  },

  moveKey: (move) => moveToKey(move),

  resolve: (text, board, side, cacheKey) => resolveText(text, board, side, cacheKey),

  classify: (board, turn, ctx) => {
    const r = classifyAll(
      { board, turn, halfMoves: ctx.halfMoves, moveCount: ctx.moveCount, history: ctx.history },
      ctx.maxTotalMoves,
      ctx.drawRepeat,
    );
    // engine 返回 reason: null → 接口契约为 undefined(平台化类型归一)
    return { type: r.type, reason: r.reason ?? undefined };
  },

  clearCache: () => clearResolveCache(),
};