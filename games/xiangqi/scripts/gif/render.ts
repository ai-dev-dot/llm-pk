//
// canvas 棋局渲染(色板即绘制色,spec §5)。
// 大面积色只用 PALETTE 内颜色、禁止渐变;文字 AA 像素由渲染侧直接落在板内邻色。
//
import { createCanvas } from '@napi-rs/canvas';
import type { SKRSContext2D } from '@napi-rs/canvas';
import type { Frame } from './frames';
import { PALETTE } from './palette';
import { FAMILY } from './fonts';

export const TICKER_H = 140;
const MARGIN = 46;

// 色板索引 P(与 scripts/gif/palette.ts 顺序严格对应)
const P = {
  wood0: 0, wood1: 1, wood2: 2, grid: 3, grid2: 4, river: 5,
  redBg: 6, redChar: 7, redRing: 8, blackBg: 9, blackChar: 10, blackRing: 11,
  hlFrom: 12, hlTo: 13, tickerBg: 14, tickerSub: 15, tickerMain: 16,
  bannerBg: 17, bannerMain: 18, bannerSub: 19, moverRed: 20, moverBlack: 21,
  badgeBg: 22, badgeText: 23,
} as const;

// 任务卡 Step 3 原样式不带 `rgba(...)` 括号 → 裸 `r,g,b,a` 不是合法 CSS color,
// napi-rs 会静默保持原 fillStyle(实测落为黑)。修样板:包上 rgba() 使色板真正生效。
const rgba = (i: number, a = 255) => `rgba(${PALETTE[i]![0]},${PALETTE[i]![1]},${PALETTE[i]![2]},${a})`;

const PIECE_CHAR: Record<string, string> = {
  'red:rook': '車', 'red:horse': '馬', 'red:elephant': '相', 'red:advisor': '仕',
  'red:general': '帥', 'red:cannon': '砲', 'red:pawn': '兵',
  'black:rook': '車', 'black:horse': '馬', 'black:elephant': '象', 'black:advisor': '士',
  'black:general': '將', 'black:cannon': '砲', 'black:pawn': '卒',
};

export function renderBounds(boardSize: number): { width: number; height: number } {
  return { width: boardSize, height: boardSize + TICKER_H };
}

// —— 绘制辅助(全部只在 PALETTE 内部取值) ——
const fill = (ctx: SKRSContext2D, i: number) => { ctx.fillStyle = rgba(i); };
const stroke = (ctx: SKRSContext2D, i: number) => { ctx.strokeStyle = rgba(i); };

export function drawFrame(ctx: SKRSContext2D, frame: Frame, boardSize: number): void {
  const W = boardSize;
  const H = boardSize + TICKER_H;
  const cell = (boardSize - 2 * MARGIN) / 8;
  const gridW = 8 * cell;
  const gridH = 9 * cell;
  const padTop = (boardSize - gridH) / 2;
  const px = (col: number) => MARGIN + col * cell;
  const py = (rank: number) => padTop + (9 - rank) * cell;
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  };

  // 底
  fill(ctx, P.wood1); ctx.fillRect(0, 0, W, boardSize);
  fill(ctx, P.tickerBg); ctx.fillRect(0, boardSize, W, TICKER_H);

  // 网格线
  stroke(ctx, P.grid);
  ctx.lineWidth = Math.max(1, cell * 0.03);
  for (let c = 0; c <= 8; c++) { line(px(c), py(0), px(c), py(4)); line(px(c), py(5), px(c), py(9)); }
  for (let r = 0; r <= 9; r++) line(px(0), py(r), px(8), py(r));
  // 九宫斜线(红 rank0-2 / 黑 rank7-9)
  stroke(ctx, P.grid);
  line(px(0), py(0), px(2), py(2)); line(px(0), py(8), px(2), py(6));
  line(px(6), py(0), px(8), py(2)); line(px(6), py(8), px(8), py(6));
  line(px(0), py(9), px(2), py(7)); line(px(0), py(1), px(2), py(3));
  line(px(6), py(9), px(8), py(7)); line(px(6), py(1), px(8), py(3));

  // 河界文字(rank4/5 之间)
  fill(ctx, P.river);
  ctx.font = `${Math.round(cell * 0.34)}px ${FAMILY}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('楚 河 漢 界', px(4), (py(4) + py(5)) / 2);

  // 高亮格(先于棋子)
  if (frame.from) {
    fill(ctx, P.hlFrom);
    ctx.beginPath();
    ctx.roundRect(px(frame.from.file) - cell * 0.5, py(frame.from.rank) - cell * 0.5, cell, cell, cell * 0.12);
    ctx.fill();
  }
  if (frame.to) {
    fill(ctx, P.hlTo);
    ctx.beginPath();
    ctx.roundRect(px(frame.to.file) - cell * 0.5, py(frame.to.rank) - cell * 0.5, cell, cell, cell * 0.12);
    ctx.fill();
  }

  // 棋子
  for (const p of frame.board) {
    let col = p.file;
    let rank = p.rank;
    let scale = 1;
    if (frame.mode === 'slide' && frame.from && frame.to && frame.slideT !== undefined) {
      const isMover = p.file === frame.from.file && p.rank === frame.from.rank && p.side === frame.caption.mover;
      const isTaken = p.file === frame.to.file && p.rank === frame.to.rank && !isMover;
      if (isMover) { col = lerp(frame.from.file, frame.to.file, frame.slideT); rank = lerp(frame.from.rank, frame.to.rank, frame.slideT); }
      if (isTaken) { scale = 1 - frame.slideT; if (scale <= 0) continue; }
    }
    const cx = px(col);
    const cy = py(rank);
    const r = cell * 0.42 * scale;
    const char = PIECE_CHAR[`${p.side}:${p.type}`] ?? '?';
    const isRed = p.side === 'red';
    stroke(ctx, isRed ? P.redRing : P.blackRing);
    ctx.lineWidth = cell * 0.05;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    fill(ctx, isRed ? P.redBg : P.blackBg);
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    fill(ctx, isRed ? P.redChar : P.blackChar);
    ctx.font = `${Math.round(cell * 0.55 * scale)}px ${FAMILY}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(char, cx, cy + (scale < 1 ? Math.round(cell * 0.05) : 0));
  }

  // 字幕条
  fill(ctx, P.tickerSub);
  const leftText = `第 ${frame.caption.round} 回合·${frame.caption.notation || '—'}`;
  const midText = `第 ${frame.caption.cur}/${frame.caption.total} 手`;
  const rightText = frame.caption.right || '';
  ctx.font = `${Math.round(boardSize * 0.026)}px ${FAMILY}`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const ty = boardSize + TICKER_H / 2;
  const label = (t: string, x: number, color: number) => { fill(ctx, color); ctx.fillText(t, x, ty); };
  label(leftText, 24, 16);
  label(midText, boardSize * 0.42, 15);
  // 行棋方圆点
  if (frame.caption.mover) {
    const dot = frame.caption.mover === 'red' ? P.moverRed : P.moverBlack;
    fill(ctx, dot);
    ctx.beginPath(); ctx.arc(boardSize * 0.42 - 16, ty, 7, 0, Math.PI * 2); ctx.fill();
  }
  label(rightText, boardSize * 0.55, 15);
  // 打回徽标
  if (frame.caption.rejection > 0) {
    fill(ctx, P.badgeBg);
    const bt = `⚠ 打回×${frame.caption.rejection}`;
    ctx.font = `${Math.round(boardSize * 0.02)}px ${FAMILY}`;
    const w = ctx.measureText(bt).width + 16;
    ctx.roundRect(boardSize * 0.78, ty - 12, w, 24, 6); ctx.fill();
    fill(ctx, P.badgeText);
    ctx.fillText(bt, boardSize * 0.78 + 8, ty);
  }

  // 结果横幅(final 帧叠加)
  if (frame.banner) {
    const bw = boardSize * 0.62;
    const bh = boardSize * 0.34;
    fill(ctx, P.bannerBg);
    ctx.roundRect((W - bw) / 2, boardSize * 0.3, bw, bh, 12); ctx.fill();
    fill(ctx, P.bannerMain);
    ctx.font = `${Math.round(boardSize * 0.07)}px ${FAMILY}`;
    ctx.textAlign = 'center';
    ctx.fillText(frame.banner.title, W / 2, boardSize * 0.3 + bh * 0.42);
    if (frame.banner.sub) {
      fill(ctx, P.bannerSub);
      ctx.font = `${Math.round(boardSize * 0.032)}px ${FAMILY}`;
      ctx.fillText(frame.banner.sub, W / 2, boardSize * 0.3 + bh * 0.75);
    }
  }
}

export function renderFrameToRgba(frame: Frame, boardSize: number): Uint8Array {
  const { width, height } = renderBounds(boardSize);
  const c = createCanvas(width, height);
  const ctx = c.getContext('2d');
  drawFrame(ctx, frame, boardSize);
  const d = ctx.getImageData(0, 0, width, height).data;
  return new Uint8Array(d);
}

export function renderFramePng(frame: Frame, boardSize: number): Buffer {
  const { width, height } = renderBounds(boardSize);
  const c = createCanvas(width, height);
  const ctx = c.getContext('2d');
  drawFrame(ctx, frame, boardSize);
  return c.toBuffer('image/png');
}