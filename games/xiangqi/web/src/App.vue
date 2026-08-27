<script setup lang="ts">
//
// App —— 根组装(Task 19):新局表单 ⇄ 实时对局页。
// 对局页生命周期由 <GameView :key> 承载(切 id 即重挂,useGame 随之重建订阅);
// 「重开」= 用上次配置再 create 一局(新 id 重新订阅),后端起新 Arena。
//
import { onBeforeUnmount, ref, watch } from 'vue';
import NewGameForm from './components/NewGameForm.vue';
import GameView from './components/GameView.vue';
import Replay from './views/Replay.vue';
import { createGame, type NewGameConfig } from './composables/useGame';

type Route =
  | { kind: 'form' }
  | { kind: 'game'; id: string; config?: NewGameConfig }
  | { kind: 'replay'; id: string };

// 深链(hash 路由):#/g/<id> 直达实时对局、#/r/<id> 直达回放;无 hash(或 #/)为开新局表单。
// route 变更用 replaceState 写回 hash——不触发 hashchange,天然防回环;地址栏手改 hash 由 onHashChange 接管。
const EMPTY_CONFIG: NewGameConfig = {
  red: { baseUrl: '', apiKey: '', model: '' },
  black: { baseUrl: '', apiKey: '', model: '' },
};

function parseHash(hash: string): Route {
  const m = /^#\/(g|r)\/(.+)$/.exec(hash);
  if (m && m[1] === 'g') return { kind: 'game', id: m[2]! };
  if (m && m[1] === 'r') return { kind: 'replay', id: m[2]! };
  return { kind: 'form' };
}

function toHash(r: Route): string {
  if (r.kind === 'game') return `#/g/${r.id}`;
  if (r.kind === 'replay') return `#/r/${r.id}`;
  return '#/';
}

const route = ref<Route>(parseHash(typeof location !== 'undefined' ? location.hash : ''));
watch(route, (r) => {
  if (typeof history !== 'undefined') history.replaceState(null, '', toHash(r));
});
function onHashChange(): void {
  route.value = parseHash(location.hash);
}
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', onHashChange);
  onBeforeUnmount(() => window.removeEventListener('hashchange', onHashChange));
}
const submitting = ref(false);
const formError = ref<string | null>(null);

async function launch(config: NewGameConfig): Promise<void> {
  submitting.value = true;
  formError.value = null;
  try {
    const { id } = await createGame(config);
    route.value = { kind: 'game', id, config };
  } catch (err) {
    formError.value = err instanceof Error ? err.message : String(err);
  } finally {
    submitting.value = false;
  }
}

// 模板里仅供 game 态出现;深链进入无 config → 空配置(服务端回落 config.json 默认模型)
function restartWithConfig(cfg?: NewGameConfig): void {
  void launch(cfg ?? EMPTY_CONFIG);
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div class="seal">弈</div>
      <div class="brand">
        <h1>楚河汉界</h1>
        <p class="brand-sub">大 模 型 对 决 · 实 时 对 局</p>
      </div>
      <div v-if="route.kind === 'game'" class="hdr-right">
        <span class="status-pill"><span class="beam"></span>{{ route.id.slice(0, 8) }}</span>
        <button class="btn" data-testid="replay-nav" @click="route = { kind: 'replay', id: route.id }">回放</button>
        <button class="btn" data-testid="new-game" @click="route = { kind: 'form' }">新局</button>
      </div>
      <div v-else-if="route.kind === 'replay'" class="hdr-right">
        <span class="status-pill"><span class="beam"></span>{{ route.id.slice(0, 8) }}</span>
        <button class="btn" data-testid="replay-exit" @click="route = { kind: 'form' }">退出回放</button>
      </div>
    </header>

    <NewGameForm
      v-if="route.kind === 'form'"
      :submitting="submitting"
      :error="formError"
      @submit="launch"
    />

    <Replay
      v-else-if="route.kind === 'replay'"
      :key="`r-${route.id}`"
      :game-id="route.id"
      @exit="route = { kind: 'form' }"
    />

    <GameView
      v-else
      :key="route.id"
      :game-id="route.id"
      :config="route.config"
      @restart="restartWithConfig(route.config)"
      @exit="route = { kind: 'form' }"
    />
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
}
.page-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 20px;
  border-bottom: 1px solid var(--line);
  background: linear-gradient(180deg, rgba(230, 180, 110, 0.04), transparent);
}
.seal {
  width: 26px;
  height: 26px;
  flex: none;
  background: var(--seal);
  color: #f6ead6;
  font-family: var(--font-display);
  font-size: 15px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  box-shadow: 0 1px 5px rgba(176, 58, 38, 0.35);
  font-weight: 700;
}
.brand {
  line-height: 1;
}
.brand h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.12em;
  white-space: nowrap;
}
.brand .brand-sub {
  display: none; /* 节省顶部空间,把位置让给对局信息 */
}
.hdr-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.status-pill {
  font-size: 11px;
  color: var(--ink-dim);
  border: 1px solid var(--line);
  padding: 4px 9px;
  border-radius: 20px;
  display: flex;
  align-items: center;
  gap: 5px;
  font-family: var(--font-mono);
}
.status-pill .beam {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--amber);
  box-shadow: 0 0 8px var(--amber);
  animation: beam 1.6s ease-in-out infinite;
}
@keyframes beam {
  0%,
  100% {
    opacity: 0.45;
  }
  50% {
    opacity: 1;
  }
}
.btn {
  appearance: none;
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 8px;
  cursor: pointer;
  white-space: nowrap;
}
.btn:hover {
  border-color: var(--ink-soft);
}
@media (max-width: 720px) {
  .status-pill {
    display: none;
  }
}
</style>