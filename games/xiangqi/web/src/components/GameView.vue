<script setup lang="ts">
//
// GameView —— 单局实时观战视图(Task 19)。
// 装配:棋盘(XQBoard + 将军徽标 + 终局横幅)、meta 栏(回合/步数/用时/成本)、
// 双思考卡(ThoughtPanel)、记谱履历(悬停看 analysis)、控制条(GameControls)。
// 事件源为 useGame(WS 订阅 + since 断线续传);本组件只做展示与把控制动作煮成 REST。
//
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import XQBoard from './XQBoard.vue';
import type { BoardAnim } from './XQBoard.vue';
import ThoughtPanel from './ThoughtPanel.vue';
import ReviewPanel from './ReviewPanel.vue';
import GameControls from './GameControls.vue';
import { useGame, type NewGameConfig, type MoveRecord, type ThoughtEntry } from '../composables/useGame';
import { applyMoveToPieces, initialPiecesWithUid, type UidPiece } from '../lib/replay';
import { fmtMs, fmtRound, fmtReason } from '../lib/format';
import { play, setMuted, unlock } from '../lib/sfx';
import type { Side, Sq } from '../../../engine/types';

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
      play('check'); // 将军警示音
      clearTimeout(checkTimer);
      checkTimer = setTimeout(() => {
        checkFlash.value = false;
      }, 1200);
    }
  },
);
// 终局音(phase 进入 finished 一次)
watch(
  () => game.phase,
  (p, old) => {
    if (p === 'finished' && old !== 'finished') play('finish');
  },
);

/* ---------- B5 音效:move/captured → Web Audio;🔊/🔇 真 toggle ---------- */
let soundSeq = 0;
let lastPieceCount = -1;
watch(
  () => game.events.length,
  (len) => {
    while (soundSeq < len) {
      const evt = game.events[soundSeq++]!;
      if (evt.type === 'move' && evt.legal !== false) {
        // 吃子可经棋盘子数下降识别(move 应用后减少 1)→ 吃子音;否则走子音
        const count = game.board.length;
        if (lastPieceCount >= 0 && count < lastPieceCount) play('capture');
        else play('move');
        lastPieceCount = count;
      }
    }
  },
  { immediate: true },
);
// 自动播放策略:首个用户手势解锁 AudioContext(header 点击/mute 按钮皆可)
let unlockCleanup: (() => void) | undefined;
onMounted(() => {
  const handler = () => unlock();
  window.addEventListener('pointerdown', handler, { capture: true });
  unlockCleanup = () => window.removeEventListener('pointerdown', handler, { capture: true });
});

/* ---------- 当前思考方 + 已思考时长(100ms tick;思考方切换自动重置) ---------- */
const thinkSide = computed<Side | null>(() =>
  game.thinking.red ? 'red' : game.thinking.black ? 'black' : null,
);
const thinkElapsed = ref(0);
let thinkTimer: ReturnType<typeof setInterval> | undefined;
let thinkStart = 0;
function resetThinkTimer(): void {
  clearInterval(thinkTimer);
  if (thinkSide.value) {
    thinkStart = performance.now();
    thinkElapsed.value = 0;
    thinkTimer = setInterval(() => {
      thinkElapsed.value = performance.now() - thinkStart;
    }, 100);
  }
}
watch(
  () => [game.thinking.red, game.thinking.black],
  resetThinkTimer,
  { immediate: true },
);

/* ---------- 终局存档(存 archive/;不存则提示手动复制路径) ---------- */
const archiving = ref(false);
const archiveMsg = ref('');
const archiveErr = ref(false);
async function onArchive(): Promise<void> {
  if (archiving.value) return;
  archiving.value = true;
  archiveMsg.value = '';
  archiveErr.value = false;
  try {
    const r = await game.controls.archive();
    archiveMsg.value =
      `对局日志 ${r.logFiles.length} 个 → archive/(随 git 入库);` +
      `调试日志 ${r.debugFiles.length} 个 → archive_debug/(不入库,本地留存)`;
  } catch (e) {
    archiveErr.value = true;
    archiveMsg.value = `存档失败:${e instanceof Error ? e.message : String(e)}`;
  } finally {
    archiving.value = false;
  }
}
function onSkipArchive(): void {
  archiveErr.value = false;
  archiveMsg.value = '未存档。可手动复制 logs/ 与 debug_logs/ 下对应文件';
}

onBeforeUnmount(() => {
  destroyed = true;
  game.controls.destroy();
  clearTimeout(checkTimer);
  clearTimeout(toastTimer);
  clearInterval(thinkTimer);
  unlockCleanup?.();
});

/* ---------- 裁判打回 toast(需求:打回留痕不中断观战;每次打回刷新同一条,3s 自动消失) ---------- */
const refereeToast = ref<{ side: Side; count: number } | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => game.rejections.length,
  (len, old) => {
    if (len <= (old ?? 0)) return;
    const newest = game.rejections[len - 1];
    if (!newest) return;
    refereeToast.value = { side: newest.side, count: game.rejectCount[newest.side] };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      refereeToast.value = null;
    }, 3000);
  },
);

/* ---------- 超时挂起的手动重试(重试超限不对局终止,对应方显示「已超时 + 重试」) ---------- */
const retrying = ref<Side | null>(null);
/** 挂起文案按成因区分:request-timeout=单步超时;network-exhausted=网络断连重试超限;null=旧日志缺省。 */
function stuckTitle(cause: 'request-timeout' | 'network-exhausted' | null): string {
  return cause === 'request-timeout' ? '单步超时' : cause === 'network-exhausted' ? '网络断连' : '已超时';
}
function stuckSub(cause: 'request-timeout' | 'network-exhausted' | null): string {
  return cause === 'request-timeout'
    ? '超过 15 分钟未响应,可重试'
    : cause === 'network-exhausted'
      ? '重试多次仍断连,可重试'
      : '等待重试';
}
function onRetry(side: Side): void {
  if (retrying.value) return;
  retrying.value = side;
  game.controls
    .retry(side)
    .catch(() => {
      /* 保持超时条,可再次触发 */
    })
    .finally(() => {
      retrying.value = null;
    });
}

/* ---------- 走子慢放(分阶段):①hover 待动子高亮闪烁 → ②path 带箭头路径高亮 → ③落子(重复 REPEAT 次) ---------- */
const REPEAT = 3;
const CYCLE_MS = 360; // 略大于 .pc transform transition(0.3s)
const displayBoard = ref<UidPiece[]>(initialPiecesWithUid());
const displayLastMove = ref<{ from: Sq; to: Sq } | null>(null);
const anim = ref<BoardAnim | null>(null);
let animSeq = 0;
let animQueue: { A: UidPiece[]; B: UidPiece[]; from: Sq; to: Sq; seq: number; turn: Side }[] = [];
let draining = false;
let destroyed = false;

// 慢放队列的「事实局面链」:由事件流逐步推进(与 useGame 的 game.board 同源),绝不依赖
// displayBoard 的实时快照——后者在动画补间进行中可能滞后,拿它作为下一步的 A 会让
// applyMoveToPieces 找不到 from 位子而触发兜底(在目标格生造 pawn → 观战误显示「红兵」)。
let moveChain: UidPiece[] = initialPiecesWithUid();

const raf = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function enqueueMove(from: Sq, to: Sq, seq: number, turn: Side): void {
  // A 永远取「事实局面链」的当前态;B = 下一步真实演进;队列逐帧补间 A→B。
  const A = moveChain.slice();
  moveChain = applyMoveToPieces(A.slice(), from, to, seq, turn);
  const B = moveChain.slice();
  animQueue.push({ A, B, from, to, seq, turn });
  void drainQueue();
}
async function drainQueue(): Promise<void> {
  if (draining || destroyed) return;
  draining = true;
  try {
    while (animQueue.length > 0 && !destroyed) {
      const item = animQueue.shift()!;
      const s = speed.value;
      // ① 待动子高亮闪烁(起点脉冲圈 + 目标格虚线)
      anim.value = { phase: 'hover', from: item.from, to: item.to, id: ++animSeq };
      await sleepMs(760 / s);
      if (destroyed) return;
      // ② 显示起点→终点带箭头路径并高亮(虚线流动)
      anim.value = { phase: 'path', from: item.from, to: item.to, id: ++animSeq };
      await sleepMs(800 / s);
      if (destroyed) return;
      // ③ 落子:回到未走状态 → 下一帧落下(补间 A→B),重复 REPEAT 次
      anim.value = null;
      for (let k = 0; k < REPEAT; k++) {
        displayBoard.value = item.A;
        await raf();
        displayBoard.value = item.B;
        await sleepMs(CYCLE_MS / s);
      }
      displayLastMove.value = { from: item.from, to: item.to };
    }
  } finally {
    anim.value = null;
    draining = false;
  }
}
// 监听实时 move 流(断线补发亦重放),入慢放队列;棋盘展示 displayBoard,实时数据仍走 game.*
let lastPlayedMoves = 0;
watch(
  () => game.moves.length,
  (n) => {
    while (lastPlayedMoves < n) {
      const m = game.moves[lastPlayedMoves]!;
      enqueueMove(m.from, m.to, m.seq, m.turn);
      lastPlayedMoves += 1;
    }
  },
  { immediate: true },
);

/* ---------- 顶部按钮浮层:对局履历 / 赛后复盘(不占用中间棋盘空间) ---------- */
const showLog = ref(false);
const showReview = ref(false);
function toggleLog(): void {
  showLog.value = !showLog.value;
  if (showLog.value) showReview.value = false;
}
function toggleReview(): void {
  showReview.value = !showReview.value;
  if (showReview.value) showLog.value = false;
}

/* ---------- 派生 ---------- */

const meta = computed(() => ({
  round: fmtRound(game.moves.length),
  halfMoves: game.moves.length,
  elapsed: fmtMs(game.costSummary.total.elapsedMs),
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
/* 重开确认:重开会结束当前对局并消耗费用,先确认再执行 */
const confirmRestart = ref(false);
function onRequestRestart(): void {
  confirmRestart.value = true;
}
function doRestart(): void {
  confirmRestart.value = false;
  emit('restart');
}
function cancelRestart(): void {
  confirmRestart.value = false;
}
function onToggleMute(): void {
  muted.value = !muted.value;
  unlock(); // 手势解锁 AudioContext
  setMuted(muted.value);
}

// 每方思考历史(最新在前):来自 moves 里该方各步,回合号 = 该步所在全局回合(fmtRound)。
// 进行中的「当前」由 liveThoughts 单独走 liveText,不混入历史。
const entries = computed(() => {
  const build = (side: Side): ThoughtEntry[] => {
    const out: ThoughtEntry[] = [];
    for (let i = game.moves.length - 1; i >= 0; i--) {
      const m = game.moves[i]!;
      if (m.turn !== side) continue;
      out.push({
        round: fmtRound(i + 1),
        text: m.analysis || m.notation || m.moveCode,
        elapsedMs: m.elapsedMs,
        promptTokens: m.usage?.promptTokens,
        completionTokens: m.usage?.completionTokens,
      });
    }
    return out;
  };
  return { red: build('red'), black: build('black') };
});

function moveLine(m: MoveRecord): string {
  return m.notation ?? m.moveCode;
}
</script>

<template>
  <div class="game-view">
    <!-- 裁判打回 toast(轻量留痕,不判负;连续打回刷新同一条) -->
    <Transition name="fade">
      <div v-if="refereeToast" class="referee-toast" data-testid="referee-toast">
        <span class="rt-ico">⚠</span>
        <span>{{ refereeToast.side === 'red' ? '红方' : '黑方' }} 已经 {{ refereeToast.count }} 次未遵守规则,被打回</span>
      </div>
    </Transition>

    <!-- 顶部公共 banner:控制条 + meta + 思考计时(不属于任何一方) -->
    <header class="gv-banner">
      <GameControls
        :status="game.phase"
        :speed="speed"
        :muted="muted"
        @toggle-play="onTogglePlay"
        @step="onStep"
        @restart="onRequestRestart"
        @speed="onSpeed"
        @toggle-mute="onToggleMute"
      />

      <div class="banner-right">
        <button class="btn" :class="{ on: showLog }" data-testid="toggle-log" @click="toggleLog">
          对局履历
        </button>
        <button class="btn" :class="{ on: showReview }" data-testid="toggle-review" @click="toggleReview">
          复盘
        </button>

        <div class="meta-bar">
          <span class="cell first">先手 <b data-testid="meta-first">{{ game.first === 'red' ? '红方' : '黑方' }}</b></span>
          <span class="divider"></span>
          <span class="cell">回合 <b :key="`r${game.moves.length}`" class="tick" data-testid="meta-round">{{ meta.round }}</b></span>
          <span class="divider"></span>
          <span class="cell">步数 <b :key="`h${game.moves.length}`" class="tick" data-testid="meta-half">{{ meta.halfMoves }}</b></span>
          <span class="divider"></span>
          <span class="cell">总用时 <b>{{ meta.elapsed }}</b></span>
        </div>

        <div v-if="thinkSide" class="think-timer" :class="thinkSide" data-testid="think-timer">
          <span class="beam"></span>
          {{ thinkSide === 'red' ? '红方' : '黑方' }}思考中 · 已思考 <b data-testid="think-elapsed">{{ fmtMs(thinkElapsed) }}</b>
        </div>
      </div>
    </header>

    <main class="stage">
      <!-- 左栏:黑方(棋盘上方一方) -->
      <aside class="side-pane left" data-pane="black">
        <div
          v-if="game.stuckSide === 'black' && game.phase === 'running'"
          class="stuck-banner black"
          data-testid="stuck-black"
        >
          <span class="sb-ico">⏱</span>
          <b>{{ stuckTitle(game.stuckCause) }}</b>
          <div class="sb-sub">{{ stuckSub(game.stuckCause) }}</div>
          <button
            class="sb-btn"
            :disabled="retrying === 'black'"
            data-testid="retry-black"
            @click="onRetry('black')"
          >
            {{ retrying === 'black' ? '重试中…' : '重试' }}
          </button>
        </div>
        <ThoughtPanel
          side="black"
          name="黑方"
          :model="game.models.black"
          :entries="entries.black"
          :live-text="game.liveThoughts.black"
          :active="game.thinking.black"
          :elapsed-ms="game.costSummary.black.elapsedMs"
          :prompt-tokens="game.costSummary.black.promptTokens"
          :completion-tokens="game.costSummary.black.completionTokens"
          :rejections="game.rejectCount.black"
          :violations="game.result?.ruleViolations.black"
          :finished="game.phase === 'finished'"
        />
      </aside>

      <!-- 中栏:棋盘(履历/复盘收纳到顶部按钮浮层,不挤占棋盘空间) -->
      <section class="board-col">
        <div class="board-frame">
          <XQBoard :pieces="displayBoard" :last-move="displayLastMove" :anim="anim" />
          <span v-if="checkFlash && game.checkSide" :key="game.checkSeq" class="check-badge show">将!</span>
          <div class="end-banner" :class="{ show: game.phase === 'finished' }">
            <template v-if="game.result">
              <div class="result" data-testid="result">{{ resultText }}</div>
              <div class="reason">{{ fmtReason(game.result.reason) }}</div>
              <div class="viol">
                红方打回 {{ game.result.ruleViolations.red.total }} · 黑方打回 {{ game.result.ruleViolations.black.total }}
              </div>
              <div class="note">单局 · 未换色,胜负不作模型强弱结论</div>
              <div class="archive-row">
                <button class="btn" :disabled="archiving" data-testid="archive-btn" @click="onArchive">
                  {{ archiving ? '存档中…' : '存档本局' }}
                </button>
                <button class="btn ghost" data-testid="archive-skip-btn" @click="onSkipArchive">不存档</button>
              </div>
              <div v-if="archiveMsg" class="archive-note" :class="{ err: archiveErr }" data-testid="archive-msg">
                {{ archiveMsg }}
              </div>
            </template>
          </div>
          <span class="board-corner">live</span>
          <div v-if="game.error" class="err-banner" data-testid="game-error">
            {{ game.error }}<button class="btn" @click="emit('exit')">返回新局</button>
          </div>
        </div>
      </section>

      <!-- 右栏:红方(棋盘下方一方) -->
      <aside class="side-pane right" data-pane="red">
        <div
          v-if="game.stuckSide === 'red' && game.phase === 'running'"
          class="stuck-banner red"
          data-testid="stuck-red"
        >
          <span class="sb-ico">⏱</span>
          <b>{{ stuckTitle(game.stuckCause) }}</b>
          <div class="sb-sub">{{ stuckSub(game.stuckCause) }}</div>
          <button
            class="sb-btn"
            :disabled="retrying === 'red'"
            data-testid="retry-red"
            @click="onRetry('red')"
          >
            {{ retrying === 'red' ? '重试中…' : '重试' }}
          </button>
        </div>
        <ThoughtPanel
          side="red"
          name="红方"
          :model="game.models.red"
          :entries="entries.red"
          :live-text="game.liveThoughts.red"
          :active="game.thinking.red"
          :elapsed-ms="game.costSummary.red.elapsedMs"
          :prompt-tokens="game.costSummary.red.promptTokens"
          :completion-tokens="game.costSummary.red.completionTokens"
          :rejections="game.rejectCount.red"
          :violations="game.result?.ruleViolations.red"
          :finished="game.phase === 'finished'"
        />
      </aside>
    </main>

    <!-- 浮层:对局履历 / 复盘(顶部按钮唤出,不占棋盘空间) -->
    <Transition name="panel">
      <div v-if="showLog" class="float-panel" data-testid="log-panel">
        <div class="fp-head">对局履历 <span class="n">{{ game.moves.length }} 步</span></div>
        <TransitionGroup tag="ul" name="log" class="log-list" data-testid="move-log">
          <li
            v-for="(m, i) in game.moves"
            :key="`${m.seq}:${i}`"
            class="log-item"
            :class="m.turn"
          >
            <span class="log-seq">{{ i + 1 }}</span>
            <span class="log-move">{{ moveLine(m) }}</span>
            <span class="log-t">{{ m.elapsedMs != null ? fmtMs(m.elapsedMs) : '—' }}</span>
            <span v-if="m.analysis" class="log-a">{{ m.analysis }}</span>
          </li>
          <li v-if="game.moves.length === 0" key="empty" class="log-empty" data-testid="log-empty">
            {{ game.phase === 'connecting' ? '连接中…' : '尚无着法' }}
          </li>
        </TransitionGroup>
      </div>
    </Transition>
    <Transition name="panel">
      <div v-if="showReview" class="float-panel" data-testid="review-panel">
        <div class="fp-head">赛后复盘</div>
        <ReviewPanel :review="game.review" :game-over="game.phase === 'finished'" />
      </div>
    </Transition>

    <!-- 重开确认:防止误触结束当前对局 -->
    <Transition name="fade">
      <div v-if="confirmRestart" class="confirm-mask" data-testid="confirm-mask" @click.self="cancelRestart">
        <div class="confirm-card">
          <div class="confirm-title">重新开一局?</div>
          <div class="confirm-sub">当前对局将立即结束(日志仍可回放);新建对局会重新消耗模型费用。</div>
          <div class="confirm-actions">
            <button class="btn" @click="cancelRestart">取消</button>
            <button class="btn danger" data-testid="confirm-restart" @click="doRestart">确认重开</button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.game-view {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
/* 顶部公共工具条:与 App 品牌栏合成视觉上一块(去独立边框/背景),控制 + meta + 思考计时 */
.gv-banner {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 6px 20px;
  border: none;
  background: transparent;
}
.banner-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
/* 三栏:左(黑,棋盘上方一方)/ 中(棋盘)/ 右(红,棋盘下方一方) */
.stage {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: grid;
  grid-template-columns: minmax(0, 340px) minmax(0, 1fr) minmax(0, 340px);
  gap: 16px;
  padding: 14px 20px;
}
@media (max-width: 980px) {
  .stage {
    grid-template-columns: 1fr;
    grid-template-rows: auto auto 1fr;
    overflow: visible;
  }
}
/* 思考计时徽章(当前思考方实时秒表) */
.think-timer {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 5px 12px;
  background: var(--panel-2);
  color: var(--ink-dim);
  white-space: nowrap;
}
.think-timer b {
  font-family: var(--font-mono);
  font-weight: 600;
  display: inline-block;
  animation: tickPop 0.3s ease-out;
}
.think-timer.red b {
  color: var(--red);
}
.think-timer.black b {
  color: #d8cbb2;
}
.think-timer .beam {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--amber);
  box-shadow: 0 0 10px var(--amber);
  animation: beamPulse 1s ease-in-out infinite;
}
@keyframes beamPulse {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}
.board-frame {
  flex: 1;
  min-width: 0;
  min-height: 360px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(160deg, var(--wood-1), var(--wood-2));
  border-radius: 10px;
  padding: 14px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.18);
  position: relative;
}
.board-frame :deep(svg) {
  display: block;
  height: 100%;
  width: auto;
  max-width: 100%;
  max-height: 100%;
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
.end-banner .archive-row {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}
.end-banner .btn.ghost {
  background: transparent;
  border-color: var(--ink-soft);
  color: var(--ink-soft);
}
.end-banner .archive-note {
  color: var(--amber);
  font-size: 11px;
  max-width: 300px;
  line-height: 1.5;
}
.end-banner .archive-note.err {
  color: #e8a0a0;
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
.side-pane {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-right: 2px;
}
.side-pane::-webkit-scrollbar {
  width: 6px;
}
.side-pane::-webkit-scrollbar-thumb {
  background: var(--line);
  border-radius: 3px;
}
/* 中栏:棋盘 + 公共履历/复盘 */
.board-col {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
}
.meta-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--ink-dim);
  flex-wrap: wrap;
}
.meta-bar .cell {
  border: 1px solid var(--line);
  background: var(--panel-2);
  padding: 4px 10px;
  border-radius: 8px;
  display: flex;
  gap: 6px;
  align-items: center;
}
.meta-bar .cell b {
  color: var(--ink);
  font-family: var(--font-mono);
  font-weight: 600;
}
.meta-bar .cell.first b {
  color: var(--red);
}
/* meta 数字变化跳动(回合/步数/用时) */
.meta-bar .cell b.tick {
  display: inline-block;
  animation: tickPop 0.3s ease-out;
}
@keyframes tickPop {
  0% {
    transform: scale(1.4);
  }
  100% {
    transform: scale(1);
  }
}
/* 履历新步滑入 */
.log-enter-active {
  animation: logIn 0.3s ease-out;
}
@keyframes logIn {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@media (prefers-reduced-motion: reduce) {
  .meta-bar .cell b.tick,
  .log-enter-active {
    animation: none;
  }
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
  grid-template-columns: 24px 1fr auto;
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
.log-t {
  color: var(--ink-soft);
  font-family: var(--font-mono);
  font-size: 11px;
}
.log-a {
  grid-column: 2/4;
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
.btn.on {
  border-color: var(--amber);
  color: var(--amber);
}
/* 浮层(对局履历 / 复盘):从右侧滑入,不挤占棋盘 */
.float-panel {
  position: fixed;
  right: 18px;
  top: 84px;
  width: 380px;
  max-width: calc(100vw - 36px);
  max-height: min(60vh, calc(100vh - 120px));
  overflow-y: auto;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  padding: 12px 14px;
  z-index: 40;
}
.fp-head {
  font-size: 12px;
  color: var(--ink-dim);
  letter-spacing: 0.2em;
  margin: 0 0 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.fp-head .n {
  color: var(--ink-soft);
  font-family: var(--font-mono);
}
.panel-enter-active,
.panel-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.panel-enter-from,
.panel-leave-to {
  opacity: 0;
  transform: translateX(16px);
}
/* 重开确认对话框 */
.confirm-mask {
  position: fixed;
  inset: 0;
  background: rgba(10, 7, 4, 0.55);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 60;
}
.confirm-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 20px 24px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
  width: min(360px, 90vw);
}
.confirm-title {
  font-family: var(--font-display);
  font-size: 18px;
  letter-spacing: 0.1em;
}
.confirm-sub {
  font-size: 12px;
  color: var(--ink-soft);
  margin: 8px 0 16px;
  line-height: 1.7;
}
.confirm-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}
.confirm-actions .btn.danger {
  background: var(--red);
  border-color: var(--red);
  color: #f6ead6;
  font-weight: 600;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
/* 裁判打回 toast(顶部居中浮动,3s 自动消失) */
.referee-toast {
  position: fixed;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 90;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--ink);
  background: var(--panel);
  border: 1px solid rgba(219, 155, 59, 0.6);
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.5);
  border-radius: 10px;
  padding: 9px 16px;
  max-width: min(560px, calc(100vw - 32px));
}
.referee-toast .rt-ico {
  color: var(--amber);
  font-weight: 700;
}
/* 超时挂起条(对应方侧栏顶部):已超时 + 重试(副标题按成因区分) */
.stuck-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  border-radius: 10px;
  padding: 8px 12px;
  border: 1px solid rgba(219, 155, 59, 0.5);
  background: rgba(219, 155, 59, 0.1);
  color: var(--ink);
}
.stuck-banner .sb-ico {
  font-size: 15px;
}
.stuck-banner .sb-sub {
  flex-basis: 100%;
  font-size: 11px;
  color: var(--ink);
  opacity: 0.65;
}
.stuck-banner b {
  color: var(--amber);
  letter-spacing: 0.1em;
}
.stuck-banner .sb-btn {
  margin-left: auto;
  appearance: none;
  border: 1px solid var(--amber);
  background: var(--amber);
  color: #241a10;
  font-family: var(--font-body);
  font-size: 12px;
  font-weight: 600;
  padding: 4px 12px;
  border-radius: 8px;
  cursor: pointer;
}
.stuck-banner .sb-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>