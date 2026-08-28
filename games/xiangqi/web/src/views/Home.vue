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

// 原则 E(新版):思考开/关与强度由服务端 config.json 按模型 profile 定义(见 models.<name>.thinking),
// PK 一律按各模型最强能力测试;页面不再选择档位。
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
    config: {}, // 思考档位不再由页面下发——config.json 的 models.<name>.thinking 已定义
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

    <p class="mode-note" data-testid="thinking-note">
      思考模式由服务端 <code>config.json</code> 的 <code>models.&lt;模型&gt;.thinking</code> 定义
      —— PK 一律按各模型最强能力测试。
    </p>

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
.mode-note {
  font-size: 12px;
  color: var(--ink-soft);
  border: 1px dashed var(--line);
  border-radius: 10px;
  padding: 8px 12px;
  margin-bottom: 10px;
}
.mode-note code {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--amber);
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