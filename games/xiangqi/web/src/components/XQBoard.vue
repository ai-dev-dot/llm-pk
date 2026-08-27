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

/** 走子前导动画(由宿主慢放队列驱动):hover=待动棋子高亮;path=起点→终点带箭头路径。 */
export interface BoardAnim {
  phase: 'hover' | 'path';
  from: Sq;
  to: Sq;
  /** 递增 id:每次阶段变化让元素重挂以重触发 CSS 动画。 */
  id: number;
}

const props = withDefaults(
  defineProps<{
    pieces: PiecesInput;
    lastMove?: { from: Sq; to: Sq } | null;
    /** 走子前导动画(hover 高亮 / path 路径)。null = 无。 */
    anim?: BoardAnim | null;
  }>(),
  { lastMove: null, anim: null },
);

const animCtx = computed(() => props.anim);
// anim 关键 id:随阶段变化,配合 :key 重挂动画元素
const animKey = computed(() => (props.anim ? `a${props.anim.id}` : null));

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

// 九宫斜线(引擎坐标双侧宫):红宫位 file3..5 × rank0..2(下部),黑宫位 file3..5 × rank7..9(上部)。
// 修正自 demo 的错误几何(demo 把两侧宫都画在顶部 file0-2/6-8),见 Task 19 brief(T18 minor)。
const palaceLines = [
  { palace: 'red', x1: posX(3), y1: posY(0), x2: posX(5), y2: posY(2) },
  { palace: 'red', x1: posX(3), y1: posY(2), x2: posX(5), y2: posY(0) },
  { palace: 'black', x1: posX(3), y1: posY(7), x2: posX(5), y2: posY(9) },
  { palace: 'black', x1: posX(3), y1: posY(9), x2: posX(5), y2: posY(7) },
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
  const usedKey = new Set<string>();
  const out: FlatPiece[] = [];

  for (const p of input) {
    // 显式 uid(useGame 由事件维护身份):key = `x:<uid>` 跨帧确定性;同 uid 即同一 <g>,transform 补间。
    if (p.uid) {
      const key = `x:${p.uid}`;
      if (!usedKey.has(key)) {
        usedKey.add(key);
        out.push({ ...p, uid: key });
        continue;
      }
      // 同 uid 重复(异常):回退下方旧 diff,避免 key 冲突
    }
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

/** 落子弹跳:落点棋子的内层 <g> key 随 stampKey 变化 → 重挂 → land 动画重触发;其余棋子恒 'static' 不重挂。 */
function landKey(p: PieceRec): string {
  return isLastMoveSq(p) ? `land:${stampKey.value ?? 'x'}` : 'static';
}

/** 移动路径箭头:从 from 指向 to 的三角形 path(尖端收在终点棋子半径外)。 */
function arrowD(a: { from: Sq; to: Sq }): string {
  const x1 = posX(a.from.file);
  const y1 = posY(a.from.rank);
  const x2 = posX(a.to.file);
  const y2 = posY(a.to.rank);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const tip = R + 8; // 箭头尖端距目标棋子中心(让开我现在)
  const base = tip + 10;
  const sx = x2 - ux * tip;
  const sy = y2 - uy * tip;
  const bx = x2 - ux * base;
  const by = y2 - uy * base;
  const px = -uy;
  const py = ux;
  const hw = 6.5;
  return `M ${x2} ${y2} L ${sx + px * hw} ${sy + py * hw} L ${bx} ${by} L ${sx - px * hw} ${sy - py * hw} Z`;
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

    <!-- 九宫斜线(红宫/黑宫各两条;data-palace 供测试与可访问性) -->
    <line
      v-for="(l, i) in palaceLines"
      :key="`pl${i}`"
      :x1="l.x1"
      :y1="l.y1"
      :x2="l.x2"
      :y2="l.y2"
      :data-palace="l.palace"
      stroke="var(--wood-line)"
      stroke-width="1.3"
    />

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
    <circle v-if="toSq && stampKey" :key="`${stampKey}-inner`" class="stamp anim2" :cx="posX(toSq.file)" :cy="posY(toSq.rank)" :r="R - 6" fill="none" stroke="rgba(255,213,122,.9)" stroke-width="1.6" />

    <!-- 走子前导动画(hover 高亮待动子 / path 显示起点→终点带箭头路径);:key 随阶段切换重挂 -->
    <g v-if="animCtx && animKey" :key="animKey" class="anim-lead" :data-anim="animCtx.phase">
      <template v-if="animCtx.phase === 'hover'">
        <circle :cx="posX(animCtx.from.file)" :cy="posY(animCtx.from.rank)" :r="R + 6" fill="none" stroke="#ffd57a" stroke-width="3" class="hover-glint" />
        <circle :cx="posX(animCtx.to.file)" :cy="posY(animCtx.to.rank)" :r="R - 3" fill="none" stroke="#ffd57a" stroke-width="1.6" stroke-dasharray="4 3" class="hover-dst" />
      </template>
      <template v-else-if="animCtx.phase === 'path'">
        <line
          :x1="posX(animCtx.from.file)"
          :y1="posY(animCtx.from.rank)"
          :x2="posX(animCtx.to.file)"
          :y2="posY(animCtx.to.rank)"
          class="path-line"
        />
        <path :d="arrowD(animCtx)" class="path-arrow" />
        <circle :cx="posX(animCtx.from.file)" :cy="posY(animCtx.from.rank)" :r="R + 6" fill="none" stroke="#ffd57a" stroke-width="2.4" class="hover-glint" />
      </template>
    </g>

    <!-- 棋子(普通 g 列表:走子同 uid 复用 <g>,transform 补间;不使用 TransitionGroup——SVG 下 FLIP 位置计算会把补间起点算成 (0,0)) -->
    <g v-for="p in flatPieces" class="pc-group" :key="p.uid">
      <g
        :class="['pc', p.side, { 'last-move': isLastMoveSq(p) }]"
        :data-side="p.side"
        :data-type="p.type"
        :data-file="p.file"
        :data-rank="p.rank"
        :style="{ transform: `translate(${posX(p.file)}px, ${posY(p.rank)}px)` }"
      >
        <g :key="landKey(p)" :class="{ 'pc-inner land': isLastMoveSq(p) }">
          <circle :r="R" fill="#f4e3c4" :stroke="p.side === 'red' ? '#8f4633' : '#20201d'" stroke-width="2" filter="url(#ps)" />
          <circle :r="R - 4" fill="none" :stroke="p.side === 'red' ? 'rgba(143,70,51,.55)' : 'rgba(32,32,29,.5)'" stroke-width="1" />
          <text y="8" text-anchor="middle" font-size="27" font-weight="600" :fill="p.side === 'red' ? '#a53a26' : '#26221f'">
            {{ GLYPH[`${p.side}:${p.type}`] ?? '?' }}
          </text>
        </g>
      </g>
    </g>
  </svg>
</template>

<style scoped>
.xq-board {
  display: block;
}

/* 走子补间(迁自 demo 的 .pc transition);被吃子直接移除,落点 stamp 双环 + 吃子音替代「淡出」 */
.pc {
  transition: transform 0.3s cubic-bezier(0.3, 0.7, 0.3, 1);
}

.pc.last-move circle:first-child {
  stroke: #b03a26;
  stroke-width: 2.6;
  filter: drop-shadow(0 0 5px rgba(255, 180, 90, 0.85));
}

/* 落子弹跳:内层 <g> 独立于外层 translate 补间,scale 动画不冲突 */
.pc-inner {
  transform-box: fill-box;
  transform-origin: center;
}
.pc-inner.land {
  animation: landBounce 0.42s cubic-bezier(0.22, 1.4, 0.36, 1);
}
@keyframes landBounce {
  0% {
    transform: scale(1.35);
  }
  55% {
    transform: scale(0.92);
  }
  100% {
    transform: scale(1);
  }
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

/* 起点呼吸 / 落点光晕 */
.from-dot {
  animation: fromPulse 1.3s ease-in-out infinite;
}
@keyframes fromPulse {
  0%,
  100% {
    opacity: 0.3;
  }
  50% {
    opacity: 0.75;
  }
}
.last-dot {
  transform-box: fill-box;
  transform-origin: center;
  animation: dotGlow 1.3s ease-in-out infinite;
}
@keyframes dotGlow {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.55;
    transform: scale(1.4);
  }
}

/* 落点盖章:外圈扩散 + 内圈快速弹开 */
.stamp.anim {
  animation: stampRing 0.5s ease-out forwards;
}
.stamp.anim2 {
  transform-box: fill-box;
  transform-origin: center;
  animation: stampRing2 0.3s ease-out forwards;
}
@keyframes stampRing {
  0% {
    transform: scale(0.3);
    opacity: 1;
  }
  60% {
    transform: scale(1.1);
    opacity: 0.8;
  }
  100% {
    transform: scale(1.45);
    opacity: 0;
  }
}
@keyframes stampRing2 {
  0% {
    transform: scale(0.2);
    opacity: 1;
  }
  100% {
    transform: scale(1.2);
    opacity: 0;
  }
}

/* 走子前导动画:待动子闪烁高亮、目标格虚线呼吸 */
.anim-lead {
  pointer-events: none;
}
.hover-glint {
  transform-box: fill-box;
  transform-origin: center;
  animation: hoverBlink 0.3s ease-in-out 3;
}
@keyframes hoverBlink {
  0%,
  100% {
    opacity: 0.15;
    transform: scale(0.85);
  }
  50% {
    opacity: 1;
    transform: scale(1.12);
  }
}
.hover-dst {
  transform-box: fill-box;
  transform-origin: center;
  animation: dstBreathe 0.6s ease-in-out infinite;
}
@keyframes dstBreathe {
  0%,
  100% {
    opacity: 0.4;
  }
  50% {
    opacity: 1;
  }
}
/* 路径:亮线 + 箭头,虚线流动 */
.path-line {
  stroke: #ffd57a;
  stroke-width: 3.2;
  stroke-linecap: round;
  stroke-dasharray: 7 5;
  filter: drop-shadow(0 0 3px rgba(255, 213, 122, 0.9));
  animation: pathFlow 0.5s linear infinite;
}
@keyframes pathFlow {
  to {
    stroke-dashoffset: -24;
  }
}
.path-arrow {
  fill: #ffd57a;
  filter: drop-shadow(0 0 3px rgba(255, 213, 122, 0.9));
}

@media (prefers-reduced-motion: reduce) {
  .pc {
    transition: none;
  }
  .pc-inner.land,
  .stamp.anim,
  .stamp.anim2,
  .from-dot,
  .last-dot,
  .hover-glint,
  .hover-dst,
  .path-line {
    animation: none;
  }
}
</style>