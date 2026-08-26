<script setup lang="ts">
//
// Replay —— 单局回放视图(Task 20)。
// 读取 `GET /api/games/:id/replay` 事件数组;纯函数 boardAt 重建局面;
// 时间轴以事件 `seq` 为轴(播放/暂停/回退/单步/拖动);复用 XQBoard。
// 终局横幅标注『单局 · 未换色,胜负不作模型强弱结论』(与实时 GameView 同文案);
// 侧栏渲染 ReviewPanel(复盘摘要 / 缺位降级提示)。回放绝不触 arena 运行时。
//
import { computed, onBeforeUnmount } from 'vue';
import XQBoard from '../components/XQBoard.vue';
import ReviewPanel from '../components/ReviewPanel.vue';
import { useReplay } from '../composables/useReplay';
import type { ReplayMoveRecord } from '../lib/replay';
import { fmtMs, fmtRound, fmtReason, fmtUsd } from '../lib/format';

const props = defineProps<{
  gameId: string;
}>();

const emit = defineEmits<{
  (e: 'exit'): void;
}>();

const r = useReplay(props.gameId);

const meta = computed(() => ({
  round: fmtRound(r.moves.length),
  halfMoves: r.moves.length,
  elapsed: fmtMs(r.costs.total.elapsedMs),
  cost: fmtUsd(r.costs.total.costUsd),
}));

const maxStep = computed(() => {
  const last = r.steps[r.steps.length - 1];
  return typeof last === 'number' ? last : 0;
});

const atEnd = computed(() => r.cur >= maxStep.value && r.steps.length > 1);

const resultText = computed(() => {
  if (!r.result) return '';
  const w = r.result.winner;
  if (w === 'draw') return '和棋';
  return w === 'red' ? '红方 胜' : '黑方 胜';
});

const playLabel = computed(() => {
  if (r.playing) return '❚❚ 暂停';
  if (atEnd.value) return '↺ 重播';
  return '▶ 播放';
});

function onTogglePlay(): void {
  r.controls.toggle();
}
function onStep(): void {
  r.controls.step();
}
function onBack(): void {
  r.controls.back();
}
function onSeek(ev: Event): void {
  const v = Number((ev.target as HTMLInputElement).value);
  r.controls.seekTo(Number.isFinite(v) ? v : 0);
}
function moveLine(m: ReplayMoveRecord): string {
  return m.notation ?? m.moveCode;
}

onBeforeUnmount(() => {
  r.controls.destroy();
});
</script>

<template>
  <div class="replay" data-testid="replay-view">
    <main class="stage">
      <section class="board-frame">
        <XQBoard :pieces="r.board" :last-move="r.lastMove" />
        <div class="end-banner" :class="{ show: r.result !== null }">
          <template v-if="r.result">
            <div class="banner-result" data-testid="replay-result">{{ resultText }}</div>
            <div class="banner-reason">{{ fmtReason(r.result.reason) }}</div>
            <div class="banner-viol">
              红方打回 {{ r.result.ruleViolations.red.total }} · 黑方打回 {{ r.result.ruleViolations.black.total }}
            </div>
            <div class="banner-note" data-testid="replay-note">单局 · 未换色,胜负不作模型强弱结论</div>
          </template>
        </div>
        <span class="board-corner">replay</span>
        <div v-if="r.error" class="err-banner" data-testid="replay-error">
          {{ r.error }}<button class="btn" @click="emit('exit')">返回</button>
        </div>
      </section>

      <aside class="side">
        <div class="meta-bar">
          <span class="cell">回合 <b>{{ meta.round }}</b></span>
          <span class="divider"></span>
          <span class="cell">步数 <b data-testid="replay-half">{{ meta.halfMoves }}</b></span>
          <span class="divider"></span>
          <span class="cell">用时 <b>{{ meta.elapsed }}</b></span>
          <span class="divider"></span>
          <span class="cell cost">成本 <b>{{ meta.cost }}</b></span>
        </div>

        <div class="log-wrap">
          <div class="log-title">回放履历 <span class="n">{{ r.moves.length }} 步</span></div>
          <ul class="log-list">
            <li
              v-for="(m, i) in r.moves"
              :key="`${m.seq}:${i}`"
              class="log-item"
              :class="m.turn"
            >
              <span class="log-seq">{{ i + 1 }}</span>
              <span class="log-move">{{ moveLine(m) }}</span>
              <span class="log-t">{{ m.elapsedMs != null ? fmtMs(m.elapsedMs) : '—' }}</span>
              <span class="log-cost">{{ m.usage?.costUsd != null ? fmtUsd(m.usage.costUsd) : '' }}</span>
              <span v-if="m.analysis" class="log-a">{{ m.analysis }}</span>
            </li>
            <li v-if="r.moves.length === 0" class="log-empty">
              {{ r.phase === 'loading' ? '加载回放中…' : r.phase === 'error' ? '回放不可用' : '尚无着法' }}
            </li>
          </ul>
        </div>

        <ReviewPanel :review="r.review" :game-over="r.result !== null" />
      </aside>
    </main>

    <footer class="timeline">
      <div class="tl-left">
        <button class="btn" data-testid="replay-back" :disabled="r.cur <= 0 || r.phase !== 'ready'" title="回退一步" @click="onBack">
          ⏪
        </button>
        <button class="btn pri" data-testid="replay-play" :disabled="r.phase !== 'ready' || r.steps.length <= 1" @click="onTogglePlay">
          {{ playLabel }}
        </button>
        <button class="btn" data-testid="replay-step" :disabled="r.phase !== 'ready' || atEnd" title="前进一步" @click="onStep">
          ⏭
        </button>
        <span class="tl-pos" data-testid="replay-pos">{{ r.moves.length }} / {{ Math.max(r.steps.length - 1, 0) }} 步</span>
      </div>

      <div class="tl-slider">
        <input
          data-testid="replay-slider"
          type="range"
          :min="0"
          :max="maxStep"
          :step="1"
          :value="r.cur"
          :disabled="r.phase !== 'ready' || maxStep === 0"
          @input="onSeek"
          :aria-label="`回放时间轴:当前 seq ${r.cur}`"
        />
      </div>

      <div class="seg" role="group" aria-label="回放速度">
        <button v-for="s in [1, 2, 4]" :key="s" :class="{ on: r.speed === s }" data-testid="rt-speed" @click="r.controls.setSpeed(s)">
          {{ s }}×
        </button>
      </div>

      <button class="btn exit" data-testid="replay-exit" @click="emit('exit')">退出回放</button>
    </footer>
  </div>
</template>

<style scoped>
.replay {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
.stage {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 392px;
  gap: 18px;
  padding: 18px 24px;
  min-height: 0;
  overflow: hidden;
}
@media (max-width: 980px) {
  .stage {
    grid-template-columns: 1fr;
    overflow: visible;
  }
}
.board-frame {
  background: linear-gradient(160deg, var(--wood-1), var(--wood-2));
  border-radius: 10px;
  padding: 14px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.18);
  position: relative;
  align-self: start;
}
.board-frame :deep(svg) {
  display: block;
  height: calc(100vh - 250px);
  width: auto;
  max-width: 100%;
}
.board-corner {
  position: absolute;
  right: 12px;
  bottom: 6px;
  color: var(--wood-ink);
  opacity: 0.55;
  font-family: var(--font-display);
  font-size: 12px;
  letter-spacing: 0.1em;
}
.end-banner {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  justify-content: center;
  background: rgba(12, 8, 5, 0.55);
  backdrop-filter: blur(2px);
  border-radius: 10px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.4s;
  text-align: center;
}
.end-banner.show {
  opacity: 1;
  pointer-events: auto;
}
.banner-result {
  font-family: var(--font-display);
  font-size: 42px;
  letter-spacing: 0.12em;
  color: var(--ink);
  text-shadow: 0 3px 18px rgba(0, 0, 0, 0.6);
}
.banner-reason {
  color: var(--ink-dim);
  font-size: 14px;
  letter-spacing: 0.2em;
}
.banner-viol {
  color: var(--amber);
  font-size: 12px;
  font-family: var(--font-mono);
}
.banner-note {
  color: var(--ink-soft);
  font-size: 11px;
  letter-spacing: 0.08em;
  margin-top: 6px;
}
.err-banner {
  position: absolute;
  left: 12px;
  right: 12px;
  top: 12px;
  background: rgba(201, 138, 58, 0.16);
  border: 1px solid rgba(201, 138, 58, 0.6);
  color: var(--ink);
  border-radius: 10px;
  padding: 10px 14px;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.err-banner .btn {
  margin-left: auto;
}
.side {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
}
.side::-webkit-scrollbar {
  width: 6px;
}
.side::-webkit-scrollbar-thumb {
  background: var(--line);
  border-radius: 3px;
}
.meta-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--ink-dim);
  flex-wrap: wrap;
}
.meta-bar .cell {
  border: 1px solid var(--line);
  background: var(--panel);
  padding: 7px 12px;
  border-radius: 8px;
  display: flex;
  gap: 8px;
  align-items: center;
}
.meta-bar .cell b {
  color: var(--ink);
  font-family: var(--font-mono);
  font-weight: 600;
}
.meta-bar .cell.cost b {
  color: var(--amber);
}
.meta-bar .divider {
  width: 1px;
  height: 18px;
  background: var(--line);
}
.log-wrap {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 10px 12px 6px;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.log-title {
  font-size: 12px;
  color: var(--ink-dim);
  letter-spacing: 0.2em;
  margin: 2px 0 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.log-title .n {
  color: var(--ink-soft);
  font-family: var(--font-mono);
}
.log-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  min-height: 0;
}
.log-list::-webkit-scrollbar {
  width: 6px;
}
.log-list::-webkit-scrollbar-thumb {
  background: var(--line);
  border-radius: 3px;
}
.log-item {
  display: grid;
  grid-template-columns: 24px 1fr auto auto;
  gap: 8px;
  align-items: baseline;
  font-size: 13px;
  padding: 6px 4px;
  border-bottom: 1px solid rgba(58, 47, 34, 0.5);
}
.log-item:last-of-type {
  border-bottom: none;
}
.log-seq {
  color: var(--ink-soft);
  font-family: var(--font-mono);
  font-size: 11px;
}
.log-move {
  font-family: var(--font-display);
  font-size: 15px;
  color: var(--ink);
}
.log-item.red .log-move {
  color: var(--red);
}
.log-item.black .log-move {
  color: #e0d4bb;
}
.log-t,
.log-cost {
  color: var(--ink-soft);
  font-family: var(--font-mono);
  font-size: 11px;
}
.log-a {
  grid-column: 2/5;
  color: var(--ink-soft);
  font-size: 12px;
  line-height: 1.5;
  display: none;
}
.log-item:hover .log-a {
  display: block;
}
.log-empty {
  color: var(--ink-soft);
  font-size: 12px;
  list-style: none;
  padding: 6px 4px;
}
.timeline {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 24px;
  border-top: 1px solid var(--line);
  background: var(--panel);
}
.tl-left {
  display: flex;
  gap: 8px;
  align-items: center;
}
.tl-pos {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ink-soft);
  white-space: nowrap;
}
.tl-slider {
  flex: 1;
  min-width: 120px;
}
.tl-slider input[type='range'] {
  width: 100%;
  accent-color: var(--red);
  cursor: pointer;
}
.seg {
  display: flex;
  border: 1px solid var(--line);
  border-radius: 9px;
  overflow: hidden;
}
.seg button {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--ink-dim);
  padding: 8px 11px;
  font-family: var(--font-mono);
  font-size: 12px;
  cursor: pointer;
}
.seg button.on {
  background: var(--panel-2);
  color: var(--ink);
}
.seg button:hover {
  color: var(--ink);
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
  transition: border-color 0.15s, background 0.15s, transform 0.05s;
}
.btn:hover:not(:disabled) {
  border-color: var(--ink-soft);
}
.btn:active:not(:disabled) {
  transform: translateY(1px);
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
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
@media (max-width: 760px) {
  .timeline {
    flex-wrap: wrap;
  }
  .tl-slider {
    order: -1;
    flex-basis: 100%;
  }
}
</style>