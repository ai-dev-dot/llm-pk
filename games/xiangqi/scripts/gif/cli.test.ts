// scripts/gif/cli.test.ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, sanitizeGameId, exportGame } from './cli';
import { resolveFontPath, registerFont } from './fonts';

const font = resolveFontPath();
if (font) registerFont(font);
const hasFont = font !== null;

describe('cli.parseArgs', () => {
  it('单局 + 可选参数', () => {
    const r = parseArgs(['g-1', '--width', '720', '--speed', '2', '--max-kb', '100']);
    expect(r).toMatchObject({ all: false, gameId: 'g-1', opts: { width: 720, speed: 2, maxKb: 100 } });
  });
  it('--all 无位置参数', () => {
    const r = parseArgs(['--all']);
    expect(r.all).toBe(true);
  });
  it('--width 非三档(999)→ 显式报错(与未知参数同 exit 1 口径)', () => {
    expect(() => parseArgs(['g-1', '--width', '999'])).toThrow(/非法 --width/);
    expect(() => parseArgs(['g-1', '--width', 'abc'])).toThrow(/非法 --width/);
  });
});

describe('cli.sanitizeGameId', () => {
  it('路径穿越被净化 / 非法 id 拒绝', () => {
    expect(sanitizeGameId('..\\..\\evil')).toBe('evil');
    expect(() => sanitizeGameId('..')).toThrow();
    expect(() => sanitizeGameId('')).toThrow();
  });
});

describe('cli.exportGame', () => {
  // 长时间渲染(720×860 canvas 多次编码)超过 vitest 默认 5s 超时,显式放宽以让断言真实成立。
  it.skipIf(!hasFont)('单局产出 gif(+分片)+封面;字节与签名合规', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xq-cli-'));
    const logPath = join(dir, 'seed.jsonl');
    const lines = [
      JSON.stringify({ type: 'begin', first: 'red', red: { model: 'R' }, black: { model: 'B' } }),
      JSON.stringify({ type: 'move', turn: 'red', move: { from: 'h3', to: 'e3' }, legal: true }),
      JSON.stringify({ type: 'move', turn: 'black', move: { from: 'h8', to: 'e8' }, legal: true }),
      JSON.stringify({ type: 'finish', winner: 'red', reason: 'checkmate', ruleViolations: { red: { pre: 0, post: 0 }, black: { pre: 0, post: 0 } } }),
    ].join('\n') + '\n';
    writeFileSync(logPath, lines);
    const out = join(dir, 'out');
    const res = exportGame(logPath, out, { width: 720, speed: 1, maxKb: 2048 });
    const got = res.outputs[0]!;
    expect(existsSync(got)).toBe(true);
    const gif = readFileSync(got);
    expect(Array.from(gif.subarray(0, 6)).join(',')).toBe('71,73,70,56,57,97');
    expect(res.frames).toBe(1 + 6 * 2 + 1);
    if (res.cover) expect(existsSync(res.cover)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it.skipIf(!hasFont)('极小预算触发分片 + 未完·续', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xq-cli-s-'));
    const logPath = join(dir, 's.jsonl');
    const moves: string[] = [];
    for (let i = 0; i < 5; i++) {
      moves.push(JSON.stringify({ type: 'move', turn: i % 2 ? 'black' : 'red', move: { from: 'h3', to: 'e3' }, legal: true }));
    }
    writeFileSync(logPath, [JSON.stringify({ type: 'begin', first: 'red', red: { model: 'R' }, black: { model: 'B' } }), ...moves].join('\n') + '\n');
    const out = join(dir, 'out');
    const res = exportGame(logPath, out, { width: 720, speed: 1, maxKb: 1 });
    expect(res.outputs.length).toBeGreaterThan(1);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it('中途写盘失败清理:已 rename 的 final 撤销、.tmp 不留(输出目录为空)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xq-cli-clean-'));
    const gameId = 'midfail';
    const logPath = join(dir, `${gameId}.jsonl`);
    const moves: string[] = [];
    for (let i = 0; i < 5; i++) {
      moves.push(JSON.stringify({ type: 'move', turn: i % 2 ? 'black' : 'red', move: { from: 'h3', to: 'e3' }, legal: true }));
    }
    writeFileSync(logPath, [JSON.stringify({ type: 'begin', first: 'red', red: { model: 'R' }, black: { model: 'B' } }), ...moves].join('\n') + '\n');
    const out = join(dir, 'out');
    // 纯文件系统注入(不 mock):极小预算必定 ≥2 片;把第 2 片 .tmp 路径预建为**目录**,
    // writeFileSync 向目录写必抛 EISDIR → part1 已 rename 的 final 必须在 catch 中被清掉。
    mkdirSync(out, { recursive: true });
    const scaffold = join(out, `${gameId}.part2.gif.tmp`);
    mkdirSync(scaffold, { recursive: true });
    try {
      expect(() => exportGame(logPath, out, { width: 720, speed: 1, maxKb: 1 })).toThrow();
      const files = readdirSync(out, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
      expect(files).toEqual([]); // 无 .tmp 文件、无已 rename 的最终产物残留
      rmSync(scaffold, { recursive: true, force: true }); // 摘除注入脚手架后输出目录应为空
      expect(readdirSync(out)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});