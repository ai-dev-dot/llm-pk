//
// NewGameForm 渲染测试:必填校验、emit submit 携带红黑配置。
//
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import NewGameForm from './NewGameForm.vue';

describe('NewGameForm', () => {
  it('未填完整点击提交:显示错误、不 emit', async () => {
    const w = mount(NewGameForm, { props: { error: null } });
    await w.get('form').trigger('submit');
    expect(w.get('[data-testid="form-error"]').text()).toContain('红黑双方均须填写');
    expect(w.emitted('submit')).toBeUndefined();
  });

  it('填写完整点击提交:emit submit 携带红黑配置', async () => {
    const w = mount(NewGameForm, { props: { error: null } });
    const red = w.get('fieldset[data-side="red"]');
    const black = w.get('fieldset[data-side="black"]');
    const set = (fieldset: ReturnType<typeof w.get>, key: string, val: string) => {
      const input = fieldset.find(`input[placeholder*="${key}"]`) ?? fieldset.find(`input[placeholder="${key}"]`);
      input.setValue(val);
    };
    // baseUrl / apiKey / model 均用 placeholder 定位
    set(red, 'sk-', 'red-key');
    set(red, 'claude', 'red-model');
    set(red, 'api.anthropic', 'https://api.anthropic.com/v1');
    set(black, 'sk-', 'black-key');
    set(black, 'claude', 'black-model');
    set(black, 'api.anthropic', 'https://api.anthropic.com/v1');

    await w.get('form').trigger('submit');
    const e = w.emitted('submit');
    expect(e).toHaveLength(1);
    const cfg = e![0]![0] as { red: { model: string; apiKey: string }; black: { model: string } };
    expect(cfg.red.model).toBe('red-model');
    expect(cfg.red.apiKey).toBe('red-key');
    expect(cfg.black.model).toBe('black-model');
  });
});