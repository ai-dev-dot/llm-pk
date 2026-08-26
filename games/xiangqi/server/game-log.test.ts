import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendEvent,
  openGameLog,
  readAllEvents,
  sanitizeForLog,
  type FinishEvent,
  type GameEvent,
  type GameEventInput,
  type MoveEvent,
} from './game-log';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'game-log-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/* ---------- 夹具(不含 seq/ts,由 appendEvent 自增) ---------- */

const begin = (): GameEventInput => ({
  type: 'begin',
  gameId: 'g1',
  red: { model: 'claude-sonnet-4-5' },
  black: { model: 'claude-sonnet-4-5' },
});

const move = (): GameEventInput => ({
  type: 'move',
  turn: 'red',
  move: { from: 'h3', to: 'e3', notation: '炮二平五' },
  analysis: '先手架中炮,意在直取中路……',
  elapsedMs: 2314,
  usage: { promptTokens: 1840, completionTokens: 212, costUsd: 0.0031 },
  legal: true,
});

const illegal = (): GameEventInput => ({
  type: 'illegal-attempt',
  side: 'red',
  round: 1,
  reason: '马被蹩腿',
  violations: { pre: 1, post: 0 },
  attempt: { text: '马八进七' },
});

const finish = (): GameEventInput => ({
  type: 'finish',
  winner: 'red',
  reason: 'checkmate',
  ruleViolations: { red: { pre: 2, post: 1 }, black: { pre: 0, post: 0 } },
});

/** 顺序写入若干事件到 <dir>/<name>.jsonl,等待 flush 落盘。 */
async function writeAll(evts: GameEventInput[], name = 'g.jsonl'): Promise<string> {
  const file = join(dir, name);
  const sink = createWriteStream(file, { flags: 'a' });
  for (const e of evts) appendEvent(sink, e);
  sink.end();
  await finished(sink);
  return file;
}

/* ---------- sanitizeForLog:密钥隔离 hook ---------- */

describe('sanitizeForLog 密钥隔离 hook', () => {
  it('剔除顶层 api_key / API_KEY / X-Api-Key,序列化不含敏感字样', () => {
    const input = {
      type: 'move',
      api_key: 'sk-secret-abc',
      config: { API_KEY: 'sk-secret-abc' },
      headers: { 'X-Api-Key': 'sk-secret-abc' },
      legal: true,
    };
    const out = sanitizeForLog(input);
    const json = JSON.stringify(out);
    expect(json).not.toContain('api_key');
    expect(json).not.toContain('sk-secret-abc');
  });

  it('递归剔除嵌套 config.base_url / headers.authorization / apiKey', () => {
    const input = {
      type: 'move',
      turn: 'red',
      config: { base_url: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
      headers: { authorization: 'Bearer sk-secret-abc' },
      meta: { apiKey: 'sk-secret-abc' },
    };
    const out = sanitizeForLog(input);
    const json = JSON.stringify(out);
    expect(json).not.toContain('base_url');
    expect(json).not.toContain('authorization');
    expect(json).not.toContain('apiKey');
    expect(json).not.toContain('sk-secret-abc');
    // 非敏感字段保留
    expect(out).toMatchObject({ type: 'move', turn: 'red' });
    expect(JSON.stringify(out)).toContain('claude-sonnet-4-5');
  });

  it('返回新对象,不改动入参(污点对象保留原样)', () => {
    const original = { type: 'move', config: { api_key: 'sk-x' } };
    const out = sanitizeForLog(original);
    expect((out as { config: { api_key: string } }).config.api_key).toBeUndefined();
    expect((original as { config: { api_key: string } }).config.api_key).toBe('sk-x');
  });

  it('数组内部的敏感键同样被剔除', () => {
    const out = sanitizeForLog([{ api_key: 'a' }, { keep: 1, apikey: 'b' }]);
    expect(out).toEqual([{}, { keep: 1 }]);
  });

  it('无敏感键时原样保留(含 null/基本类型)', () => {
    const keep = { type: 'review', summary: '红方中局抓住机会', keyPoints: ['中炮', '兑子'], score: null };
    expect(sanitizeForLog(keep)).toEqual(keep);
    expect(sanitizeForLog(3)).toBe(3);
    expect(sanitizeForLog(null)).toBeNull();
  });
});

/* ---------- appendEvent:seq/ts 自增与写入 ---------- */

describe('appendEvent 序号、时间戳与逐行写入', () => {
  it('seq 从 1 单调自增,ts 为合法 ISO;返回写出的完整记录', async () => {
    const file = join(dir, 'seq.jsonl');
    const sink = createWriteStream(file, { flags: 'a' });
    const r1 = appendEvent(sink, move());
    const r2 = appendEvent(sink, finish());
    const r3 = appendEvent(sink, begin());
    sink.end();
    await finished(sink);

    expect([r1.seq, r2.seq, r3.seq]).toEqual([1, 2, 3]);
    for (const r of [r1, r2, r3]) {
      expect(typeof r.ts).toBe('string');
      expect(Number.isNaN(Date.parse(r.ts))).toBe(false);
      expect(r.ts).toContain('T');
    }
    expect(readAllEvents(file).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('每个 sink 独立计数(两局各从 1 起)', async () => {
    const f1 = join(dir, 'a.jsonl');
    const f2 = join(dir, 'b.jsonl');
    const s1 = createWriteStream(f1, { flags: 'a' });
    const s2 = createWriteStream(f2, { flags: 'a' });
    appendEvent(s1, begin());
    appendEvent(s2, begin());
    appendEvent(s1, move());
    s1.end();
    s2.end();
    await Promise.all([finished(s1), finished(s2)]);

    expect(readAllEvents(f1).map((e) => e.seq)).toEqual([1, 2]);
    expect(readAllEvents(f2).map((e) => e.seq)).toEqual([1]);
  });

  it('每事件恰好一行 JSON,round-trip 4 事件顺序一致', async () => {
    const file = await writeAll([begin(), move(), illegal(), finish()]);
    const raw = await readFile(file, 'utf8');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(4);

    const events = readAllEvents(file);
    expect(events.map((e) => e.type)).toEqual(['begin', 'move', 'illegal-attempt', 'finish']);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('move 事件保留 usage 与嵌套 move.notation;finish 携带 ruleViolations', async () => {
    const file = await writeAll([begin(), move(), illegal(), finish()]);
    const events = readAllEvents(file);
    const mv = events[1] as MoveEvent;
    expect(mv.usage).toEqual({ promptTokens: 1840, completionTokens: 212, costUsd: 0.0031 });
    expect(mv.move.notation).toBe('炮二平五');
    expect(mv.turn).toBe('red');

    const att = events[2];
    expect(att.type).toBe('illegal-attempt');
    if (att.type !== 'illegal-attempt') throw new Error('bad event');
    expect(att.round).toBe(1);
    expect(att.violations).toEqual({ pre: 1, post: 0 });

    const fin = events[3] as FinishEvent;
    expect(fin.winner).toBe('red');
    expect(fin.reason).toBe('checkmate');
    expect(fin.ruleViolations).toEqual({ red: { pre: 2, post: 1 }, black: { pre: 0, post: 0 } });
  });

  it('密钥隔离 hook:写盘前 sanitize,日志全文不含 api_key 与 secret', async () => {
    const secretHolding = {
      type: 'move',
      turn: 'red',
      move: { from: 'h3', to: 'e3', notation: '炮二平五' },
      legal: true,
      config: { api_key: 'sk-secret-abc', base_url: 'https://api.anthropic.com' },
      headers: { authorization: 'Bearer sk-secret-abc' },
    } as unknown as GameEventInput;

    const file = await writeAll([secretHolding, finish()]);
    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain('api_key');
    expect(raw).not.toContain('base_url');
    expect(raw).not.toContain('authorization');
    expect(raw).not.toContain('sk-secret-abc');
    expect(raw).not.toContain('Bearer');
    // 事件仍按序落盘
    expect(readAllEvents(file).map((e) => e.type)).toEqual(['move', 'finish']);
  });
});

/* ---------- readAllEvents 健壮性 ---------- */

describe('readAllEvents 读回', () => {
  it('空文件 → []', async () => {
    const file = join(dir, 'empty.jsonl');
    await writeFile(file, '');
    expect(readAllEvents(file)).toEqual([]);
  });

  it('容忍尾空行与中间空行', async () => {
    const file = join(dir, 'blank.jsonl');
    const line = JSON.stringify({ ...begin(), seq: 1, ts: '2026-08-26T00:00:00.000Z' });
    await writeFile(file, `\n${line}\n\n`);
    const events = readAllEvents(file);
    expect(events).toHaveLength(1);
    expect(events[0].seq).toBe(1);
  });
});

/* ---------- openGameLog 便利打开 ---------- */

describe('openGameLog 自动建目录与追加写', () => {
  it('目录不存在时递归创建,返回可写流', async () => {
    const file = join(dir, 'nested', 'logs', 'g.jsonl');
    const sink = await openGameLog(file);
    appendEvent(sink, begin());
    appendEvent(sink, move());
    sink.end();
    await finished(sink);

    const events = readAllEvents(file);
    expect(events.map((e) => e.type)).toEqual(['begin', 'move']);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
  });
});