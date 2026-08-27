<script setup lang="ts">
//
// Home —— 首页 · 对局列表(T20)。
// 顶部「开始对局」用服务器 config.json 的 red.use/black.use(空配置 POST,后端回落);
// 列表来自 GET /api/logs(扫磁盘 logs/ 归档),10s 轮询;进行中→观战、已结束→回放。
// 红/黑模型不在页面配置——改模型请编辑服务端 config.json 后重启。
//
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { createGame, type NewGameConfig } from '../composables/useGame';
import { fmtClock, fmtReason, fmtRound } from '../lib/format';

/** GET /api/logs 单条对局(与后端 server/game-archive.ts ArchivedGame 对齐)。 */
export interface GameListItem {
  id: string;
  red: { model?: string };
  black: { model?: string };
  status: 'running' | 'paused' | 'finished';
  moveCount: number;
  winner?: string;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

const emit = defineEmits<{
  (e: 'toGame', id: string): void;
  (e: 'toReplay', id: string): void;
}>();

// 思考模式(原则 E):每场 PK 必须二选一 —— 关闭思考 或 max 思考。
// 参考建议:flash 级模型选「关闭」;各厂主力旗舰选「max」。
const thinkingMode = ref<'off' | 'max'>('off');
const modeChoices = [
  { value: 'off', title: '关闭思考', desc: 'flash 级模型建议' },
  { value: 'max', title: '启用 max 思考', desc: '各厂主力旗舰建议' },
] as const;

const games = ref<GameListItem[]>([]);
const error = ref<string | null>(null);
const creating = ref(false);
const refreshing = ref(false);
let timer: number | undefined;

async function load(): Promise<void> {
  try {
    const res = await fetch('/api/logs');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { games?: GameListItem[] };
    games.value = Array.isArray(data.games) ? data.games : [];
    error.value = null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function refresh(): Promise<void> {
  refreshing.value = true;
  try {
    await load();
  } finally {
    refreshing.value = false;
  }
}

async function start(): Promise<void> {
  if (creating.value) return;
  creating.value = true;
  error.value = null;
  const cfg: NewGameConfig = {
    red: { baseUrl: '', apiKey: '', model: '' },
    black: { baseUrl: '', apiKey: '', model: '' },
    // 原则 E:本局思考模式随开局请求下发双方(same boundary)。
    config: { thinkingMode: thinkingMode.value },
  };
  try {
    const { id } = await createGame(cfg);
    emit('toGame', id);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    creating.value = false;
  }
}

function openGame(g: GameListItem): void {
  // 行内点击整行即进入:进行中/暂停 → 实时观战;已结束 → 回放
  if (g.status === 'finished') emit('toReplay', g.id);
  else emit('toGame', g.id);
}

const ongoing = computed(() => games.value.filter((g) => g.status !== 'finished'));
const finished = computed(() => games.value.filter((g) => g.status === 'finished'));

onMounted(() => {
  void load();
  timer = window.setInterval(() => void load(), 10000);
});
onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer);
});
</script>

<template>
  <div class="home" data-testid="home-view">
    <section class="hero">
      <div class="hero-seal">弈</div>
      <div class="hero-text">
        <h2>对局大厅</h2>
        <p>
          红 / 黑模型来自服务端 <code>config.json</code> 的 <code>red.use / black.use</code>
          —— 改模型请直接编辑配置并重启后端,页面不设模型表单。
        </p>
      </div>
    </section>

    <fieldset class="mode-picker" data-testid="thinking-mode">
      <legend class="mode-label">思考模式</legend>
      <button
        v-for="c in modeChoices"
        :key="c.value"
        type="button"
        class="mode-opt"
        :class="{ on: thinkingMode === c.value }"
        :data-testid="`mode-${c.value}`"
        @click="thinkingMode = c.value"
      >
        <span class="mode-dot"></span>
        <span class="mode-txt">
          <b>{{ c.title }}</b>
          <i>{{ c.desc }}</i>
        </span>
      </button>
      <span class="mode-hint">每局必须二选一;选择结果以同一边界同时下发双方。</span>
    </fieldset>

    <div class="toolbar">
      <button class="btn pri" :disabled="creating" data-testid="start-game" @click="start">
        {{ creating ? '开 局 中 …' : '⚔ 开始对局' }}
      </button>
      <button class="btn" :disabled="refreshing" data-testid="refresh" @click="refresh">
        {{ refreshing ? '刷新中…' : '↻ 刷新' }}
      </button>
      <span class="auto-note">每 10s 自动刷新</span>
    </div>

    <p v-if="error" class="error-banner" data-testid="home-error">加载失败:{{ error }}</p>

    <section v-if="ongoing.length" class="group">
      <h3 class="group-title"><span class="live-dot"></span>进行中</h3>
      <ul class="game-list">
        <li
          v-for="g in ongoing"
          :key="g.id"
          class="game-row"
          data-testid="log-row"
          @click="openGame(g)"
        >
          <span class="badge" :class="g.status">{{ g.status === 'paused' ? '暂停' : '进行中' }}</span>
          <div class="duel">
            <span class="side red"><b>红</b>{{ g.red.model || '?' }}</span>
            <span class="vs">⚔</span>
            <span class="side black"><b>黑</b>{{ g.black.model || '?' }}</span>
          </div>
          <div class="meta">
            回合 {{ fmtRound(g.moveCount) }} · {{ fmtClock(g.createdAt) }}
          </div>
          <div class="actions">
            <button class="btn mini" data-testid="watch" @click.stop="() => emit('toGame', g.id)">观战</button>
          </div>
        </li>
      </ul>
    </section>

    <section v-if="finished.length" class="group">
      <h3 class="group-title">已结束</h3>
      <ul class="game-list">
        <li
          v-for="g in finished"
          :key="g.id"
          class="game-row"
          data-testid="log-row"
          @click="openGame(g)"
        >
          <span class="badge finished" :class="{ red: g.winner === 'red', black: g.winner === 'black' }">
            {{ fmtReason(g.reason ?? '') }}
          </span>
          <div class="duel">
            <span class="side red" :class="{ win: g.winner === 'red' }"><b>红</b>{{ g.red.model || '?' }}<em v-if="g.winner === 'red'" class="win-tag">胜</em></span>
            <span class="vs">{{ g.winner === 'draw' ? '和' : '⚔' }}</span>
            <span class="side black" :class="{ win: g.winner === 'black' }"><b>黑</b>{{ g.black.model || '?' }}<em v-if="g.winner === 'black'" class="win-tag">胜</em></span>
          </div>
          <div class="meta">
            回合 {{ fmtRound(g.moveCount) }} · {{ fmtClock(g.createdAt) }}
          </div>
          <div class="actions">
            <button class="btn mini" data-testid="replay" @click.stop="() => emit('toReplay', g.id)">回放</button>
          </div>
        </li>
      </ul>
    </section>

    <section v-if="!games.length" class="empty" data-testid="home-empty">
      <p>暂无对局 — 点上方「⚔ 开始对局」发起第一场 PK。</p>
    </section>
  </div>
</template>

<style scoped>
.home {
  width: min(880px, 100%);
  margin: 0 auto;
  padding: 20px 18px 60px;
}
.hero {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 16px;
}
.hero-seal {
  width: 44px;
  height: 44px;
  flex: none;
  background: var(--seal);
  color: #f6ead6;
  font-family: var(--font-display);
  font-size: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(176, 58, 38, 0.35);
  font-weight: 700;
}
.hero-text h2 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 20px;
  letter-spacing: 0.16em;
}
.hero-text p {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--ink-soft);
  line-height: 1.6;
}
.hero-text code {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--amber);
}
.mode-picker {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 8px 12px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.mode-label {
  font-size: 12px;
  color: var(--ink-soft);
  letter-spacing: 0.08em;
  padding-right: 6px;
}
.mode-opt {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--ink-soft);
  border-radius: 9px;
  padding: 6px 12px;
  cursor: pointer;
}
.mode-opt .mode-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1px solid var(--ink-dim);
}
.mode-opt .mode-txt {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  line-height: 1.3;
}
.mode-opt .mode-txt b {
  font-size: 13px;
  color: var(--ink);
  font-weight: 600;
}
.mode-opt .mode-txt i {
  font-style: normal;
  font-size: 11px;
  color: var(--ink-dim);
}
.mode-opt.on {
  border-color: var(--amber);
  background: rgba(219, 155, 59, 0.12);
}
.mode-opt.on .mode-dot {
  background: var(--amber);
  border-color: var(--amber);
  box-shadow: 0 0 6px var(--amber);
}
.mode-opt.on .mode-txt b {
  color: var(--amber);
}
.mode-hint {
  font-size: 11px;
  color: var(--ink-dim);
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.auto-note {
  font-size: 11px;
  color: var(--ink-dim);
  margin-left: 2px;
}
.btn {
  appearance: none;
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 13px;
  padding: 8px 16px;
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
.btn.mini {
  font-size: 12px;
  padding: 5px 11px;
}
.error-banner {
  background: rgba(176, 58, 38, 0.14);
  border: 1px solid rgba(176, 58, 38, 0.4);
  color: #f0b7a5;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12px;
}
.group-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  color: var(--ink-dim);
  letter-spacing: 0.1em;
  margin: 20px 0 8px;
}
.live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--amber);
  box-shadow: 0 0 8px var(--amber);
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 0.4;
  }
  50% {
    opacity: 1;
  }
}
.game-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.game-row {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 10px 14px;
  cursor: pointer;
  transition: border-color 0.15s, transform 0.1s;
}
.game-row:hover {
  border-color: var(--ink-soft);
  transform: translateY(-1px);
}
.badge {
  flex: none;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 20px;
  border: 1px solid var(--line);
  color: var(--ink-soft);
  white-space: nowrap;
}
.badge.running {
  color: var(--amber);
  border-color: rgba(219, 155, 59, 0.5);
}
.badge.paused {
  color: var(--ink-dim);
}
.badge.finished.red {
  color: var(--red);
  border-color: rgba(219, 25, 38, 0.5);
}
.badge.finished.black {
  color: #e0d4bb;
  border-color: rgba(224, 212, 187, 0.35);
}
.duel {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
}
.side {
  font-family: var(--font-mono);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.side b {
  margin-right: 5px;
  font-family: var(--font-display);
  font-size: 13px;
}
.side.red {
  color: var(--red);
}
.side.black {
  color: #e0d4bb;
}
.win-tag {
  font-style: normal;
  font-family: var(--font-body);
  font-size: 11px;
  color: var(--ink-dim);
  margin-right: 4px;
}
.side.red .win-tag,
.side.red.win {
  font-weight: 700;
}
.vs {
  color: var(--ink-dim);
  font-size: 12px;
}
.meta {
  flex: none;
  font-size: 11px;
  color: var(--ink-dim);
  font-family: var(--font-mono);
  white-space: nowrap;
}
.actions {
  flex: none;
}
.empty {
  margin-top: 34px;
  text-align: center;
  color: var(--ink-dim);
  font-size: 13px;
  border: 1px dashed var(--line);
  border-radius: 12px;
  padding: 40px 20px;
}
@media (max-width: 640px) {
  .meta {
    display: none;
  }
}
</style>