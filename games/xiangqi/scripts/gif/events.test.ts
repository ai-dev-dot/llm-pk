import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLogText, readGameEvents } from './events';

const line = (e: unknown) => JSON.stringify(e);
const begin = { type: 'begin', first: 'red', red: { model: 'm' }, black: { model: 'm' } };

describe('events.parseLogText', () => {
  it('正常多事件解析为数组', () => {
    const r = parseLogText(`${line(begin)}\n${line({ type: 'move', turn: 'red', move: { from: 'h3', to: 'e3' }, legal: true })}\n`);
    expect(r.events.length).toBe(2);
    expect(r.events[1]!.type).toBe('move');
    expect(r.loosened).toBe(0);
  });

  it('最后一行半写(无换行结尾且解析失败)被剥离', () => {
    const text = `${line(begin)}\n` + '{"type":"move","tu';
    const r = parseLogText(text);
    expect(r.events.length).toBe(1);
    expect(r.loosened).toBe(1);
    expect(r.bad).toHaveLength(0);
  });

  it('中间坏行列入 bad 并保留行号', () => {
    const text = `${line(begin)}\n{ broken }\n${line({ type: 'check', side: 'black' })}\n`;
    const r = parseLogText(text);
    expect(r.bad).toHaveLength(1);
    expect(r.bad[0]!.line).toBe(2);
    expect(r.events.length).toBe(2); // 坏行跳过,其余照收
  });
});

describe('events.readGameEvents', () => {
  it('文件缺失抛带说明的错', () => {
    expect(() => readGameEvents('/definitely/not/here.jsonl')).toThrow();
  });

  it('中间坏行直接抛“文件:行号”', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xq-ev-'));
    const p = join(dir, 'g.jsonl');
    writeFileSync(p, `${line(begin)}\nnot-json\n`);
    try { expect(() => readGameEvents(p)).toThrow(/g\.jsonl:2/); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
});