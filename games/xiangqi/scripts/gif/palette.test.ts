import { describe, expect, it } from 'vitest';
import { PALETTE, hex, nearest, appearsInPalette, paletteIndexOf } from './palette';

describe('palette', () => {
  it('色表条目合法且唯一', () => {
    expect(PALETTE.length).toBeGreaterThan(16);
    expect(PALETTE.length).toBeLessThanOrEqual(256);
    const j = new Set(PALETTE.map(([r, g, b]) => `${r},${g},${b}`));
    expect(j.size).toBe(PALETTE.length);
  });

  it('hex 解析为十进制三元组', () => {
    expect(hex('d9a066')).toEqual([217, 160, 102]);
  });

  it('nearest 对已含色返回原色', () => {
    const hit = PALETTE[0]!;
    expect(nearest([hit[0], hit[1], hit[2]])).toEqual(Array.from(hit));
  });

  it('nearest 对渐变中间色收敛到表内', () => {
    const out = nearest([200, 150, 90]);
    expect(appearsInPalette([...out])).toBe(true);
  });

  it('paletteIndexOf 与 nearest 同源', () => {
    const q = [12, 34, 56] as const;
    expect(PALETTE[paletteIndexOf(q)]).toEqual(Array.from(nearest(q)));
  });

  it('appearsInPalette 判定纯色', () => {
    expect(appearsInPalette([...PALETTE[1]!])).toBe(true);
    expect(appearsInPalette([1, 2, 3])).toBe(false);
  });
});