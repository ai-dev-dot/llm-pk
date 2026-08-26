<script setup lang="ts">
//
// App —— 前端脚手架的最小壳:挂载 XQBoard 并演示几步着法(走子动画/高亮/印章)。
// 对局数据源本任务为演示数据;真实 WS 订阅在 Task 19(useGame)接入。
//
import { onBeforeUnmount, onMounted, ref } from 'vue';
import XQBoard from './components/XQBoard.vue';
import { initialBoard } from '../../engine/board';
import { recordsFromBoard, type PieceRec } from './lib/board';
import type { Sq } from '../../engine/types';

const pieces = ref<PieceRec[]>(recordsFromBoard(initialBoard()));
const lastMove = ref<{ from: Sq; to: Sq } | null>(null);

// 演示着法(engine 坐标;file 0..8、rank 0..9,红底黑顶);仅演示用,无需合法序列。
const DEMO: { from: Sq; to: Sq }[] = [
  { from: { file: 7, rank: 2 }, to: { file: 4, rank: 2 } }, // 炮二平五
  { from: { file: 7, rank: 7 }, to: { file: 4, rank: 7 } }, // 炮8平5
  { from: { file: 7, rank: 0 }, to: { file: 6, rank: 2 } }, // 马二进三
  { from: { file: 7, rank: 9 }, to: { file: 6, rank: 7 } }, // 马8进7
  { from: { file: 4, rank: 3 }, to: { file: 4, rank: 4 } }, // 兵五进一
  { from: { file: 4, rank: 6 }, to: { file: 4, rank: 5 } }, // 卒5进1
];

let step = 0;
let timer: number | undefined;

function playNext() {
  const m = DEMO[step % DEMO.length]!;
  step += 1;
  const list = pieces.value.slice();
  const fromIdx = list.findIndex((p) => p?.file === m.from.file && p?.rank === m.from.rank);
  if (fromIdx < 0) {
    lastMove.value = m;
    return;
  }
  const mover = list.splice(fromIdx, 1)[0]!;
  const destIdx = list.findIndex((p) => p?.file === m.to.file && p?.rank === m.to.rank);
  if (destIdx >= 0) list.splice(destIdx, 1); // 吃子
  list.push({ ...mover, file: m.to.file, rank: m.to.rank });
  pieces.value = list;
  lastMove.value = m;
}

onMounted(() => {
  timer = window.setInterval(playNext, 2000);
});
onBeforeUnmount(() => {
  if (timer !== undefined) window.clearInterval(timer);
});
</script>

<template>
  <div class="page">
    <header class="page-header">
      <div class="seal">弈</div>
      <div class="brand">
        <h1>楚河汉界</h1>
        <p class="brand-sub">大 模 型 对 决 · 前 端 示 范</p>
      </div>
    </header>
    <main class="stage">
      <div class="board-frame">
        <XQBoard :pieces="pieces" :last-move="lastMove" />
        <span class="board-corner">web · 演示</span>
      </div>
    </main>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
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

.stage {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px 24px;
  min-width: 0;
  position: relative;
}

.board-frame {
  background: linear-gradient(160deg, var(--wood-1), var(--wood-2));
  border-radius: 10px;
  padding: 14px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.18);
  position: relative;
}

.board-frame svg {
  display: block;
  height: calc(100vh - 220px);
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
</style>