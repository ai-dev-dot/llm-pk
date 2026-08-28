//
// 磁盘对局历史扫描(T19 归档命名配套):对局列表/统计的数据底座。
// 每个 `logs/*.jsonl` 解析出:begin(红黑 model)、move 计数、finish(胜负/原因)、起止时间。
// - 纯读、容错:坏行跳过、无 begin 的残档(进程被杀遗留)忽略;
// - `status` 初始判定:有 finish → 'finished',否则 'running'(内存活跃局的实时状态由 http.ts 覆盖);
// - 返回按 `updatedAt` 倒序(最新在前)。
//

import { basename, dirname, join } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import type { GameEvent } from './game-log';

export interface ArchivedGame {
  /** 文件名 basename(不含 .jsonl)——即 T19 友好 id,可直接深链观战/回放。 */
  id: string;
  red: { model: string };
  black: { model: string };
  status: 'running' | 'paused' | 'finished';
  /** 合法走子半回合数(以 move 事件计数;不含打回). */
  moveCount: number;
  winner?: 'red' | 'black' | 'draw';
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

/** 逐行安全解析:坏行跳过,保留其 ts 的最晚值。返回按键是否存在(无 begin 视为无效档)。 */
interface Parsed {
  begin?: GameEvent;
  finish?: GameEvent;
  moveCount: number;
  lastTs: string;
}

function parseLines(text: string): Parsed | undefined {
  const parsed: Parsed = { moveCount: 0, lastTs: '' };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev: GameEvent;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // 容错坏行(文件可能被外部截断)
    }
    if (typeof ev?.type !== 'string') continue;
    if (typeof ev.ts === 'string') parsed.lastTs = ev.ts;
    if (ev.type === 'begin') parsed.begin = ev;
    else if (ev.type === 'move') parsed.moveCount += 1;
    else if (ev.type === 'finish') parsed.finish = ev;
  }
  return parsed.begin ? parsed : undefined;
}

export function scanLogs(logDir: string): ArchivedGame[] {
  let names: string[];
  try {
    names = readdirSync(logDir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out: ArchivedGame[] = [];
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(join(logDir, name), 'utf8');
    } catch {
      continue; // 读取失败(被删/权限/瞬时)→ 跳过
    }
    const p = parseLines(text);
    if (!p) continue;
    // 类型收窄:begin/finish 字段只在对应 type 赋入,这里显式守卫拿到具体事件子类型。
    const be = p.begin?.type === 'begin' ? p.begin : undefined;
    const fin = p.finish?.type === 'finish' ? p.finish : undefined;
    out.push({
      id: basename(name, '.jsonl'),
      red: { model: be?.red.model ?? '' },
      black: { model: be?.black.model ?? '' },
      status: fin ? 'finished' : 'running',
      moveCount: p.moveCount,
      winner: fin ? (fin.winner === 'draw' ? 'draw' : fin.winner) : undefined,
      reason: fin ? fin.reason : undefined,
      createdAt: be?.ts ?? p.lastTs,
      updatedAt: p.lastTs || be?.ts || '',
    });
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return out;
}
/**
 * 终局存档:对局 log 复制到 `archive/`(随 git 入库),双方 debug log 复制到 `archive_debug/`(gitignore,不入库)。
 * - 目标目录:均为 `dirname(logDir)` 下的平级目录(与 debug_logs 同级);
 * - 只复制存在的文件(主 log 必在;debug log 可能因未触网/模型同侧缺文件);
 * - 同名覆盖(同 id 重新存档以本次为准);返回按目录分组的文件名列表(basename)。
 */
export interface ArchiveResult {
  /** 对局事件 log 文件名列表(archive/,随 git 入库)。 */
  logFiles: string[];
  /** 双方 debug log 文件名列表(archive_debug/,gitignore 不入库)。 */
  debugFiles: string[];
}

export function archiveGameFiles(logDir: string, debugLogDir: string, id: string): ArchiveResult {
  const archiveDir = join(dirname(logDir), 'archive');
  const debugArchiveDir = join(dirname(logDir), 'archive_debug');
  mkdirSync(archiveDir, { recursive: true });
  mkdirSync(debugArchiveDir, { recursive: true });
  const out: ArchiveResult = { logFiles: [], debugFiles: [] };
  const copy = (from: string, to: string): void => {
    copyFileSync(from, to);
  };
  const main = join(logDir, `${id}.jsonl`);
  if (existsSync(main)) {
    copy(main, join(archiveDir, `${id}.jsonl`));
    out.logFiles.push(basename(main));
  }
  let debugNames: string[] = [];
  try {
    debugNames = readdirSync(debugLogDir).filter((n) => n.startsWith(`${id}_`) && n.endsWith('.jsonl'));
  } catch {
    /* debug 目录不存在/为空 → 跳过 */
  }
  for (const name of debugNames) {
    copy(join(debugLogDir, name), join(debugArchiveDir, name));
    out.debugFiles.push(name);
  }
  return out;
}
