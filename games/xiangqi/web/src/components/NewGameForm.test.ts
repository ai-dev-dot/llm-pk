//
// NewGameForm 渲染测试:
// - 全部留空 → 允许提交(回落服务器 config.json 的 red.use/black.use profile),不报错;
// - 部分填写(三要素只填了一部分)→ 本地拦截、显示错误、不 emit;
// - 填全 → emit submit 携带红黑配置。
//
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import NewGameForm from './NewGameForm.vue';

/** fieldset 内 input 顺序固定:[0]=baseUrl(url)、[1]=apiKey(password)、[2]=model(text)。 */
async function fillSide(w: ReturnType<typeof mount>, side: 'red' | 'black', vals: [string, string, string]) {
  const fs = w.get(`fieldset[data-side="${side}"]`);
  const inputs = fs.findAll('input');
  await inputs[0]!.setValue(vals[0]);
  await inputs[1]!.setValue(vals[1]);
  await inputs[2]!.setValue(vals[2]);
}

describe('NewGameForm', () => {
  it('全部留空点击提交:emit submit(回落服务器 config),不显示错误', async () => {
    const w = mount(NewGameForm, { props: { error: null } });
    await w.get('form').trigger('submit');
    expect(w.emitted('submit')).toHaveLength(1);
    expect(w.find('[data-testid="form-error"]').exists()).toBe(false);
    const cfg = w.emitted('submit')![0]![0] as { red: { baseUrl: string; apiKey: string; model: string } };
    // 留空字段以空串下发,后端 nes() 视为未提供并回落 config profile
    expect(cfg.red.model).toBe('');
    expect(cfg.red.apiKey).toBe('');
  });

  it('部分填写(红方只填 model、缺 baseUrl/apiKey)→ 显示错误、不 emit', async () => {
    const w = mount(NewGameForm, { props: { error: null } });
    await fillSide(w, 'red', ['', '', 'red-model']);
    await w.get('form').trigger('submit');
    expect(w.get('[data-testid="form-error"]').text()).toContain('填全');
    expect(w.emitted('submit')).toBeUndefined();
  });

  it('填写完整点击提交:emit submit 携带红黑配置', async () => {
    const w = mount(NewGameForm, { props: { error: null } });
    await fillSide(w, 'red', ['https://r.example/anthropic', 'red-key', 'red-model']);
    await fillSide(w, 'black', ['https://b.example/anthropic', 'black-key', 'black-model']);

    await w.get('form').trigger('submit');
    const e = w.emitted('submit');
    expect(e).toHaveLength(1);
    const cfg = e![0]![0] as {
      red: { baseUrl: string; apiKey: string; model: string };
      black: { baseUrl: string; apiKey: string; model: string };
    };
    expect(cfg.red).toMatchObject({ baseUrl: 'https://r.example/anthropic', apiKey: 'red-key', model: 'red-model' });
    expect(cfg.black).toMatchObject({ baseUrl: 'https://b.example/anthropic', apiKey: 'black-key', model: 'black-model' });
  });
});
