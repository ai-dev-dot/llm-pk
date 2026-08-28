//
// debug-log.ts 测试:调试 sink 语义与目录推导(严格 TDD)。
//
// 覆盖:
// - debugFileSink:懒建目录,JSON 一串一元、逐行 append,entry 写盘前自动 sanitize(密钥隔离);
// - metaDebugSink:闭包注入 gameId/side/model/label 常量,动态 entry 键覆盖元数据;
// - defaultDebugLogDir:与 logDir 平级(父目录/debug_logs);
// - ENOENT 容错:目录被删后再写自动重建;
// - rawBodyForDebug:JSON → 净化对象;SSE/纯文本 → 原样字符串。
//

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultDebugLogDir, debugFileSink, metaDebugSink, rawBodyForDebug } from './debug-log';
import { sanitizeForLog } from './game-log';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'debug-log-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function readLines(file: string): Array<Record<string, unknown>> {
  const text = readFileSync(file, 'utf8');
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('debugFileSink', () => {
  it('写 JSONL:懒建目录、appendonly、一行一 JSON', async () => {
    const file = join(dir, 'sub', 'x.jsonl');
    const sink = debugFileSink(file);
    sink.write({ a: 1 });
    sink.write({ b: '2' });

    expect(readLines(file)).toEqual([{ a: 1 }, { b: '2' }]);
  });

  it('entry 写盘前自动 sanitize(黑名单键剔除,密钥隔离红线)', async () => {
    const sink = debugFileSink(join(dir, 'x.jsonl'));
    sink.write({
      kind: 'req',
      apiKey: 'sk-leak',
      body: { messages: [{ content: 'hi' }], Authorization: 'Bearer leak' },
      safe: 'ok',
    });

    const [line] = readLines(join(dir, 'x.jsonl'));
    expect(line?.['apiKey']).toBeUndefined();
    expect((line?.['body'] as Record<string, unknown>)?.['Authorization']).toBeUndefined();
    expect(line?.['safe']).toBe('ok');
  });

  it('目录被删除后再次写自动重建(ENOENT 容错,写不抛且落盘)', async () => {
    const sub = join(dir, 'gone');
    const file = join(sub, 'x.jsonl');
    const sink = debugFileSink(file);
    sink.write({ a: 1 });
    rmSync(sub, { recursive: true, force: true }); // 外部删除子目录与文件(连同旧记录)

    sink.write({ b: 2 }); // 不抛错;目录重建、文件重建
    expect(readLines(file)).toEqual([{ b: 2 }]);
  });
});

describe('metaDebugSink', () => {
  it('闭包常量注入每条 entry;同名动态键覆盖元数据', async () => {
    const file = join(dir, 'x.jsonl');
    const sink = metaDebugSink(file, { gameId: 'g-1', side: 'red', model: 'm-1', label: 'L' });
    sink.write({ kind: 'player-request', url: '/v1/messages' });
    sink.write({ kind: 'player-response', side: 'black', status: 200 }); // side 覆盖元数据

    const lines = readLines(file);
    expect(lines[0]).toMatchObject({
      gameId: 'g-1',
      side: 'red',
      model: 'm-1',
      label: 'L',
      kind: 'player-request',
      url: '/v1/messages',
    });
    expect(lines[1]?.['side']).toBe('black');
    expect(lines[1]?.['model']).toBe('m-1'); // 未覆盖键仍保留
  });
});

describe('defaultDebugLogDir', () => {
  it('与 logDir 平级:dirname(logDir)/debug_logs(跨平台 join)', () => {
    expect(defaultDebugLogDir('/a/b/logs')).toBe(join('/a/b', 'debug_logs'));
    expect(defaultDebugLogDir('D:/proj/games/xiangqi/logs')).toBe(join('D:/proj/games/xiangqi', 'debug_logs'));
  });
});

describe('rawBodyForDebug', () => {
  it('可 parse 的 JSON:净化后存对象(结构完整、键级脱敏)', () => {
    const out = rawBodyForDebug('{"content":[{"type":"text","text":"ok"}],"api_key":"secret"}') as Record<string, unknown>;
    expect(out['api_key']).toBeUndefined(); // 黑名单键剔除
    expect(out['content']).toEqual([{ type: 'text', text: 'ok' }]);
    // 与手工 sanitizeForLog 结果一致
    expect(out).toEqual(sanitizeForLog({ content: [{ type: 'text', text: 'ok' }], api_key: 'secret' }));
  });

  it('SSE 事件流 / 纯文本:原样字符串返回(含思考全文)', () => {
    const raw = 'event: message\ndata: {"type":"content_block_delta"}\n\n';
    expect(rawBodyForDebug(raw)).toBe(raw);
    expect(rawBodyForDebug('')).toBe('');
  });
});

describe('目录落点', () => {
  it('默认目录推导是纯函数;sink 首次写才 mkdir debug_logs', () => {
    const fakeLogDir = join(dir, 'logs');
    expect(() => readFileSync(join(dir, 'debug_logs'), 'utf8')).toThrow(); // 纯推导不建目录

    const sinkFile = join(defaultDebugLogDir(fakeLogDir), 'x.jsonl');
    debugFileSink(sinkFile).write({ a: 1 });
    expect(readFileSync(sinkFile, 'utf8')).toContain('"a":1'); // 首次写自动 mkdir
  });
});