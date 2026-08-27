//
// 对局 id 命名(T19 归档友好命名)。
//
// 约定:对外 id = 磁盘日志文件名 basename(去掉 `.jsonl`),形如
//   `20260827-GLM-5-3-Flash-pk-deepseek-v4-flash-01`
//   · `YYYYMMDD` —— 本地时区开局日期;
//   · 红方 label、`pk` 分隔、黑方 label —— label 优先 profile 名(`use`),回落模型名;
//   · `NN`      —— 当日该对阵的第 N 局(01 起,补零两位)。
// 使日志文件名自带日期/对阵/序号 ⇔ 归档排序、扫 `logs/` 目录即可枚举对局(对局列表/统计)。
// 全部为纯函数/可注入,便于测试;`seq` 递增由调用方用 `readdirSync(logDir)` + 进程内 `inFlight` 防撞。
//

/** 本地时区 `YYYYMMDD`(归档文件名前缀)。 */
export function yyyymmdd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/**
 * 把模型名/profile 名清洗为文件名安全 slug:
 * - 非字母数字(含中文、`.`、`_`、空格、`/` 等)一律折叠为单个 `-`;
 * - 首尾 `-` 剪掉,长度封顶 24 —— 保证跨平台合法且深链 URL 无需 encode;
 * - 空结果回落 `na`。
 */
export function slugifySideLabel(label: string): string {
  const s = label.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 24).replace(/-+$/, '') || 'na';
}

/** 同日同对阵的 id 前缀(`pk` 为字面分隔):`<date>-<red>-pk-<black>`。 */
export function sameDayBase(date: string, redSlug: string, blackSlug: string): string {
  return `${date}-${redSlug}-pk-${blackSlug}`;
}

export interface GameIdChoice {
  seq: number;
  id: string;
}

/**
 * 取「当日该对阵」下一个序号(id):
 * - `existing` —— 磁盘 `logs/`(或其他)已有文件名列表,解析形如 `<base>-NN.jsonl` 的同前缀最大序号;
 * - `inFlight` —— 本进程已签发记录(同前缀防并发撞号),key 由调用方自定(建议含日志目录)。
 * 纯函数:`existing`/`inFlight` 由调用方注入,便于测试与并发收敛。
 */
export function pickNextSeq(
  existing: readonly string[],
  date: string,
  redSlug: string,
  blackSlug: string,
  inFlight: Map<string, number>,
): GameIdChoice {
  const base = sameDayBase(date, redSlug, blackSlug);
  const seen: number[] = [];
  for (const name of existing) {
    if (!name.startsWith(`${base}-`) || !name.endsWith('.jsonl')) continue;
    const numStr = name.slice(base.length + 1, name.length - '.jsonl'.length);
    if (numStr.length >= 2 && /^\d+$/.test(numStr)) seen.push(Number(numStr));
  }
  const next = Math.max(0, ...seen, inFlight.get(base) ?? 0) + 1;
  inFlight.set(base, next);
  return { seq: next, id: `${base}-${String(next).padStart(2, '0')}` };
}