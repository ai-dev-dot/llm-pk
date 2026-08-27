//
// gifenc 无官方 TS 类型声明 —— 本文件为其结界声明(scripts/gif/ 用)。
// 实测两种运行时形态不同(详见 encode.ts 头部注释):
//   - tsx / 纯 Node(CJS 互操作):named-import 取不到 `GIFEncoder`(SyntaxError),`default` = 全量对象;
//   - vitest(Vite SSR → dist/gifenc.esm.js):named 命导出可取,`default` = GIFEncoder 函数;
// 故本声明同时提供 named 命导出与 default,均以 encode.ts 的运行时归一代码为准。
declare module 'gifenc' {
  export interface GIFEncoderOptions {
    initialCapacity?: number;
    auto?: boolean;
  }

  export interface WriteFrameOptions {
    transparent?: boolean;
    transparentIndex?: number;
    /** 毫秒;gifenc 内部 /10 换 1/100s(注意:不要再二次换算)。 */
    delay?: number;
    palette?: [number, number, number][];
    repeat?: number;
    colorDepth?: number;
    dispose?: number;
  }

  export interface GIFEncoderInstance {
    reset(): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    readonly buffer: ArrayBuffer;
    writeFrame(index: Uint8Array, width: number, height: number, opts?: WriteFrameOptions): void;
  }

  export function GIFEncoder(opts?: GIFEncoderOptions): GIFEncoderInstance;

  /** RGBA 直送(4 字节/像素;内部按 Uint32 窗口取 R/G/B —— 送 3bpp RGB 会错位)。返回每像素色表索引。 */
  export function applyPalette(data: Uint8Array | Uint8ClampedArray, palette: [number, number, number][]): Uint8Array;

  export function quantize(
    rgba: Uint8Array,
    maxColors: number,
    options?: {
      format?: 'rgb444' | 'rgb565' | 'rgba4444';
      clearAlpha?: boolean;
      clearAlphaColor?: number;
      clearAlphaThreshold?: number;
      oneBitAlpha?: boolean;
      useSqrt?: boolean;
    },
  ): Uint8Array;

  export default GIFEncoder;
}