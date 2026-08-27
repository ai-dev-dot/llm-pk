//
// 中文字体解析(动图导出专用,spec §3/§9):
//  - 探测链: --font → simkai(楷体) → simhei(黑体) → msyh(雅黑) → simsun(宋体);
//  - registerFont 用固定族名 'XQFont',render 用该族名;
//  - assertGlyphs 对传统字形域抽样,任一宽度 0 → 调用方报缺字形 exit 2。
//
import { existsSync } from 'node:fs';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

export const FAMILY = 'XQFont';

export const FONT_CANDIDATES = [
  'C:/Windows/Fonts/simkai.ttf',  // 楷体
  'C:/Windows/Fonts/simhei.ttf',  // 黑体
  'C:/Windows/Fonts/msyh.ttc',    // 雅黑(ttc 集合;registerFromPath 实测可注册,不必 --font 指定 ttf)
  'C:/Windows/Fonts/simsun.ttc',  // 宋体(ttc 集合;同上)
];

export function resolveFontPath(explicit?: string): string | null {
  if (explicit) return existsSync(explicit) ? explicit : null;
  for (const p of FONT_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

export function registerFont(path: string): void {
  GlobalFonts.registerFromPath(path, FAMILY);
}

const GLYPH_PROBES = '帥將車馬相仕象士砲炮兵卒楚河漢界絕殺困毙';

// @napi-rs/canvas 未导出 CanvasRenderingContext2D(该 interface 仅内部声明,index.d.ts 无此命名导出);
// 以 createCanvas 的 2d 上下文返回类型等价替代(实测 = SKRSContext2D),避免依赖内部类型名。
type Ctx2D = ReturnType<ReturnType<typeof createCanvas>['getContext']>;

export function assertGlyphs(ctx: Ctx2D): string[] {
  ctx.font = `24px ${FAMILY}`;
  const missing: string[] = [];
  for (const ch of GLYPH_PROBES) {
    if (ctx.measureText(ch).width === 0) missing.push(ch);
  }
  return missing;
}