<script setup lang="ts">
//
// ThoughtPanel —— 单方思考卡(Task 19)。
// 沿用 demo 视觉(红/黑卡、busy 扫光、caret 闪烁),展示:模型名、耗时、思考文本、
// 累计 token / 成本(USD),以及「裁判打回」计数。
//
import { computed } from 'vue';
import type { Side } from '../../../engine/types';
import { fmtMs, fmtUsd } from '../lib/format';

const props = withDefaults(
  defineProps<{
    side: Side;
    name: string;
    model?: string;
    /** 该方当前展示文本(流式思考/最近一步 analysis),由 useGame.liveThoughts 驱动。 */
    text: string;
    /** 是否在思考中(行棋方 & running)。 */
    active: boolean;
    elapsedMs: number;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    rejections: number;
  }>(),
  { model: undefined },
);

const totalTokens = computed(() => props.promptTokens + props.completionTokens);
const glyph = computed(() => (props.side === 'red' ? '帥' : '將'));
</script>

<template>
  <div class="p-card" :class="[side, { active, busy: active }]">
    <div class="p-head">
      <span class="p-mini" :class="side">{{ glyph }}</span>
      <span class="p-name">{{ name }}</span>
      <span class="p-model">{{ model || '未指定模型' }}</span>
      <span class="p-time">{{ fmtMs(elapsedMs) }}</span>
    </div>

    <div class="p-state">
      <template v-if="active">
        思考中…<span class="caret" aria-hidden="true"></span>
      </template>
      <template v-else-if="rejections > 0">已遭裁判打回 · 等待对手</template>
      <template v-else>待机</template>
    </div>

    <div class="p-think">
      <slot name="think" :active="active" :text="text">
        <template v-if="text">{{ text }}<span v-if="active" class="caret" aria-hidden="true"></span></template>
        <span v-else-if="active" class="placeholder">……</span>
        <span v-else class="placeholder">尚无思考</span>
      </slot>
    </div>

    <div class="p-meta">
      <span class="m-cell" title="累计 token(输入+输出)">
        <span class="m-label">token</span>{{ totalTokens }}
      </span>
      <span class="m-cell" title="累计思考成本">
        <span class="m-label">成本</span>{{ fmtUsd(costUsd) }}
      </span>
      <span v-if="rejections > 0" class="rej">裁判打回 ×{{ rejections }}</span>
    </div>
  </div>
</template>

<style scoped>
.p-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 12px 14px;
}
.p-card.active {
  border-color: var(--red-dim);
  box-shadow: 0 0 0 1px rgba(200, 66, 44, 0.15), 0 8px 22px rgba(0, 0, 0, 0.3);
}
.p-card.busy::before {
  content: '';
  display: block;
  height: 2px;
  border-radius: 2px;
  width: 100%;
  background: linear-gradient(90deg, var(--red), transparent);
  animation: sweep 1.2s linear infinite;
}
@keyframes sweep {
  from {
    transform: translateX(-101%);
  }
  to {
    transform: translateX(101%);
  }
}
.p-head {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 7px;
}
.p-name {
  font-family: var(--font-display);
  font-size: 17px;
  letter-spacing: 0.1em;
}
.p-card.black .p-name {
  color: #e3d6bc;
}
.p-card.red .p-name {
  color: var(--red);
}
.p-model {
  font-size: 11px;
  color: var(--ink-soft);
  background: var(--panel-2);
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid var(--line);
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.p-time {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ink-dim);
}
.p-mini {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-display);
  font-size: 12px;
}
.p-mini.red {
  color: var(--red);
  border: 1px solid var(--red-dim);
}
.p-mini.black {
  color: #d8cbb2;
  border: 1px solid #5a5146;
}
.p-state {
  font-size: 11px;
  color: var(--ink-soft);
  min-height: 16px;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.caret {
  display: inline-block;
  width: 7px;
  height: 15px;
  background: var(--red);
  vertical-align: -2px;
  margin-left: 2px;
  animation: blink 1s steps(1) infinite;
}
@keyframes blink {
  50% {
    opacity: 0;
  }
}
.p-think {
  font-family: var(--font-display);
  font-size: 15px;
  line-height: 1.7;
  color: var(--ink-dim);
  min-height: 56px;
  border-top: 1px dashed var(--line);
  padding-top: 9px;
  white-space: pre-wrap;
  word-break: break-word;
}
.p-think .placeholder {
  color: var(--ink-soft);
}
.p-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-soft);
}
.m-cell .m-label {
  color: var(--ink-soft);
  margin-right: 3px;
}
.m-cell {
  border: 1px solid var(--line);
  background: var(--panel-2);
  padding: 2px 7px;
  border-radius: 8px;
}
.rej {
  color: #c98a3a;
  border: 1px solid rgba(201, 138, 58, 0.5);
  background: rgba(201, 138, 58, 0.08);
  padding: 2px 7px;
  border-radius: 8px;
  font-family: var(--font-body);
}
@media (prefers-reduced-motion: reduce) {
  .p-card.busy::before,
  .caret {
    animation: none;
  }
}
</style>