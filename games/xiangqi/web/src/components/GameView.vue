<script setup lang="ts">
//
// GameView —— 单局实时观战视图(Task 19)。
// 装配:棋盘(XQBoard + 将军徽标 + 终局横幅)、meta 栏(回合/步数/用时/成本)、
// 双思考卡(ThoughtPanel)、记谱履历(悬停看 analysis)、控制条(GameControls)。
// 事件源为 useGame(WS 订阅 + since 断线续传);本组件只做展示与把控制动作煮成 REST。
//
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import XQBoard from './XQBoard.vue';
import ThoughtPanel from './ThoughtPanel.vue';
import GameControls from './GameControls.vue';
import { useGame, type NewGameConfig } from '../composables/useGame';
import type { MoveRecord } from '../composables/useGame';
import { fmtMs, fmtRound, fmtReason, fmtUsd } from '../lib/format';
import type { Side } from '../../../engine/types';

const props = defineProps<{
  gameId: string;
  config?: NewGameConfig;
}>();

const emit = defineEmits<{
  (e: 'restart'): void;
  (e: 'exit'): void;
}>();

const game = useGame(props.gameId);
const speed = ref(1);
const muted = ref(false);
const checkFlash = ref(false);

/* ---------- 将军徽标:check 事件触发一次闪光(1s 后收起) ---------- */
let checkTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => game.checkSeq,
  (seq, old) => {
    if (seq > 0 && seq !== old) {
      checkFlash.value = true;
      clearTimeout(checkTimer);
      checkTimer = setTimeout(() => {
        checkFlash.value = false;
      }, 1200);
    }
  },
);

onBeforeUnmount(() => {
  game.controls.destroy();
  clearTimeout(checkTimer);
});

/* ---------- 派生 ---------- */

const meta = computed(() => ({
  round: fmtRound(game.moves.length),
  halfMoves: game.moves.length,
  elapsed: fmtMs(game.costSummary.total.elapsedMs),
  cost: fmtUsd(game.costSummary.total.costUsd),
}));

const resultText = computed(() => {
  if (!game.result) return '';
  const w = game.result.winner;
  if (w === 'draw') return '和棋';
  return w === 'red' ? '红方 胜' : '黑方 胜';
});

function onTogglePlay(): void {
  if (game.phase === 'paused') void game.controls.resume();
  else if (game.phase === 'running') void game.controls.pause();
}
function onStep(): void {
  if (game.phase === 'paused') void game.controls.step();
}
function onSpeed(v: number): void {
  speed.value = v;
}
function onToggleMute(): void {
  muted.value = !muted.value;
}

const lastAnalysis = (side: Side): string => game.liveThoughts[side] ?? '';

function moveLine(m: MoveRecord): string {
  return m.notation ?? m.moveCode;
}
</script>

<template>
  <div class="game-view">
    <main class="stage">
      <section class="board-frame">
        <XQBoard :pieces="game.board" :last-move="game.lastMove" />
        <span v-if="checkFlash && game.checkSide" :key="game.checkSeq" class="check-badge show">将!</span>
        <div class="end-banner" :class="{ show: game.phase === 'finished' }">
          <template v-if="game.result">
            <div class="result" data-testid="result">{{ resultText }}</div>
            <div class="reason">{{ fmtReason(game.result.reason) }}</div>
            <div class="viol">
              红方打回 {{ game.result.ruleViolations.red.total }} · 黑方打回 {{ game.result.ruleViolations.black.total }}
            </div>
            <div class="note">单局 · 未换色,胜负不作模型强弱结论</div>
          </template>
        </div>
        <span class="board-corner">live</span>
        <div v-if="game.error" class="err-banner" data-testid="game-error">
          {{ game.error }}<button class="btn" @click="emit('exit')">返回新局</button>
        </div>
      </section>

      <aside class="side">
        <div class="meta-bar">
          <span class="cell">回合 <b data-testid="meta-round">{{ meta.round }}</b></span>
          <span class="divider"></span>
          <span class="cell">步数 <b data-testid="meta-half">{{ meta.halfMoves }}</b></span>
          <span class="divider"></span>
          <span class="cell">用时 <b>{{ meta.elapsed }}</b></span>
          <span class="divider"></span>
          <span class="cell cost">成本 <b data-testid="meta-cost">{{ meta.cost }}</b></span>
        </div>

        <ThoughtPanel
          side="red"
          name="红方"
          :model="game.models.red"
          :text="lastAnalysis('red')"
          :active="game.thinking.red"
          :elapsed-ms="game.costSummary.red.elapsedMs"
          :prompt-tokens="game.costSummary.red.promptTokens"
          :completion-tokens="game.costSummary.red.completionTokens"
          :cost-usd="game.costSummary.red.costUsd"
          :rejections="game.rejectCount.red"
        />
        <ThoughtPanel
          side="black"
          name="黑方"
          :model="game.models.black"
          :text="lastAnalysis('black')"
          :active="game.thinking.black"
          :elapsed-ms="game.costSummary.black.elapsedMs"
          :prompt-tokens="game.costSummary.black.promptTokens"
          :completion-tokens="game.costSummary.black.completionTokens"
          :cost-usd="game.costSummary.black.costUsd"
          :rejections="game.rejectCount.black"
        />

        <div class="log-wrap">
          <div class="log-title">对局履历 <span class="n">{{ game.moves.length }} 步</span></div>
          <ul class="log-list" data-testid="move-log">
            <li
              v-for="(m, i) in game.moves"
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
            <li v-if="game.moves.length === 0" class="log-empty" data-testid="log-empty">
              {{ game.phase === 'connecting' ? '连接中…' : '尚无着法' }}
            </li>
          </ul>
        </div>
      </aside>
    </main>

    <GameControls
      :status="game.phase"
      :speed="speed"
      :muted="muted"
      @toggle-play="onTogglePlay"
      @step="onStep"
      @restart="emit('restart')"
      @speed="onSpeed"
      @toggle-mute="onToggleMute"
    />
  </div>
</template>

<style scoped>
.game-view {
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
  height: calc(100vh - 210px);
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
.check-badge {
  position: absolute;
  left: 50%;
  top: 44%;
  transform: translate(-50%, -50%);
  font-family: var(--font-display);
  font-size: 34px;
  color: var(--seal);
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
  pointer-events: none;
  animation: checkPop 1.1s ease forwards;
}
@keyframes checkPop {
  0% {
    transform: translate(-50%, -50%) scale(0.6);
    opacity: 1;
  }
  40% {
    transform: translate(-50%, -50%) scale(1.12);
    opacity: 1;
  }
  100% {
    transform: translate(-50%, -50%) scale(1);
    opacity: 0;
  }
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
.end-banner .result {
  font-family: var(--font-display);
  font-size: 42px;
  letter-spacing: 0.12em;
  color: var(--ink);
  text-shadow: 0 3px 18px rgba(0, 0, 0, 0.6);
}
.end-banner .reason {
  color: var(--ink-dim);
  font-size: 14px;
  letter-spacing: 0.2em;
}
.end-banner .viol {
  color: var(--amber);
  font-size: 12px;
  font-family: var(--font-mono);
}
.end-banner .note {
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
.btn {
  appearance: none;
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 12px;
  padding: 6px 12px;
  border-radius: 8px;
  cursor: pointer;
}
.btn:hover {
  border-color: var(--ink-soft);
}
</style>