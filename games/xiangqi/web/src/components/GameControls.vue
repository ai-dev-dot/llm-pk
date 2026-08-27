<script setup lang="ts">
//
// GameControls —— 控制栏(Task 19):播放/暂停、单步、重开、速度、静音。
// 纯受控组件:状态由父(useGame)驱动,动作以 emit 上抛(REST 由宿主处理)。
//
import { computed } from 'vue';
import type { GamePhase } from '../composables/useGame';

const props = withDefaults(
  defineProps<{
    status: GamePhase;
    speed?: number;
    muted?: boolean;
  }>(),
  { speed: 1, muted: false },
);

const emit = defineEmits<{
  (e: 'toggle-play'): void;
  (e: 'step'): void;
  (e: 'restart'): void;
  (e: 'speed', v: number): void;
  (e: 'toggle-mute'): void;
}>();

const SPEEDS = [1, 2, 4] as const;

const playLabel = computed(() => {
  if (props.status === 'paused') return '▶ 继续';
  if (props.status === 'running') return '❚❚ 暂停';
  if (props.status === 'finished') return '已终局';
  return '连接中…';
});
const playDisabled = computed(
  () => props.status === 'connecting' || props.status === 'finished' || props.status === 'error',
);
const stepDisabled = computed(() => props.status !== 'paused');
</script>

<template>
  <div class="controls" data-testid="controls">
    <button class="btn pri" :disabled="playDisabled" data-testid="play" @click="emit('toggle-play')">
      {{ playLabel }}
    </button>
    <button class="btn" :disabled="stepDisabled" data-testid="step" title="暂停后再单步" @click="emit('step')">
      ⏭ 单步<span class="kbd">S</span>
    </button>
    <button class="btn" data-testid="restart" @click="emit('restart')">↺ 重开</button>
    <button class="btn" data-testid="mute" :title="muted ? '开启音效' : '静音'" @click="emit('toggle-mute')">
      {{ muted ? '🔇' : '🔊' }}
    </button>
    <div class="seg" role="group" aria-label="速度">
      <button
        v-for="s in SPEEDS"
        :key="s"
        :class="{ on: speed === s }"
        data-testid="speed"
        @click="emit('speed', s)"
      >
        {{ s }}×
      </button>
    </div>
  </div>
</template>

<style scoped>
.controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 0;
  border: none;
  background: none;
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
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
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
.btn:focus-visible {
  outline: 2px solid var(--red);
  outline-offset: 2px;
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
.btn .kbd {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--ink-soft);
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
  padding: 6px 11px;
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
</style>