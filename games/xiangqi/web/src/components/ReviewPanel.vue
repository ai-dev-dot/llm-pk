<script setup lang="ts">
//
// ReviewPanel —— 赛后 AI 复盘摘要卡(Task 20)。
// 渲染 `review` 事件(summary/keyPoints/model/耗时/成本);缺位时降级提示
// (终局后「生成中/不可用」或未终局「终局后生成」),绝不阻塞对局展示。
//
import { computed } from 'vue';
import { fmtMs, fmtUsd } from '../lib/format';

export interface ReviewPanelInput {
  summary: string;
  keyPoints?: string[];
  model?: string;
  elapsedMs?: number;
  usage?: { promptTokens?: number; completionTokens?: number; costUsd?: number };
}

const props = withDefaults(
  defineProps<{
    review?: ReviewPanelInput | null;
    /** 对局是否已终局(终局后才显示降级「生成中」)。 */
    gameOver?: boolean;
  }>(),
  { review: null, gameOver: false },
);

const costText = computed(() =>
  props.review?.usage?.costUsd != null && Number.isFinite(props.review.usage.costUsd) && props.review.usage.costUsd > 0
    ? fmtUsd(props.review.usage.costUsd)
    : '',
);
const timeText = computed(() => fmtMs(props.review?.elapsedMs ?? 0));
</script>

<template>
  <section class="review" data-testid="review-panel">
    <div class="rev-title">赛后复盘摘要</div>

    <template v-if="review">
      <p class="rev-summary" data-testid="review-summary">{{ review.summary }}</p>
      <ul v-if="review.keyPoints && review.keyPoints.length" class="rev-points" data-testid="review-points">
        <li v-for="(p, i) in review.keyPoints" :key="i">{{ p }}</li>
      </ul>
      <div v-if="review.model || timeText || costText" class="rev-meta">
        <span v-if="review.model" class="rv">{{ review.model }}</span>
        <span v-if="timeText" class="rv">{{ timeText }}</span>
        <span v-if="costText" class="rv cost">{{ costText }}</span>
      </div>
    </template>

    <p v-else-if="gameOver" class="rev-degraded" data-testid="review-degraded">
      复盘生成中…(或不可用);不影响本局结果
    </p>
    <p v-else class="rev-pending" data-testid="review-pending">终局后将自动生成 AI 复盘摘要</p>
  </section>
</template>

<style scoped>
.review {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 11px 14px;
}
.rev-title {
  font-size: 12px;
  color: var(--ink-dim);
  letter-spacing: 0.2em;
  margin-bottom: 8px;
}
.rev-summary {
  margin: 0 0 6px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--ink);
  white-space: pre-wrap;
  word-break: break-word;
}
.rev-points {
  list-style: none;
  margin: 0 0 8px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.rev-points li {
  font-size: 12px;
  color: var(--ink-soft);
  padding-left: 12px;
  position: relative;
}
.rev-points li::before {
  content: '·';
  position: absolute;
  left: 2px;
  color: var(--amber);
}
.rev-meta {
  display: flex;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ink-soft);
  flex-wrap: wrap;
}
.rev-meta .rv {
  border: 1px solid var(--line);
  background: var(--panel-2);
  padding: 2px 7px;
  border-radius: 8px;
}
.rev-meta .cost {
  color: var(--amber);
}
.rev-degraded,
.rev-pending {
  margin: 0;
  font-size: 12px;
  color: var(--ink-soft);
  line-height: 1.6;
}
.rev-degraded {
  color: var(--amber);
}
.rev-degraded::before {
  content: '◌ ';
}
</style>