//
// 动图导出 CLI 的可测逻辑(spec §9 / Task 8):
//  - parseArgs:位置参数 = gameId,--all 批量,其余 --out/--font/--width/--speed/--max-kb;
//  - sanitizeGameId:basename 净化(去路径成分与 .jsonl 后缀),非法字符直接拒绝;
//  - exportGame:整局日志 → 帧序列 → 分片 → 编码写盘(.tmp→rename 原子落)+ 封面 PNG。
// 延迟口径:frames.delayMs 毫秒直送 gifenc,本层绝不再 /10 换算(见 encode.ts 注释)。
//
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { readGameEvents } from './events';
import { buildFrames } from './frames';
import { encodeGifBytes, shardFrames, withContinueMarkers, coverPngBuffer } from './encode';
import { renderBounds } from './render';

export interface GifOpts { width: number; speed: 1 | 2; maxKb: number; explicitFont?: string }

export function resolveLogsDir(repoRoot: string): string {
  return `${repoRoot}/logs`;
}

const GID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function sanitizeGameId(raw: string): string {
  const name = basename(String(raw).trim());
  const stripped = name.replace(/\.jsonl$/i, '');
  if (!GID_RE.test(stripped)) throw new Error(`非法 gameId: ${name}(仅允许字母数字 . _ - ,且不带路径)`);
  return stripped;
}

export function parseArgs(argv: string[]): { all: boolean; gameId?: string; out: string | null; opts: GifOpts } {
  let all = false, gameId: string | undefined, out: string | null = null;
  const opts: GifOpts = { width: 900, speed: 1, maxKb: 2048 };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '--all': all = true; break;
      case '--out': out = argv[++i] ?? null; break;
      case '--font': opts.explicitFont = argv[++i]; break;
      case '--width': opts.width = Number(argv[++i]) || 900; break;
      case '--speed': opts.speed = Number(argv[++i]) === 2 ? 2 : 1; break;
      case '--max-kb': opts.maxKb = Number(argv[++i]) || 2048; break;
      default:
        if (a.startsWith('-')) throw new Error(`未知参数: ${a}`);
        positional.push(a);
    }
  }
  if (positional.length) gameId = sanitizeGameId(positional[0]!);
  return { all, gameId, out, opts };
}

export interface ExportResult { gameId: string; outputs: string[]; cover?: string; frames: number; elapsedMs: number }

export function exportGame(logPath: string, outDir: string, opts: GifOpts): ExportResult {
  const begun = Date.now();
  const events = readGameEvents(logPath);
  const frames = buildFrames(events, { speed: opts.speed });
  const gameId = sanitizeGameId(logPath);
  mkdirSync(outDir, { recursive: true });
  const boardSize = opts.width;
  const maxBytes = opts.maxKb * 1024;
  const shards = shardFrames(frames, boardSize, maxBytes);
  const marked = withContinueMarkers(shards);
  const outputs: string[] = [];
  const total = shards.length;
  marked.forEach((seg, i) => {
    const buf = encodeGifBytes(seg, boardSize);
    const name = total === 1 ? `${gameId}.gif` : `${gameId}.part${i + 1}.gif`;
    writeFileSync(`${outDir}/${name}.tmp`, buf);
    renameSync(`${outDir}/${name}.tmp`, `${outDir}/${name}`);
    outputs.push(`${outDir}/${name}`);
  });
  let cover: string | undefined;
  if (frames.length) {
    const png = coverPngBuffer([frames[0]!], boardSize);
    writeFileSync(`${outDir}/${gameId}_cover.png.tmp`, png);
    renameSync(`${outDir}/${gameId}_cover.png.tmp`, `${outDir}/${gameId}_cover.png`);
    cover = `${outDir}/${gameId}_cover.png`;
  }
  return { gameId, outputs, cover, frames: frames.length, elapsedMs: Date.now() - begun };
}