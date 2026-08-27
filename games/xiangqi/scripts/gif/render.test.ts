// scripts/gif/render.test.ts
import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../../server/game-log';
import { buildFrames } from './frames';
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