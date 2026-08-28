//
// 调试日志(debug_logs/)—— 每局 × 每个大模型的「完整交互日志」。
//
// 定位:logs/ 记录「裁决后的公共事实」(回合/打回/终局,唯一真相源);调试日志记录
// 发生在 LLM IPC 边界的**原始交互**(完整请求体 + 完整响应文本,含思考),供事后分析
// 模型行为 / 端点差异。文件名 `<gameId>_<模型名>.jsonl`(复盘为 `<gameId>_review_<模型名>.jsonl`),
// 落在与 logs/ 平级的 debug_logs/ 目录。
//
// 约定:
// - 纯旁路下游:只写不读;绝不写事件日志、绝不参与实时/回放/成本/胜负判定;
// - 密钥红线:HTTP HEADER 从不记录;一切 entry 写盘前过 `sanitizeForLog`(防异常端点回显密钥);
// - 完整原文:请求体 JSON 全量;响应记 rawText —— 可 parse 的 JSON 净化后存对象,否则原样
//   (SSE 流式全文含思考);sink 惰性建目录,appendFileSync 保证 write 返回即持久;
// - ENOENT(目录被外部删除/测试清理时序)重建一次,同 fileLogSink 的容错语义。
//

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sanitizeForLog } from './game-log';

/** 调试日志写口:接受任意 record 形态的行(便于测试注入内存收集器)。 */
export interface DebugLogSink {
  write(entry: Record<string, unknown>): void;
}

/** 便捷开写:自动建目录(懒 mkdir 于首次写前),追加模式,JSON 一串一元。 */
export function debugFileSink(filePath: string): DebugLogSink {
  const dir = dirname(filePath);
  const writeLine = (line: string) => appendFileSync(filePath, line, 'utf8');
  mkdirSync(dir, { recursive: true });
  return {
    write(entry: Record<string, unknown>) {
      const line = `${JSON.stringify(sanitizeForLog(entry))}\n`;
      try {
        writeLine(line);
      } catch (err) {
        if ((err as { code?: string })?.code === 'ENOENT') {
          try {
            mkdirSync(dir, { recursive: true });
            writeLine(line);
            return;
          } catch {
            /* 重建仍失败则抛原始错误 */
          }
        }
        throw err;
      }
    },
  };
}

/**
 * 携带常量元数据的调试 sink:闭包把每局/每方/每模型的固定字段注入每条 entry
 * (调用点无需重复传 gameId/side/model/label)。entry 中的同名字段覆盖元数据。
 */
export function metaDebugSink(
  filePath: string,
  meta: Record<string, string>,
): DebugLogSink {
  const inner = debugFileSink(filePath);
  return {
    write(entry: Record<string, unknown>) {
      inner.write({ ...meta, ...entry });
    },
  };
}

/** 与 `logDir` 平级的调试日志目录:`dirname(logDir)/debug_logs`(测试注入临时 logDir 时自动随迁)。 */
export function defaultDebugLogDir(logDir: string): string {
  return join(dirname(logDir), 'debug_logs');
}

/**
 * 响应原始文本 → 落盘形态:可 parse 的 JSON 净化后存对象(结构完整、键级脱敏),
 * 否则(SSE 事件流 / 纯文本错误)原样字符串返回。
 */
export function rawBodyForDebug(text: string): unknown {
  if (text.trim() === '') return text;
  try {
    return sanitizeForLog(JSON.parse(text));
  } catch {
    return text;
  }
}