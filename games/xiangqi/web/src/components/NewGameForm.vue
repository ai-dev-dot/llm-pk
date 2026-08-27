<script setup lang="ts">
//
// NewGameForm —— 新局配置表单(Task 19)。
// 红/黑各填 baseUrl/apiKey/model(必填)+ 可选 systemPrompt;提交冒泡给宿主 createGame。
// apiKey 仅存于浏览器内存,随 createGame 直接 POST,绝不落上方任何状态。
//
import { reactive, ref } from 'vue';
import type { NewGameConfig, SideConfig } from '../composables/useGame';

defineProps<{
  submitting?: boolean;
  error?: string | null;
}>();

const emit = defineEmits<{
  (e: 'submit', cfg: NewGameConfig): void;
}>();

function emptySide(): SideConfig {
  return { baseUrl: '', apiKey: '', model: '', systemPrompt: '' };
}

const form = reactive({
  red: emptySide(),
  black: emptySide(),
});

const localValid = ref(true);

/**
 * 一侧的填写状态:
 * - 'empty'    三要素全空 → 回落服务器 config.json 的 red.use/black.use profile;
 * - 'complete' 三要素填全 → 表单直填;
 * - 'partial'  只填了一部分 → 本地拦截(避免半套配置打到错误端点)。
 */
function sideState(s: SideConfig): 'empty' | 'complete' | 'partial' {
  const filled = [s.baseUrl, s.apiKey, s.model].filter((v) => (v ?? '').trim() !== '').length;
  if (filled === 0) return 'empty';
  return filled === 3 ? 'complete' : 'partial';
}

function submit(): void {
  localValid.value = sideState(form.red) !== 'partial' && sideState(form.black) !== 'partial';
  if (!localValid.value) return;
  const norm = (s: SideConfig) => ({
    baseUrl: s.baseUrl.trim(),
    apiKey: s.apiKey.trim(),
    model: s.model.trim(),
    systemPrompt: (s.systemPrompt ?? '').trim() || undefined,
    maxTokens: s.maxTokens,
    timeoutMs: s.timeoutMs,
  });
  emit('submit', { red: norm(form.red), black: norm(form.black) });
}
</script>

<template>
  <form class="new-form" data-testid="new-game-form" @submit.prevent="submit">
    <h2 class="form-title">开一局</h2>
    <p class="form-note">
      红黑可对不同的模型供应商/模型;apiKey 仅存于本浏览器内存,随请求直发后端,不落 UI 状态。<br />
      每方<strong>全部留空</strong>则使用服务器 config.json 中 <code>red.use</code>/<code>black.use</code> 指定的模型;直填则以表单为准。
    </p>

    <div class="side-grid">
      <fieldset class="side-col red" data-side="red">
        <legend>红方 · 先手</legend>
        <label>baseUrl<input v-model="form.red.baseUrl" type="url" placeholder="留空用服务器默认,或填 https://…/anthropic" /></label>
        <label>apiKey<input v-model="form.red.apiKey" type="password" placeholder="留空用服务器默认,或填 sk-…" /></label>
        <label>model<input v-model="form.red.model" type="text" placeholder="留空用默认,或填模型名" /></label>
        <label class="wide">systemPrompt(可选)<textarea v-model="form.red.systemPrompt" rows="2" placeholder="角色/规则补充,空则用默认模板" /></label>
      </fieldset>

      <fieldset class="side-col black" data-side="black">
        <legend>黑方 · 后手</legend>
        <label>baseUrl<input v-model="form.black.baseUrl" type="url" placeholder="留空用服务器默认,或填 https://…/anthropic" /></label>
        <label>apiKey<input v-model="form.black.apiKey" type="password" placeholder="留空用服务器默认,或填 sk-…" /></label>
        <label>model<input v-model="form.black.model" type="text" placeholder="留空用默认,或填模型名" /></label>
        <label class="wide">systemPrompt(可选)<textarea v-model="form.black.systemPrompt" rows="2" placeholder="角色/规则补充,空则用默认模板" /></label>
      </fieldset>
    </div>

    <div class="form-actions">
      <p v-if="!localValid" class="form-error" data-testid="form-error">每方需填全 baseUrl / apiKey / model 三项,或全部留空使用服务器 config.json 默认模型</p>
      <p v-else-if="error" class="form-error" data-testid="form-error">{{ error }}</p>
      <button class="btn pri" type="submit" :disabled="submitting" data-testid="submit">
        {{ submitting ? '创建中…' : '⚔ 开始对局' }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.new-form {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 20px 22px;
  width: min(760px, 100%);
  margin: 24px auto;
}
.form-title {
  font-family: var(--font-display);
  font-size: 20px;
  letter-spacing: 0.14em;
  margin: 0 0 4px;
}
.form-note {
  font-size: 12px;
  color: var(--ink-soft);
  line-height: 1.6;
  margin: 0 0 14px;
}
.side-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
@media (max-width: 720px) {
  .side-grid {
    grid-template-columns: 1fr;
  }
}
.side-col {
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel-2);
  padding: 12px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.side-col legend {
  font-family: var(--font-display);
  font-size: 15px;
  letter-spacing: 0.08em;
  padding: 0 6px;
  color: var(--ink);
}
.side-col.red legend {
  color: var(--red);
}
.side-col.black legend {
  color: #e0d4bb;
}
label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--ink-dim);
}
label.wide {
  grid-column: 1 / -1;
}
input,
textarea {
  background: var(--bg-2);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
  font-family: var(--font-mono);
  font-size: 13px;
}
input:focus,
textarea:focus {
  outline: 2px solid var(--red);
  outline-offset: 0;
}
textarea {
  resize: vertical;
  font-family: var(--font-body);
}
.form-actions {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 16px;
}
.form-error {
  color: #c98a3a;
  font-size: 12px;
  margin: 0;
}
.btn {
  appearance: none;
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 13px;
  padding: 8px 14px;
  border-radius: 9px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.btn.pri {
  background: var(--red);
  border-color: var(--red);
  color: #f6ead6;
  font-weight: 600;
}
.btn.pri:hover:not(:disabled) {
  background: var(--red-dim);
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>