//
// 展示格式化(成本/耗时/token)。
//

/** 金额:≥0.01 → 2 位;$0.01 以下用 4 位展示(单步成本多为 0.003x)。 */
export function fmtUsd(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  if (v <= 0) return '$0';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

/** 耗时:≥1s → x.x s,否则 xx ms。 */
export function fmtMs(ms: number): string {
  const v = Number.isFinite(ms) ? ms : 0;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}s`;
  return `${Math.round(v)}ms`;
}

/** 步数 → 回合(半回合计数;1&2 → 1 回合,3&4 → 2 回合)。 */
export function fmtRound(halfMoves: number): number {
  return Math.ceil(Math.max(halfMoves, 0) / 2);
}

/**
 * 终局原因 → 中文横幅副标题。
 * 键对齐 server finish.reason(原始引擎/守卫码):checkmate/stalemate/illegal-moves/timeout/
 * internal-error/draw-aborted/draw-repeat/draw-no-mating-material/draw-max-moves/draw-cost-limit。
 */
export function fmtReason(reason: string): string {
  const map: Record<string, string> = {
    checkmate: '絕殺',
    stalemate: '困毙',
    'illegal-moves': '打回超限判负',
    timeout: '网络超时判负',
    'internal-error': '对局异常终止',
    'draw-aborted': '强制中止',
    'draw-repeat': '重复局面 · 和棋',
    'draw-no-mating-material': '双方无进攻子力 · 和棋',
    'draw-max-moves': '步数上限 · 和棋',
    'draw-cost-limit': '成本上限 · 和棋',
  };
  return map[reason] ?? reason;
}