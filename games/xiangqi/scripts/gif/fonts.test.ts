// scripts/gif/fonts.test.ts
import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { resolveFontPath, registerFont, assertGlyphs, FAMILY } from './fonts';

describe('fonts', () => {
  it('探测链返回可注册路径或 null(显式缺失时 null)', () => {
    expect(resolveFontPath() === null || typeof resolveFontPath() === 'string').toBe(true);
    if (resolveFontPath('/definitely/missing/foo.ttf') !== null) {
      expect(false).toBe(true); // 显式存在的伪路径不应命中
    }
  });

  it('存在字体时注册 + 传统字形覆盖非空', () => {
    const p = resolveFontPath();
    if (!p) return; // 本机无中文字体 → 跳过(CI 同理)
    registerFont(p);
    const canvas = createCanvas(4, 4);
    const ctx = canvas.getContext('2d');
    ctx.font = `24px ${FAMILY}`;
    const missing = assertGlyphs(ctx);
    expect(missing).toHaveLength(0);
  });
});