<script setup lang="ts">
//
// App —— 根组装:首页对局列表(home)#/ ⇄ 实时对局页(g)#/g/<id> ⇄ 回放(r)#/r/<id>。
// 对局页生命周期由 <GameView :key> 承载(切 id 即重挂,useGame 随之重建订阅);
// 「重开」= 用服务器 config.json 默认模型再 create 一局(空配置 POST 回落)。
// 红/黑模型配置不再于页面填写——编辑服务端 config.json 后重启即生效。
//
import { onBeforeUnmount, ref, watch } from 'vue';
import GameView from './components/GameView.vue';
import Replay from './views/Replay.vue';
import Home from './views/Home.vue';
import { createGame, type NewGameConfig } from './composables/useGame';

type Route =
  | { kind: 'home' }
  | { kind: 'game'; id: string }
  | { kind: 'replay'; id: string };

// 深链(hash 路由):#/g/<id> 直达实时对局、#/r/<id> 直达回放;无 hash(或 #/)为首页对局列表。
// route 变更用 replaceState 写回 hash——不触发 hashchange,天然防回环;地址栏手改 hash 由 onHashChange 接管。
function parseHash(hash: string): Route {
  const m = /^#\/(g|r)\/(.+)$/.exec(hash);
  if (m && m[1] === 'g') return { kind: 'game', id: m[2]! };
  if (m && m[1] === 'r') return { kind: 'replay', id: m[2]! };
  return { kind: 'home' };
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

// 「开始对局」与「重开」:均以空配置 POST → 后端回落 config.json 的 red/black use。
const EMPTY_CONFIG: NewGameConfig = {
  red: { baseUrl: '', apiKey: '', model: '' },
  black: { baseUrl: '', apiKey: '', model: '' },
  config: { thinkingMode: 'off' }, // 观战页「重开」默认关闭思考;需 high/max 请回首页再选
};
const creating = ref(false);
async function createAndGo(order: 'new' | 'restart'): Promise<void> {
  if (creating.value) return;
  creating.value = true;
  try {
    const { id } = await createGame(EMPTY_CONFIG);
    route.value = { kind: 'game', id };
  } catch (err) {
    // 建局失败:留当前视图,错误由操作发起方展示/静默(重开场景退化为无操作)。
    const msg = err instanceof Error ? err.message : String(err);
    if (order === 'new') window.alert(`开局失败:${msg}`);
    else console.warn('restart failed:', msg);
  } finally {
    creating.value = false;
  }
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
        <button class="btn" data-testid="home-nav" @click="route = { kind: 'home' }">首页</button>
      </div>
      <div v-else-if="route.kind === 'replay'" class="hdr-right">
        <span class="status-pill"><span class="beam"></span>{{ route.id.slice(0, 8) }}</span>
        <button class="btn" data-testid="replay-home" @click="route = { kind: 'home' }">回首页</button>
      </div>
    </header>

    <Home
      v-if="route.kind === 'home'"
      @to-game="(id) => (route = { kind: 'game', id })"
      @to-replay="(id) => (route = { kind: 'replay', id })"
    />

    <Replay
      v-else-if="route.kind === 'replay'"
      :key="`r-${route.id}`"
      :game-id="route.id"
      @exit="route = { kind: 'home' }"
      @to-game="route = { kind: 'game', id: route.id }"
    />

    <GameView
      v-else
      :key="route.id"
      :game-id="route.id"
      @restart="createAndGo('restart')"
      @exit="route = { kind: 'home' }"
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