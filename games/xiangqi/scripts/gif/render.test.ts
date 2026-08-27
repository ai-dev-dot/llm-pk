// scripts/gif/render.test.ts
import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../../server/game-log';
import { buildFrames, type Frame } from './frames';
import { renderFrameToRgba, renderFramePng, TICKER_H, renderBounds } from './render';
import { resolveFontPath, registerFont, FAMILY } from './fonts';
import { PALETTE, appearsInPalette } from './palette';
import { createCanvas } from '@napi-rs/canvas';

const font = resolveFontPath();
const ctx = createCanvas(2, 2).getContext('2d');
if (font) { registerFont(font); ctx.font = `12px ${FAMILY}`; }

const b = (n: number) => ({ seq: n, ts: 't', type: 'begin', gameId: 'g', first: 'red', red: { model: 'R' }, black: { model: 'B' } }) as GameEvent;
const mv = (seq: number, f: string, t: string, turn: 'red' | 'black') => ({ seq, ts: 't', type: 'move', turn, move: { from: f, to: t }, legal: true }) as GameEvent;
const fin = (seq: number, winner: 'red' | 'black' | 'draw', reason: string) => ({ seq, ts: 't', type: 'finish', winner, reason, ruleViolations: { red: { pre: 0, post: 0 }, black: { pre: 0, post: 0 } } }) as GameEvent;
const framesFor = (evs: GameEvent[]) => buildFrames(evs, { speed: 1 });

describe('render', () => {
  it('画布几何与文件产出', () => {
    const { width, height } = renderBounds(900);
    expect(width).toBe(900);
    expect(height).toBe(900 + TICKER_H);
  });

  it('open 帧 RGBA 尺寸与主色板色', () => {
    const frames = framesFor([b(1), mv(2, 'h3', 'e3', 'red')]);
    const buf = renderFrameToRgba(frames[0]!, 900);
    expect(buf.length).toBe(900 * (900 + TICKER_H) * 4);
    // 抽样 32 点,除文字 AA 外皆在色板(容差:文字局部少量 AA 允许)
    let outside = 0;
    for (let i = 0; i < 400; i++) {
      const x = Math.floor(Math.random() * 900);
      const y = Math.floor(Math.random() * 900);
      const o = (y * 900 + x) * 4;
      if (!appearsInPalette([buf[o]!, buf[o + 1]!, buf[o + 2]!])) outside++;
      if (outside > 60) break;
    }
    expect(outside).toBeLessThanOrEqual(60);
  });

  it.skipIf(!font)('字体存在时 final 横幅可渲染(不抛)', () => {
    const frames = framesFor([b(1), mv(2, 'h3', 'e3', 'red'), fin(3, 'red', 'checkmate')]);
    const png = renderFramePng(frames.at(-1)!, 900);
    expect(png.length).toBeGreaterThan(100);
    expect(png.subarray(0, 4).toString('hex')).toBe('89504e47'); // PNG magic
  });

  // 行列坐标细字(spec §5):左行号 1..10、上下列标 a..i 对称不镜像。
  // 用空盘帧渲染(无棋子遮挡),逐标签扫描其应落墨区域断言 P.grid2 细色像素存在;
  // 顶部九宫斜线/网格线均为 P.grid(非 P.grid2),不会误报。
  it('行列坐标:左行号 1..10、上下列标 a..i 落墨(palette 内 P.grid2 细色)', () => {
    const frame: Frame = {
      mode: 'open',
      board: [],
      caption: { round: 1, notation: '', cur: 0, total: 0, mover: 'red', rejection: 0, left: '', right: 'R vs B' },
      banner: null,
      delayMs: 1500,
    };
    const W = 720;
    const buf = renderFrameToRgba(frame, W);
    const cell = (W - 2 * 46) / 8;
    const padTop = (W - 9 * cell) / 2;
    const px = (c: number) => 46 + c * cell;
    const py = (r: number) => padTop + (9 - r) * cell;
    const fh = Math.max(1, Math.round(cell * 0.18)); // 与 render 同口径字号
    const ink = [0x8a, 0x5a, 0x30]; // P.grid2
    // 距离容差匹配:只认「近 P.grid2 色」(含 70%+ 实色字形核心),排除 P.grid 网格线/九宫斜线(90,58,34)。
    const nearInk = (o: number): boolean => {
      const d = Math.max(Math.abs(buf[o]! - ink[0]), Math.abs(buf[o + 1]! - ink[1]), Math.abs(buf[o + 2]! - ink[2]));
      return d <= 40;
    };
    const countInk = (x0: number, y0: number, x1: number, y1: number): number => {
      let n = 0;
      for (let y = Math.max(0, Math.floor(y0)); y < Math.min(W, Math.ceil(y1)); y++) {
        for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) {
          const o = (y * W + x) * 4;
          if (nearInk(o)) n++;
        }
      }
      return n;
    };
    // 左行号:留白区 x∈[0, MARGIN-4](避开左格线与斜线),按各 rank 中线扫
    const rankY = (r: number) => py(r);
    for (let r = 0; r <= 9; r++) {
      const n = countInk(0, rankY(r) - fh, 46 - 4, rankY(r) + fh);
      expect(n, `左行号 rank${r}(1..10)应落墨`).toBeGreaterThanOrEqual(2);
    }
    // 上下列标:以各 file 中心为轴、标签行线为心扫(不含首末行线/斜线所在行带之外)
    const topY = py(9) + cell * 0.22;
    const botY = py(0) - cell * 0.22;
    for (let f = 0; f <= 8; f++) {
      expect(countInk(px(f) - cell * 0.28, topY - fh, px(f) + cell * 0.28, topY + fh), `上列标 file${f}(a..i)应落墨`).toBeGreaterThanOrEqual(2);
      expect(countInk(px(f) - cell * 0.28, botY - fh, px(f) + cell * 0.28, botY + fh), `下列标 file${f}(a..i)应落墨`).toBeGreaterThanOrEqual(2);
    }
    // 左留白整条 + 标签带应全在 palette(细字只取 P.grid2,AA 边缘由渲染量化,测试容忍不放宽)
    let outside = 0;
    for (let y = 0; y < W; y += 3) {
      for (let x = 0; x < 46 - 4; x += 3) {
        const o = (y * W + x) * 4;
        if (!appearsInPalette([buf[o]!, buf[o + 1]!, buf[o + 2]!])) outside++;
      }
    }
    expect(outside / Math.ceil(W / 3)).toBeLessThanOrEqual(2); // 平均每行≤2 个越面色点(AA 微量)
  });

  // 色板契约引脚:24 色全表逐字固定(含顺序)——防未来渲染层重排色板导致 RBG 漂移而不自知。
  it('色板契约:24 色全表逐字固定(含顺序)', () => {
    const canonical = [
      'd9a066', 'e3b877', 'c9964f', // 木板 3 档
      '5a3a22', '8a5a30', 'a88850', // 网格线 / 河界 / 九宫斜线
      'f7e6c9', 'c02020', 'a01818', // 红方棋子:底 / 字 / 环
      '2a2a2a', 'f2eee8', 'd8d2c8', // 黑方棋子:底 / 字 / 环
      'f7e0a0', 'ffcc00',           // 高亮:from 淡黄 / to 亮黄
      '2f2f2f', 'b8b8b8', 'ffffff', // 字幕条底 / 副字 / 主字
      '1a1a1a', 'ffe27a', 'd8d8d8', // 横幅:暗底 / 主字 / 副字
      'd03838', '3a3a3a',           // 行棋方红 / 黑圆点
      'c03a3a', 'ffe1e1',           // 打回徽标底 / 字
    ];
    expect(PALETTE.length).toBe(24);
    const hexOf = (rgb: readonly [number, number, number]) => rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
    expect(PALETTE.map(hexOf)).toEqual(canonical);
  });
});