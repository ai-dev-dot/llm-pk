//
// 固定色板(色板即绘制色,spec §5/§10)。
// 所有棋盘/棋子/字幕/横幅颜色只能取本表;禁止渐变/插值;文字 AA 像素靠 nearest() 量化。
//

export type Rgb = readonly [number, number, number];

/** 十六进制 '#rrggbb'|'rrggbb' → [r,g,b]。 */
export function hex(h: string): [number, number, number] {
  const s = h.replace(/^#/, '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

const C = hex;

export const PALETTE: ReadonlyArray<Rgb> = Object.freeze([
  // 棋盘木板(3 档)
  C('d9a066'), C('e3b877'), C('c9964f'),
  // 网格线 / 河界 / 九宫斜线
  C('5a3a22'), C('8a5a30'), C('a88850'),
  // 红方棋子:底 / 字 / 环 ; 黑方棋子: 底 / 字 / 环
  C('f7e6c9'), C('c02020'), C('a01818'),
  C('2a2a2a'), C('f2eee8'), C('d8d2c8'),
  // 高亮:from 淡黄 / to 亮黄
  C('f7e0a0'), C('ffcc00'),
  // 字幕条底 / 副字 / 主字
  C('2f2f2f'), C('b8b8b8'), C('ffffff'),
  // 横幅:暗底 / 主字 / 副字
  C('1a1a1a'), C('ffe27a'), C('d8d8d8'),
  // 行棋方红/黑圆点
  C('d03838'), C('3a3a3a'),
  // 打回徽标
  C('c03a3a'), C('ffe1e1'),
]);

const SQ = 3 ** 3; // 每通道各 3 段(简化 LUT)

/** 最近邻索引(暴力线性 48 色 × 像素数 OK;需要时再 LUT)。返回色表内条目索引。 */
export function paletteIndexOf(rgb: Rgb): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < PALETTE.length; i++) {
    const p = PALETTE[i]!;
    const d = (rgb[0] - p[0]) ** 2 + (rgb[1] - p[1]) ** 2 + (rgb[2] - p[2]) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** 最近邻颜色。 */
export function nearest(rgb: Rgb): Rgb {
  return PALETTE[paletteIndexOf(rgb)]!;
}

/** 与色表完全相等。 */
export function appearsInPalette(rgb: Rgb): boolean {
  for (const p of PALETTE) if (p[0] === rgb[0] && p[1] === rgb[1] && p[2] === rgb[2]) return true;
  return false;
}