<script setup lang="ts">
//
// XQBoard —— 中国象棋棋盘(纯受控展示,不发事件)。
//
// 从 demo.html 迁制的 SVG 布局算法(cell/PAD、坐标系、盖印动画),props 驱动棋子 `<g>`。
// 坐标走 engine 约定:file 0..8(列 a..i)、rank 0..9(0=红底,9=黑顶)。
// 棋子记录可传 90 长数组 board(空位 null)或 {side,type,file,rank} 记录数组(`pieces` 两种形态皆可)。
//
import { computed, ref, shallowRef, watch } from 'vue';
import type { Sq } from '../../../engine/types';
import { normalizePieces, sqIdx, type PieceRec, type PiecesInput } from '../lib/board';

const props = withDefaults(
  defineProps<{
    pieces: PiecesInput;
    lastMove?: { from: Sq; to: Sq } | null;
  }>(),
  { lastMove: null },
);

/* ---------- 布局常量(迁自 demo.html) ---------- */
const CELL = 48;
const PAD = 40;
const R = 20;
const W = PAD * 2 + (9 - 1) * CELL; // 464
const H = PAD * 2 + (10 - 1) * CELL; // 512

const posX = (f: number) => PAD + f * CELL;
const posY = (r: number) => PAD + (9 - r) * CELL; // engine rank0 = 底部

const files = [...Array(9).keys()];
const ranks = [...Array(10).keys()];
const riverY0 = PAD + 4 * CELL + 14;

// 九宫斜线(red 左上、black 右上)
const palaceLines = [
  { x1: PAD, y1: PAD, x2: PAD + 2 * CELL, y2: PAD + 2 * CELL },
  { x1: PAD, y1: PAD + 2 * CELL, x2: PAD + 2 * CELL, y2: PAD },
  { x1: PAD + 6 * CELL, y1: PAD, x2: PAD + 8 * CELL, y2: PAD + 2 * CELL },
  { x1: PAD + 6 * CELL, y1: PAD + 2 * CELL, x2: PAD + 8 * CELL, y2: PAD },
];

/* ---------- 棋子字集(spec §4:炮统一「砲」,红黑分色) ---------- */
const GLYPH: Record<string, string> = {
  'red:rook': '車',
  'red:horse': '馬',
  'red:elephant': '相',
  'red:advisor': '仕',
  'red:general': '帥',
  'red:cannon': '砲',
  'red:pawn': '兵',
  'black:rook': '車',
  'black:horse': '馬',
  'black:elephant': '象',
  'black:advisor': '士',
  'black:general': '將',
  'black:cannon': '砲',
  'black:pawn': '卒',
};

/* ---------- 稳定 uid:让走子在 DOM 中保持同一 `<g>`,CSS transform transition 才能补间 ---------- */
interface FlatPiece extends PieceRec {
  uid: string;
}

let uidCounter = 0;
let prevFlat: FlatPiece[] = [];
const flatPieces = shallowRef<FlatPiece[]>([]);

function assignUids(input: PieceRec[]): FlatPiece[] {
  const oldBySq = new Map<number, FlatPiece>();
  for (const p of prevFlat) oldBySq.set(sqIdx(p.file, p.rank), p);

  const newBySq = new Map<number, PieceRec>();
  for (const p of input) newBySq.set(sqIdx(p.file, p.rank), p);

  const usedOld = new Set<number>();
  const out: FlatPiece[] = [];

  for (const p of input) {
    const sq = sqIdx(p.file, p.rank);
    const samePos = oldBySq.get(sq);
    if (samePos && samePos.side === p.side && samePos.type === p.type && !usedOld.has(sq)) {
      usedOld.add(sq);
      out.push({ ...p, uid: samePos.uid });
      continue;
    }
    // 走子匹配:同 side/type 的旧子,旧格在新局面已空 → 复用其 uid
    let moved: FlatPiece | undefined;
    for (const old of prevFlat) {
      const oldSq = sqIdx(old.file, old.rank);
      if (usedOld.has(oldSq)) continue;
      if (oldSq === sq) continue;
      if (old.side !== p.side || old.type !== p.type) continue;
      if (newBySq.has(oldSq)) continue; // 旧格仍占 → 非本子
      moved = old;
      usedOld.add(oldSq);
      break;
    }
    if (moved) {
      out.push({ ...p, uid: moved.uid });
      continue;
    }
    out.push({ ...p, uid: `fresh:${p.file},${p.rank}:${uidCounter++}` });
  }
  return out;
}

watch(
  () => props.pieces,
  (input) => {
    prevFlat = flatPieces.value;
    flatPieces.value = assignUids(normalizePieces(input));
  },
  { immediate: true, flush: 'sync', deep: true },
);

/* ---------- lastMove 高亮 / 印章 ---------- */
const toSq = computed(() => props.lastMove?.to ?? null);
const fromSq = computed(() => props.lastMove?.from ?? null);
const lastMoveSqIdx = computed(() => (toSq.value ? sqIdx(toSq.value.file, toSq.value.rank) : -1));
const stampTick = ref(0);
watch(
  () => props.lastMove,
  () => {
    stampTick.value += 1;
  },
  { immediate: true },
);
const stampKey = computed(() => (toSq.value ? `${stampTick.value}:${toSq.value.file},${toSq.value.rank}` : null));

function isLastMoveSq(p: PieceRec): boolean {
  return sqIdx(p.file, p.rank) === lastMoveSqIdx.value;
}
</script>

<template>
  <svg class="xq-board" :viewBox="`0 0 ${W} ${H}`" role="img" aria-label="中国象棋棋盘">
    <defs>
      <filter id="ps" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="1.6" stdDeviation="1.4" flood-color="#000" flood-opacity="0.35" />
      </filter>
    </defs>

    <!-- 外框 -->
    <rect :x="0" :y="0" :width="W" :height="H" rx="8" fill="none" stroke="rgba(60,38,18,.55)" stroke-width="2.5" />

    <!-- 横向 10 线 -->
    <line v-for="r in ranks" :key="`hr${r}`" :x1="PAD" :y1="posY(r)" :x2="PAD + 8 * CELL" :y2="posY(r)" stroke="var(--wood-line)" stroke-width="1.3" />

    <!-- 竖向 9 线,中央第 4 线过河断开 -->
    <template v-for="f in files" :key="`vf${f}`">
      <g v-if="f === 4">
        <line :x1="posX(f)" :y1="PAD" :x2="posX(f)" :y2="posY(4)" stroke="var(--wood-line)" stroke-width="1.3" />
        <line :x1="posX(f)" :y1="posY(5)" :x2="posX(f)" :y2="PAD + 9 * CELL" stroke="var(--wood-line)" stroke-width="1.3" />
      </g>
      <line v-else :x1="posX(f)" :y1="PAD" :x2="posX(f)" :y2="PAD + 9 * CELL" stroke="var(--wood-line)" stroke-width="1.3" />
    </template>

    <!-- 九宫斜线 -->
    <line v-for="(l, i) in palaceLines" :key="`pl${i}`" :x1="l.x1" :y1="l.y1" :x2="l.x2" :y2="l.y2" stroke="var(--wood-line)" stroke-width="1.3" />

    <!-- 楚河 / 漢界(竖排) -->
    <g class="river" fill="var(--wood-ink)" font-size="21" opacity="0.62" text-anchor="middle">
      <template v-for="(c, i) in '楚河'" :key="`rv${i}`">
        <text :x="posX(2)" :y="riverY0 + i * (CELL - 18)">{{ c }}</text>
      </template>
      <template v-for="(c, i) in '漢界'" :key="`rv2${i}`">
        <text :x="posX(6)" :y="riverY0 + i * (CELL - 18)">{{ c }}</text>
      </template>
    </g>

    <!-- 落点 / 起点标记(lastMove) -->
    <circle v-if="fromSq" class="from-dot" :cx="posX(fromSq.file)" :cy="posY(fromSq.rank)" :r="R - 3" fill="rgba(219,168,100,.28)" />
    <circle v-if="toSq" class="last-dot" :cx="posX(toSq.file)" :cy="posY(toSq.rank)" :r="4.5" fill="#ffd57a" />
    <circle v-if="toSq && stampKey" :key="stampKey" class="stamp anim" :cx="posX(toSq.file)" :cy="posY(toSq.rank)" :r="R + 3" fill="none" stroke="rgba(176,58,38,.85)" stroke-width="2.2" />

    <!-- 棋子 -->
    <g
      v-for="p in flatPieces"
      :key="p.uid"
      :class="['pc', p.side, { 'last-move': isLastMoveSq(p) }]"
      :data-side="p.side"
      :data-type="p.type"
      :data-file="p.file"
      :data-rank="p.rank"
      :style="{ transform: `translate(${posX(p.file)}px, ${posY(p.rank)}px)` }"
    >
      <circle :r="R" fill="#f4e3c4" :stroke="p.side === 'red' ? '#8f4633' : '#20201d'" stroke-width="2" filter="url(#ps)" />
      <circle :r="R - 4" fill="none" :stroke="p.side === 'red' ? 'rgba(143,70,51,.55)' : 'rgba(32,32,29,.5)'" stroke-width="1" />
      <text y="8" text-anchor="middle" font-size="27" font-weight="600" :fill="p.side === 'red' ? '#a53a26' : '#26221f'">
        {{ GLYPH[`${p.side}:${p.type}`] ?? '?' }}
      </text>
    </g>
  </svg>
</template>

<style scoped>
.xq-board {
  display: block;
}

/* 走子补间(迁自 demo 的 .pc transition) */
.pc {
  transition: transform 0.3s cubic-bezier(0.3, 0.7, 0.3, 1);
}

.pc.last-move circle:first-child {
  stroke: #b03a26;
  stroke-width: 2.6;
}

/* 棋子/河界文字用楷体(var 无法作用于 SVG 属性,走 CSS) */
.pc text,
.river text {
  font-family: var(--font-display);
}

/* 落点 / 起点 / 印章 */
.from-dot,
.last-dot,
.stamp {
  pointer-events: none;
}

.stamp {
  transform-box: fill-box;
  transform-origin: center;
}

.stamp.anim {
  animation: stampRing 0.5s ease-out forwards;
}

@keyframes stampRing {
  0% {
    transform: scale(0.2);
    opacity: 0.95;
  }
  70% {
    transform: scale(1.25);
    opacity: 0.7;
  }
  100% {
    transform: scale(1.5);
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .pc {
    transition: none;
  }
  .stamp.anim {
    animation: none;
  }
}
</style>