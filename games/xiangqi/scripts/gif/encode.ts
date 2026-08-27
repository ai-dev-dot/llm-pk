//
// GIF 编码 + 分片 + 封面(spec §6/§7/§8)。
// 固定色板(不用 quantize,避免逐帧量化闪烁);delay 毫秒直送 gifenc(其内部 /10 换 1/100s,
// 不要再二次换算);分片按「步块」二分,末段保留真实横幅、非末段由 withContinueMarkers 收尾「未完·续」。
// 文字 AA 像素纳入固定色板:renderFrameToRgba → applyPalette 最近邻量化是唯一承接口,全部产物像素必在
// PALETTE 内(测试可加断言)。
//
import * as gifenc from 'gifenc';
import type { Frame } from './frames';
import { PALETTE } from './palette';
import { renderFrameToRgba, renderFramePng, renderBounds } from './render';

// gifenc 无官方类型(见 scripts/gif/gifenc.d.ts),且同一包在两种加载器下形态不同(实测):
//   - tsx / 纯 Node(CJS 互操作):`import { GIFEncoder } from 'gifenc'` 直接 SyntaxError
//     (“does not provide an export named”),namespace 上也无命导出;`default` = 全量对象;
//   - vitest(Vite SSR → dist/gifenc.esm.js):named 命导出一致可取;`default` = GIFEncoder 函数。
// 故一律用 namespace 导入 + 运行时归一:namespace 自带 `GIFEncoder` 命导出(ESM 形态)则直接用,
// 否则回落 `default`(CJS 形态;其键集与命导出一致)。tsx / vitest 双形态均已实测通过。
type GifencApi = {
  GIFEncoder: (opts?: { initialCapacity?: number; auto?: boolean }) => {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: {
        palette?: [number, number, number][];
        delay?: number;
        repeat?: number;
        transparent?: boolean;
        transparentIndex?: number;
        colorDepth?: number;
        dispose?: number;
      },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  };
  applyPalette: (rgba: Uint8Array, palette: [number, number, number][]) => Uint8Array;
};
const gifencNs = gifenc as unknown as GifencApi & { default?: GifencApi };
const api: GifencApi = typeof gifencNs.GIFEncoder === 'function' ? gifencNs : (gifencNs.default as GifencApi);
const { GIFEncoder, applyPalette } = api;

// 固定色板:全帧最近邻量化,产物逐像素必在 PALETTE 内。
const palette = PALETTE as unknown as [number, number, number][];

export function encodeGifBytes(frames: Frame[], boardSize: number): Uint8Array {
  if (frames.length === 0) throw new Error('encodeGifBytes: 空帧集合不可编码(GIF 规范不允许零帧)');
  const { width, height } = renderBounds(boardSize);
  const gif = GIFEncoder();
  for (const f of frames) {
    // renderFrameToRgba 返回 RGBA(4 字节/像素);applyPalette 内部按 Uint32 窗口取 R/G/B，
    // 必须直送 RGBA —— 转 3bpp RGB 会错位(见 probe)。
    const rgba = renderFrameToRgba(f, boardSize);
    const index = applyPalette(rgba, palette);
    gif.writeFrame(index, width, height, { palette, delay: f.delayMs });
  }
  gif.finish();
  return new Uint8Array(gif.bytes());
}

export function groupChunks(frames: Frame[]): Frame[][] {
  const chunks: Frame[][] = [];
  let cur: Frame[] = [];
  const flush = () => { if (cur.length) { chunks.push(cur); cur = []; } };
  for (const f of frames) {
    if (f.mode === 'open' || f.mode === 'final') { flush(); chunks.push([f]); continue; }
    cur.push(f);
    if (f.mode === 'land') flush();
  }
  flush();
  return chunks;
}

export function shardFrames(frames: Frame[], boardSize: number, maxBytes: number): Frame[][] {
  const chunks = groupChunks(frames);
  const bytesOf = (c: Frame[][]) => encodeGifBytes(c.flat(), boardSize).length;
  const cut = (c: Frame[][]): Frame[][] => {
    if (c.length <= 1) return [c.flat()]; // 单块不再切(可能仍超预算,交由调用方提示)
    if (bytesOf(c) <= maxBytes) return [c.flat()];
    const mid = Math.max(1, Math.floor(c.length / 2));
    return [...cut(c.slice(0, mid)), ...cut(c.slice(mid))];
  };
  return cut(chunks);
}

export function withContinueMarkers(shards: Frame[][]): Frame[][] {
  return shards.map((seg, idx, arr) => {
    if (idx === arr.length - 1) return seg; // 末段保持真实终局横幅
    const last = seg.at(-1)!;
    return [...seg, { ...last, mode: 'final', banner: { title: '未完 · 续', sub: `第 ${idx + 1}/${arr.length} 段` }, delayMs: 1500 }];
  });
}

export function coverPngBuffer(frames: Frame[], boardSize: number): Buffer {
  if (frames.length === 0) throw new Error('coverPngBuffer: 空帧集合无封面可生成');
  return renderFramePng(frames[0]!, boardSize);
}