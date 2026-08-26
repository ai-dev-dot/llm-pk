//
// ThoughtPanel 渲染测试:名称/模型/思考流式/打回徽标/成本展示。
//
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ThoughtPanel from './ThoughtPanel.vue';

function mountCard(props: Record<string, unknown>) {
  return mount(ThoughtPanel, {
    props: {
      side: 'red',
      name: '红方',
      text: '',
      active: false,
      elapsedMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      rejections: 0,
      ...props,
    },
  });
}

describe('ThoughtPanel', () => {
  it('渲染名称与模型、初始成本归零', () => {
    const w = mountCard({ model: 'claude-3-5' });
    expect(w.text()).toContain('红方');
    expect(w.text()).toContain('claude-3-5');
    expect(w.text()).toContain('$0');
    expect(w.text()).toContain('待机');
  });

  it('active=true:显示思考中与闪烁 caret;text 展示流式内容', () => {
    const w = mountCard({ active: true, text: '先手拆中炮' });
    expect(w.text()).toContain('思考中');
    expect(w.text()).toContain('先手拆中炮');
    expect(w.findAll('.caret')).toHaveLength(2); // state + think 各一
  });

  it('打回徽标:rejections>0 显示「裁判打回 ×N」', () => {
    const w = mountCard({ rejections: 3 });
    expect(w.text()).toContain('裁判打回 ×3');
  });

  it('token 与成本聚合展示', () => {
    const w = mountCard({ promptTokens: 1000, completionTokens: 200, costUsd: 0.0031 });
    expect(w.text()).toContain('token');
    expect(w.text()).toContain('1200');
    expect(w.text()).toContain('$0.0031');
  });
});