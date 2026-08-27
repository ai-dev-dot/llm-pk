// scripts/gif/encode.test.ts
import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../../server/game-log';
import { buildFrames, type Frame } from './frames';
import { encodeGifBytes, groupChunks, shardFrames, withContinueMarkers, coverPngBuffer } from './encode';
import { resolveFontPath, registerFont } from './fonts';
import { applyPalette } from 'gifenc';
import { PALETTE, appearsInPalette } from './palette';

const font = resolveFontPath();
if (font) registerFont(font);
const hasFont = font !== null;

const b = (n: number) => ({ seq: n, ts: 't', type: 'begin', gameId: 'g', first: 'red', red: { model: 'R' }, black: { model: 'B' } }) as GameEvent;
const mv = (s: number, f: string, t: string, turn: 'red' | 'black') => ({ seq: s, ts: 't', type: 'move', turn, move: { from: f, to: t }, legal: true }) as GameEvent;
const fin = (s: number, winner: 'red' | 'black' | 'draw', reason: string) => ({ seq: s, ts: 't', type: 'finish', winner, reason, ruleViolations: { red: { pre: 0, post: 0 }, black: { pre: 0, post: 0 } } }) as GameEvent;
const framesFor = (evs: GameEvent[]) => buildFrames(evs, { speed: 1 });

describe('encode', () => {
  it.skipIf(!hasFont)('编码产物以 GIF89a 开头且非空', () => {
    const fs = framesFor([b(1), mv(2, 'h3', 'e3', 'red'), fin(3, 'red', 'checkmate')]);
    const buf = encodeGifBytes(fs, 900);
    expect(buf.length).toBeGreaterThan(100);
    expect(Array.from(buf.subarray(0, 6)).join(',')).toBe('71,73,70,56,57,97');
  });

  it('groupChunks 按步切块(open 单块 + 每步一步块 + final 单块)', () => {
    const fs = framesFor([b(1), mv(2, 'h3', 'e3', 'red'), mv(3, 'h8', 'e8', 'black')]);
    const chunks = groupChunks(fs);
    // 上游 frames.buildFrames 恒在末尾追加 final 帧(未完成局以当前局面作终局),故 = open + step1 + step2 + final
    expect(chunks.length).toBe(4);
    expect(chunks[0]!.map((f) => f.mode)).toEqual(['open']);
    expect(chunks[1]!.map((f) => f.mode)).toEqual(['hold', 'slide', 'slide', 'slide', 'slide', 'land']);
    expect(chunks[3]!.map((f) => f.mode)).toEqual(['final']);
  });

  it.skipIf(!hasFont)('withContinueMarkers 给非末段加「未完·续」,末段不变', () => {
    const fs = framesFor([b(1), mv(2, 'h3', 'e3', 'red'), mv(3, 'h8', 'e8', 'black'), fin(4, 'red', 'checkmate')]);
    const shards = shardFrames(fs, 720, 4_000); // 小预算 → 必分片
    expect(shards.length).toBeGreaterThan(1);
    const marked = withContinueMarkers(shards);
    for (let i = 0; i < marked.length - 1; i++) {
      expect(marked[i]!.at(-1)!.mode).toBe('final');
      expect(marked[i]!.at(-1)!.banner!.title).toBe('未完 · 续');
    }
    expect(marked.at(-1)!.at(-1)!.banner!.title).not.toBe('未完 · 续');
  });

  it.skipIf(!hasFont)('极小预算必分片,且每片编码各为合法 GIF89a', () => {
    const fs = framesFor([b(1), mv(2, 'h3', 'e3', 'red'), mv(3, 'h8', 'e8', 'black'), fin(4, 'red', 'checkmate')]);
    const shards = shardFrames(fs, 720, 2_000); // 更小预算 → 分片更碎
    expect(shards.length).toBeGreaterThan(1);
    for (const seg of shards) {
      const buf = encodeGifBytes(seg, 720);
      expect(buf.length).toBeGreaterThan(100);
      expect(Array.from(buf.subarray(0, 6)).join(',')).toBe('71,73,70,56,57,97'); // GIF89a
    }
  });

  it('空帧集合明确拒绝(GIF 规范不允许零帧)', () => {
    expect(() => encodeGifBytes([], 900)).toThrow();
  });

  it('coverPngBuffer 产出 PNG(magic 89504e47)', () => {
    const fs = framesFor([b(1), mv(2, 'h3', 'e3', 'red')]);
    const png = coverPngBuffer(fs, 720);
    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png.length).toBeGreaterThan(100);
    expect(png.subarray(0, 4).toString('hex')).toBe('89504e47');
  });

  // 文字 AA 像素纳入固定色板的唯一承接口:blend(非色板色)送 applyPalette 最近邻 → 索引必为 PALETTE 内颜色。
  it('固定色板最近邻:非色板 AA 混合像素量化后必落回 PALETTE', () => {
    const pal = PALETTE as unknown as [number, number, number][];
    const a = pal[1]!; // wood1 木板
    const b = pal[16]!; // tickerMain 白
    const rgba = new Uint8Array(32 * 4);
    for (let i = 0; i < 32; i++) {
      const t = i / 31;
      rgba[i * 4] = Math.round(a[0] + (b[0] - a[0]) * t);
      rgba[i * 4 + 1] = Math.round(a[1] + (b[1] - a[1]) * t);
      rgba[i * 4 + 2] = Math.round(a[2] + (b[2] - a[2]) * t);
      rgba[i * 4 + 3] = 255;
    }
    const idx = applyPalette(rgba, pal);
    expect(idx.length).toBe(32);
    for (const i of idx) {
      const c = pal[i]!;
      expect(appearsInPalette([c[0], c[1], c[2]])).toBe(true);
    }
  });
});