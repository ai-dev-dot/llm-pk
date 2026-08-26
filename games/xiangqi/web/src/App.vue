<script setup lang="ts">
//
// App —— 根组装(Task 19):新局表单 ⇄ 实时对局页。
// 对局页生命周期由 <GameView :key> 承载(切 id 即重挂,useGame 随之重建订阅);
// 「重开」= 用上次配置再 create 一局(新 id 重新订阅),后端起新 Arena。
//
import { ref } from 'vue';
import NewGameForm from './components/NewGameForm.vue';
import GameView from './components/GameView.vue';
import { createGame, type NewGameConfig } from './composables/useGame';

type Route = { kind: 'form' } | { kind: 'game'; id: string; config: NewGameConfig };

const route = ref<Route>({ kind: 'form' });
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

// 模板里仅供 game 态出现;non-null 由调用点保证
function restartWithConfig(cfg: NewGameConfig): void {
  void launch(cfg);
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
        <button class="btn" data-testid="new-game" @click="route = { kind: 'form' }">新局</button>
      </div>
    </header>

    <NewGameForm
      v-if="route.kind === 'form'"
      :submitting="submitting"
      :error="formError"
      @submit="launch"
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
  gap: 16px;
  padding: 14px 24px 12px;
  border-bottom: 1px solid var(--line);
  background: linear-gradient(180deg, rgba(230, 180, 110, 0.04), transparent);
}
.seal {
  width: 40px;
  height: 40px;
  flex: none;
  background: var(--seal);
  color: #f6ead6;
  font-family: var(--font-display);
  font-size: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(176, 58, 38, 0.35);
  font-weight: 700;
}
.brand {
  line-height: 1.1;
}
.brand h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 600;
  letter-spacing: 0.12em;
}
.brand .brand-sub {
  margin: 3px 0 0;
  font-size: 12px;
  color: var(--ink-dim);
  letter-spacing: 0.28em;
}
.hdr-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 12px;
}
.status-pill {
  font-size: 12px;
  color: var(--ink-dim);
  border: 1px solid var(--line);
  padding: 5px 10px;
  border-radius: 20px;
  display: flex;
  align-items: center;
  gap: 6px;
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
  font-size: 13px;
  padding: 8px 14px;
  border-radius: 9px;
  cursor: pointer;
}
.btn:hover {
  border-color: var(--ink-soft);
}
</style>