//
// 观战动图导出 CLI 主入口(Task 8,替换 Task 1 占位):
//  args → parseArgs → 字体验证(缺字体/字形 exit 2)→ 单局或 --all 批量 → 摘要/失败汇总/exit codes。
//  上游:scripts/gif/{events,frames,fonts,render,encode,cli} 全部已就绪。
//
import { createCanvas } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync } from 'node:fs';
import { parseArgs, exportGame, resolveLogsDir, type GifOpts } from './gif/cli';
import { resolveFontPath, registerFont, assertGlyphs, FAMILY } from './gif/fonts';

function verifyFont(opts: GifOpts): void {
  const path = resolveFontPath(opts.explicitFont);
  if (!path) {
    console.error('动图导出需要中文字体:请用 --font 指定 ttf/otf,或确认 Windows 系统字体(simkai/simhei)存在。');
    process.exit(2);
  }
  registerFont(path);
  const probe = createCanvas(8, 8).getContext('2d');
  probe.font = `24px ${FAMILY}`;
  const missing = assertGlyphs(probe);
  if (missing.length) {
    console.error(`字体缺字形: ${missing.join('')}(请更换含传统字形的字体)`);
    process.exit(2);
  }
}

function main(): void {
  const root = dirname(dirname(fileURLToPath(import.meta.url))); // games/xiangqi
  const args = process.argv.slice(2);
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(args);
  } catch (e) {
    console.error(String(e));
    process.exit(1);
  }
  const { all, gameId, out, opts } = parsed;
  verifyFont(opts);
  const logsDir = resolveLogsDir(root);
  const outDir = out ?? join(root, 'files', '');
  const targets: string[] = all
    ? readdirSync(logsDir).filter((f) => f.endsWith('.jsonl'))
    : gameId
      ? [`${gameId}.jsonl`]
      : [];
  if (!targets.length) {
    console.error('未指定对局:传 <gameId> 或 --all');
    process.exit(1);
  }
  const failures: string[] = [];
  for (const rel of targets) {
    const logPath = join(logsDir, rel);
    try {
      const r = exportGame(logPath, outDir, opts);
      console.log(`${r.gameId}: ${r.outputs.join(', ')}${r.cover ? ` + ${r.cover}` : ''} | ${r.frames} 帧 | ${r.elapsedMs}ms`);
    } catch (e) {
      failures.push(`${rel.split('/').pop()}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (failures.length) {
    console.error(`失败 ${failures.length} 局:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main();