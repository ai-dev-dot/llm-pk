//
// 展示格式化(T19 forward [Low-1]):fmtReason 必须覆盖 server finish reason 码全集。
// 服务器侧 finish.reason 均为原始码(checkmate/stalemate/illegal-moves/timeout/internal-error/draw-*)。
//
import { describe, expect, it } from 'vitest';
import { fmtReason } from './format';

describe('fmtReason', () => {
  it('覆盖 server finish reason 码全集', () => {
    expect(fmtReason('checkmate')).toBe('絕殺');
    expect(fmtReason('stalemate')).toBe('困毙');
    expect(fmtReason('illegal-moves')).toBe('打回超限判负');
    expect(fmtReason('timeout')).toBe('网络超时判负');
    expect(fmtReason('internal-error')).toBe('对局异常终止');
    expect(fmtReason('draw-aborted')).toBe('强制中止');
    expect(fmtReason('draw-repeat')).toBe('重复局面 · 和棋');
    expect(fmtReason('draw-no-mating-material')).toBe('双方无进攻子力 · 和棋');
    expect(fmtReason('draw-max-moves')).toBe('步数上限 · 和棋');
    expect(fmtReason('draw-cost-limit')).toBe('成本上限 · 和棋');
  });

  it('未知码原样透传(hard-fail 兜底)', () => {
    expect(fmtReason('weird-code')).toBe('weird-code');
  });
});