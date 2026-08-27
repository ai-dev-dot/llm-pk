//
// 日志行解析(动图导出专用,与 server/game-log.readAllEvents 不同):
//  - 坏行须带「文件:行号」(server 版只抛裸 SyntaxError,産品线欠缺行号);
//  - 容忍进行中 arena 追加写造成的「最后一行半写」(spec §4/§9,不误报损坏)。
//
import { readFileSync } from 'node:fs';
import type { GameEvent } from '../../server/game-log';

export interface BadLine { line: number; text: string; error: string }

export interface LogParseResult {
  events: GameEvent[];
  loosened: number;
  bad: BadLine[];
}

export function parseLogText(text: string): LogParseResult {
  const events: GameEvent[] = [];
  const bad: BadLine[] = [];
  let loosened = 0;
  const raw = text.split(/\r?\n/);
  const hardEnded = /(\r?\n)$/.test(text); // 以换行结尾 = 文件未在半行截断
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i]!.trim();
    if (t === '') continue;
    const isLast = i === raw.length - 1;
    try {
      events.push(JSON.parse(t) as GameEvent);
    } catch (err) {
      if (isLast && !hardEnded) {
        // 最后一行非换行结尾且解析失败 → 进行中半写,剥离
        loosened++;
        continue;
      }
      bad.push({ line: i + 1, text: t.slice(0, 160), error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { events, loosened, bad };
}

export function readGameEvents(filePath: string): GameEvent[] {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    throw new Error(`找不到对局日志: ${filePath}(请先确认该局已落盘)`);
  }
  const { events, bad } = parseLogText(text);
  if (bad.length > 0) {
    const b = bad[0]!;
    throw new Error(`${filePath}:${b.line} 非法 JSON 行: ${b.error} ← ${b.text}`);
  }
  return events;
}