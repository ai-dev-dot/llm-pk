//
// ThoughtPanel 渲染测试:名称/模型/「当前」流式思考/「第n回合」历史(耗时+token)/
// 打回徽标/总成本展示。
//
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ThoughtPanel from './ThoughtPanel.vue';

function mountCard(props: Record<string, unknown>) {
  return mount(ThoughtPanel, {
    props: {
      side: 'red',
      name: '红方',
      entries: [],
      liveText: '',
      active: false,
      elapsedMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      rejections: 0,
      ...props,
    },
  });
}

describe('ThoughtPanel', () => {
  it('渲染名称与模型、初始归零;无思考历史显示「尚无思考」', () => {
    const w = mountCard({ model: 'claude-3-5' });
    expect(w.text()).toContain('红方');
    expect(w.text()).toContain('claude-3-5');
    expect(w.text()).toContain('总耗时0ms');
    expect(w.text()).toContain('总token0');
    expect(w.text()).toContain('尚无思考');
    expect(w.text()).toContain('待机');
  });

  it('active + liveText:显示「思考中」、「当前」前缀与流式内容,caret 两处', () => {
    const w = mountCard({ active: true, liveText: '先手拆中炮' });
    expect(w.text()).toContain('思考中');
    expect(w.get('[data-testid="think-current"]').text()).toContain('当前');
    expect(w.text()).toContain('先手拆中炮');
    expect(w.findAll('.caret')).toHaveLength(2); // state + think 各一
  });

  it('active 但尚无流式内容:显示「……」占位', () => {
    const w = mountCard({ active: true, liveText: '' });
    expect(w.text()).toContain('……');
    expect(w.find('[data-testid="think-current"]').exists()).toBe(false);
  });

  it('已落子历史:倒序展示「第n回合」前缀,并带该回合耗时与 token', () => {
    const w = mountCard({
      entries: [
        { round: 2, text: '兑子争先', elapsedMs: 1800, promptTokens: 900, completionTokens: 80 },
        { round: 1, text: '架中炮', elapsedMs: 2100, promptTokens: 1000, completionTokens: 120 },
      ],
    });
    const hist = w.get('[data-testid="think-history"]');
    expect(hist.text()).toContain('第2回合');
    expect(hist.text()).toContain('第1回合');
    expect(hist.text()).toContain('兑子争先');
    expect(hist.text()).toContain('1.8s'); // 第2回合耗时
    expect(hist.text()).toContain('980'); // 第2回合 token(900+80)
    expect(hist.text()).toContain('2.1s'); // 第1回合耗时
    expect(hist.text()).toContain('1120'); // 第1回合 token(1000+120)
    // 最新在前:第2回合文本先于第1回合
    expect(hist.text().indexOf('兑子争先')).toBeLessThan(hist.text().indexOf('架中炮'));
    // 非思考中 → 无「当前」标签
    expect(w.find('[data-testid="think-current"]').exists()).toBe(false);
  });

  it('打回徽标:rejections>0 显示「裁判打回 ×N」', () => {
    const w = mountCard({ rejections: 3 });
    expect(w.text()).toContain('裁判打回 ×3');
  });

  it('汇总 token 聚合展示(总token)', () => {
    const w = mountCard({ promptTokens: 1000, completionTokens: 200 });
    expect(w.text()).toContain('总token1200');
  });

  it('violations 徽标:教学前/教学后 分显示(T20);总和为 0 不显示', () => {
    const w = mountCard({ violations: { pre: 2, post: 1 } });
    expect(w.get('[data-testid="viol-badge"]').text()).toContain('教学前 ×2');
    expect(w.get('[data-testid="viol-badge"]').text()).toContain('教学后 ×1');

    const w0 = mountCard({ violations: { pre: 0, post: 0 } });
    expect(w0.find('[data-testid="viol-badge"]').exists()).toBe(false);
  });

  it('finished 标注:显示「已终局」,不再显示待机', () => {
    const w = mountCard({ finished: true });
    expect(w.text()).toContain('已终局');
    expect(w.text()).not.toContain('待机');
  });
});
