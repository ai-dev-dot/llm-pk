//
// ReviewPanel 渲染测试:review 摘要/要点、缺位降级提示(生成中/不可用)、未终局提示。
//
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ReviewPanel, { type ReviewPanelInput } from './ReviewPanel.vue';

function mountR(props: { review?: ReviewPanelInput | null; gameOver?: boolean } = {}) {
  return mount(ReviewPanel, {
    props: { review: props.review ?? null, gameOver: props.gameOver ?? false },
  });
}

describe('ReviewPanel', () => {
  it('有 review:渲染摘要与关键要点、模型/耗时/成本', () => {
    const w = mountR({
      review: { summary: '红方弃马抢攻打开局面', keyPoints: ['中局兑子', '残局取胜'], model: 'cm', elapsedMs: 3000, usage: { promptTokens: 600, completionTokens: 90, costUsd: 0.0024 } },
      gameOver: true,
    });
    expect(w.get('[data-testid="review-summary"]').text()).toBe('红方弃马抢攻打开局面');
    expect(w.text()).toContain('中局兑子');
    expect(w.text()).toContain('残局取胜');
    expect(w.text()).toContain('cm');
    expect(w.text()).toContain('3.0s');
    expect(w.text()).toContain('$0.0024');
  });

  it('无 review 且已终局:降级提示「生成中/不可用」,不影响其余展示', () => {
    const w = mountR({ gameOver: true });
    const d = w.get('[data-testid="review-degraded"]');
    expect(d.text()).toMatch(/生成中|不可用/);
  });

  it('未终局:提示终局后生成', () => {
    const w = mountR({ gameOver: false });
    expect(w.get('[data-testid="review-pending"]').text()).toContain('终局后');
  });
});