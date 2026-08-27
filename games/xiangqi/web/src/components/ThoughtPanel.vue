<script setup lang="ts">
//
// ThoughtPanel —— 单方思考卡(Task 19 + 信息层次优化)。
// 展示:模型名、总耗时、思考历史(每回合一条,「第n回合」前缀,最新在前)、
// 进行中的「当前」流式思考、每回合耗时/token、总 token / 总成本、裁判打回计数。
//
import { computed } from 'vue';
import type { Side } from '../../../engine/types';
import { fmtMs } from '../lib/format';
import type { ThoughtEntry } from '../composables/useGame';

const props = withDefaults(
  defineProps<{
    side: Side;
    name: string;
    model?: string;
    /** 该方已落子的思考历史,最新在前(倒序);进行中的「当前」单独走 liveText。 */
    entries: ThoughtEntry[];
    /** 进行中的流式思考文本(active 时展示,前缀「当前」;落子后并入 entries 变为「第n回合」)。 */
    liveText: string;
    /** 是否在思考中(行棋方 & running)。 */
    active: boolean;
    /** 汇总:该方累计耗时 / token。成本暂不展示(算不清)。 */
    elapsedMs: number;
    promptTokens: number;
    completionTokens: number;
    rejections: number;
    /** 规则失误分阶段计数(finish 携带;T20):教学前 = 首次被打回前累计,教学后 = 被拒后重犯。 */
    violations?: { pre: number; post: number; total?: number } | null;
    /** 对局是否已终局(finish 到达;T20):状态区改为「已终局」标注。 */
    finished?: boolean;
  }>(),
  { model: undefined, violations: null, finished: false },
);

const totalTokens = computed(() => props.promptTokens + props.completionTokens);
const glyph = computed(() => (props.side === 'red' ? '帥' : '將'));
const entryTokens = (e: ThoughtEntry): number => (e.promptTokens ?? 0) + (e.completionTokens ?? 0);
</script>

<template>
  <div class="p-card" :class="[side, { active, busy: active }]">
    <div class="p-head">
      <span class="p-mini" :class="side">{{ glyph }}</span>
      <span class="p-name">{{ name }}</span>
      <span class="p-model">{{ model || '未指定模型' }}</span>
      <span class="p-time" title="该方累计思考总耗时(含所有回合)"><span class="t-label">总耗时</span>{{ fmtMs(elapsedMs) }}</span>
    </div>

    <div class="p-state">
      <template v-if="finished">已终局</template>
      <template v-else-if="active">思考中…<span class="caret" aria-hidden="true"></span></template>
      <template v-else-if="rejections > 0">已遭裁判打回 · 等待对手</template>
      <template v-else>待机</template>
    </div>

    <div class="p-think">
      <!-- 进行中的当前思考(前缀「当前」;落子后转为「第n回合」并入历史) -->
      <div v-if="active && liveText" class="t-entry current" data-testid="think-current">
        <span class="t-tag current">当前</span>
        <span class="t-text">{{ liveText }}<span class="caret" aria-hidden="true"></span></span>
      </div>
      <span v-else-if="active" class="placeholder">……</span>

      <!-- 历史思考(已落子,最新在前:第5回合、第4回合…;新条目滑入) -->
      <TransitionGroup v-else-if="entries.length" tag="ul" name="entry" class="t-list" data-testid="think-history">
        <li v-for="(e, i) in entries" :key="e.round" class="t-entry" :class="{ latest: i === 0 }">
          <span class="t-tag">第{{ e.round }}回合</span>
          <span class="t-text">{{ e.text }}</span>
          <span class="t-meta">
            <span v-if="e.elapsedMs != null" class="tm-cell" :title="`第${e.round}回合耗时`">{{ fmtMs(e.elapsedMs) }}</span>
            <span v-if="entryTokens(e) > 0" class="tm-cell" :title="`第${e.round}回合 token(输入+输出)`">{{ entryTokens(e) }}</span>
          </span>
        </li>
      </TransitionGroup>
      <span v-else class="placeholder">尚无思考</span>
    </div>

    <div class="p-meta">
      <span class="m-cell" title="累计 token(输入+输出)">
        <span class="m-label">总token</span>{{ totalTokens }}
      </span>
      <span v-if="violations && violations.pre + violations.post > 0" class="viol" data-testid="viol-badge" title="规则失误分阶段:教学前=首次被打回前累计;教学后=被拒后重犯">
        教学前 ×{{ violations.pre }} · 教学后 ×{{ violations.post }}
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
  display: flex;
  align-items: center;
  gap: 4px;
}
.p-time .t-label {
  font-family: var(--font-body);
  font-size: 10px;
  color: var(--ink-soft);
  letter-spacing: 0.08em;
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
}
.p-think .placeholder {
  color: var(--ink-soft);
}
.t-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 新思考条目进场:轻滑入 + 淡入 */
.entry-enter-active {
  animation: entryIn 0.3s ease-out;
}
@keyframes entryIn {
  from {
    opacity: 0;
    transform: translateY(-6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@media (prefers-reduced-motion: reduce) {
  .entry-enter-active {
    animation: none;
  }
}
.t-entry {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.t-entry + .t-entry {
  border-top: 1px dashed var(--line);
  padding-top: 8px;
}
.t-entry.current {
  background: linear-gradient(180deg, rgba(201, 138, 58, 0.08), transparent);
  border: 1px solid rgba(201, 138, 58, 0.35);
  border-radius: 8px;
  padding: 6px 8px;
  margin-bottom: 2px;
}
.t-tag {
  align-self: flex-start;
  font-family: var(--font-body);
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--ink-soft);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 1px 7px;
  background: var(--panel-2);
}
.t-tag.current {
  color: var(--amber);
  border-color: rgba(201, 138, 58, 0.6);
  background: rgba(201, 138, 58, 0.1);
  font-weight: 600;
}
.t-text {
  font-family: var(--font-display);
  font-size: 15px;
  line-height: 1.6;
  color: var(--ink);
  white-space: pre-wrap;
  word-break: break-word;
}
.t-meta {
  display: flex;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--ink-soft);
}
.tm-cell {
  border: 1px solid var(--line);
  background: var(--panel-2);
  padding: 1px 6px;
  border-radius: 6px;
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
.viol {
  color: #b0563a;
  border: 1px solid rgba(200, 66, 44, 0.45);
  background: rgba(200, 66, 44, 0.07);
  padding: 2px 7px;
  border-radius: 8px;
  font-family: var(--font-body);
  font-size: 11px;
}
@media (prefers-reduced-motion: reduce) {
  .p-card.busy::before,
  .caret {
    animation: none;
  }
}
</style>
