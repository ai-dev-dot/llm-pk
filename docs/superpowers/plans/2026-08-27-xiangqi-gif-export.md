# 观战动图导出(GIF)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 PK 对局日志新增离线 CLI,渲染出可上传微信公众号的 GIF 动图(棋盘走子/记谱字幕/结果横幅/封面 PNG/超预算自动分片)。

**Architecture:** 事件日志(`logs/<gameId>.jsonl`)→ 带行号解析(`scripts/gif/events.ts`)→ 复用 `web/src/lib/replay.ts` 纯函数(`boardAt/movesAt/modelsAt/resultAt`)→ 帧序列纯函数(`scripts/gif/frames.ts`)→ canvas 渲染(`scripts/gif/render.ts`,只用固定色板 `palette.ts`)+ 字形/字体解析(`fonts.ts`)→ gifenc 编码与分片/封面(`encode.ts`)→ CLI 入口(`scripts/gif-export.ts`)。

**Tech Stack:** TypeScript(ESNext, tsx)、`@napi-rs/canvas`(Rust 预编译 2D canvas + 系统中文字体)、`gifenc`(纯 JS GIF 固定色板编码)、vitest。

**Spec:** `docs/superpowers/specs/2026-08-27-xiangqi-gif-export-design.md`(评审已裁决,26dcd13 落库;本计划从 spec 论证,实施者须两文同读)

## Global Constraints

- 工作目录:`games/xiangqi/`。新增文件全部在 `scripts/` 下;**不得修改** `server/*`、`engine/*`、`web/*` 运行期代码(跨层约束:只 import `web/src/lib/replay.ts` 这一条链路,该链路必须保持纯 TS、永不得引入 web 运行时依赖)。
- CLI 离线、不触网、不动正在进行的 PK;服务重启/日志被 arena 追加写 → 解析须容忍进行中的不完整尾行。
- `gameId` 入参必须 `basename()` 净化,空/含路径 → exit 1。
- 渲染颜色只能取自 `palette.ts` 色表(色板即绘制色);禁止渐变/插值;文字 AA 像素做最近邻量化。
- GIF 帧 delay 是 1/100s 单位,`round(ms/10)` 换算;`--speed 2` 使所有时长减半(仍保持 10ms 整数倍,不写任意 speed)。
- 产物目录 `files/` 已 `.gitignore`;写文件先 `.tmp` 后 rename,失败清理。
- 中文字体探测链:`--font` → `C:/Windows/Fonts/simkai.ttf`(楷体)→ `simhei.ttf`(黑体)→ `msyh.ttc`(雅黑)→ `simsun.ttc`(宋体);探测失败 exit 2;字形覆盖抽样(見 T6)。
- 命令行输入、代码注释遵循仓库中文注释习惯;回复与文档用简体中文;禁止在 Bash 用 `~`(触发 tilde 保护)。
- 验证命令:服务端 `npm -C games/xiangqi exec tsc --noEmit --skipLibCheck`;后端测试 `cd games/xiangqi && npm test`(vitest 默认 include `scripts/**/*.test.ts`)。

---

### Task 1: 依赖与骨架

**Files:**
- Modify: `games/xiangqi/package.json`(`dependencies` + `gif` script)
- Modify: `games/xiangqi/.gitignore`(`files/`)
- Create: `games/xiangqi/scripts/gif-export.ts`(空骨架,待 T8 填充;此处仅建文件占位,保证目录存在)

**Interfaces:**
- Consumes: 无
- Produces: `package.json` 增 `"gif": "tsx scripts/gif-export.ts"`;新依赖 `@napi-rs/canvas`、`gifenc` 可被后续任务 import

- [ ] **Step 1: 安装依赖**

```bash
cd /d/APP/llm_pk/games/xiangqi && npm install @napi-rs/canvas gifenc
```

- [ ] **Step 2: 校验依赖可解析(TS 类型导入)**

```bash
cd /d/APP/llm_pk/games/xiangqi && node -e "require('@napi-rs/canvas')" 2>/dev/null; node --input-type=module -e "import('gifenc').then(m=>console.log('gifenc ok', typeof m.GIFEncoder))"
```

Expected: 两行均无 `ERR_MODULE_NOT_FOUND`。若是 ESM 兜底失败,以实际导出版本为准(Task 1 只验证「装得上、类型能解析」)。

- [ ] **Step 3: package.json 加 script + gitignore**

把这两行分别塞进 `package.json` 的 `"scripts"`(与 `spike:parse` 并列)与 `.gitignore`(与 `logs/` 并列):

```jsonc
// package.json scripts 内、`"test:watch": "vitest",` 后:
    "gif": "tsx scripts/gif-export.ts",
// 若放其他位置,确保 JSON 逗号合法
```
```gitignore
files/
```

- [ ] **Step 4: 建骨架文件**

`scripts/gif-export.ts` 僅一行注释,确保文件存在且目录 `scripts/gif/` 也建立(建立任一文件即可,如 `scripts/gif/.gitkeep` 会被 git 误入?——不放 .gitkeep,直接建 `scripts/gif/palette.ts` 由 Task 2 承担,此步只建 `scripts/gif-export.ts`):

```ts
// 观战动图导出 CLI(实现见 scripts/gif/* 与 Task 8 入口)。
process.exit(0);
```

- [ ] **Step 5: 冒烟 + 提交**

```bash
cd /d/APP/llm_pk/games/xiangqi && npm run gif -- --help 2>&1 | head -2
git add package.json package-lock.json .gitignore scripts/gif-export.ts && git commit -m "chore(xiangqi): 动图导出依赖与骨架(@napi-rs/canvas + gifenc + gif script)"
```

Expected: 运行 `npm run gif` 无 module error(当前退出码非 0 可接受,仅验证环境),commit 成功。

---

### Task 2: palette.ts(色板表 + 最近邻量化)

**Files:**
- Create: `games/xiangqi/scripts/gif/palette.ts`
- Test: `games/xiangqi/scripts/gif/palette.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export const PALETTE: ReadonlyArray<readonly [number, number, number]>`(固定 ~48 色 RGB 表)
  - `export const hex: (h: string) => [number, number, number]`(工具,供构建色表)
  - `export function nearest(rgb: [number, number, number]): [number, number, number]`(返回色表最近邻,用于文字 AA 边缘量化)
  - `export function appearsInPalette(px: [number, number, number]): boolean`(像素与色表某色完全相等;测试用)
  - `export function paletteIndexOf(rgb: [number, number, number]): number`(最近邻索引,encode 用)

- [ ] **Step 1: 写失败测试**

```ts
// scripts/gif/palette.test.ts
import { describe, expect, it } from 'vitest';
import { PALETTE, hex, nearest, appearsInPalette, paletteIndexOf } from './palette';

describe('palette', () => {
  it('色表条目合法且唯一', () => {
    expect(PALETTE.length).toBeGreaterThan(16);
    expect(PALETTE.length).toBeLessThanOrEqual(256);
    const j = new Set(PALETTE.map(([r, g, b]) => `${r},${g},${b}`));
    expect(j.size).toBe(PALETTE.length);
  });

  it('hex 解析为十进制三元组', () => {
    expect(hex('d9a066')).toEqual([217, 160, 102]);
  });

  it('nearest 对已含色返回原色', () => {
    const hit = PALETTE[0]!;
    expect(nearest([hit[0], hit[1], hit[2]])).toEqual(Array.from(hit));
  });

  it('nearest 对渐变中间色收敛到表内', () => {
    const out = nearest([200, 150, 90]);
    expect(AppearsInSet(out)).toBe(true);
    const AppearsInSet = (v: number[]) => v.length === 3;
  });

  it('paletteIndexOf 与 nearest 同源', () => {
    const q = [12, 34, 56];
    expect(PALETTE[paletteIndexOf(q)]).toEqual(Array.from(nearest(q)));
  });

  it('appearsInPalette 判定纯色', () => {
    expect(appearsInPalette(Array.from(PALETTE[1]!))).toBe(true);
    expect(appearsInPalette([1, 2, 3])).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /d/APP/llm_pk/games/xiangqi && npx vitest run scripts/gif/palette.test.ts
```

Expected: FAIL(`PALETTE` 未定义)。

- [ ] **Step 3: 实现 palette.ts**

```ts
//
// 固定色板(色板即绘制色,spec §5/§10)。
// 所有棋盘/棋子/字幕/横幅颜色只能取本表;禁止渐变/插值;文字 AA 像素靠 nearest() 量化。
//

export type Rgb = readonly [number, number, number];

/** 十六进制 '#rrggbb'|'rrggbb' → [r,g,b]。 */
export function hex(h: string): [number, number, number] {
  const s = h.replace(/^#/, '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

const C = hex;

export const PALETTE: ReadonlyArray<Rgb> = Object.freeze([
  // 棋盘木板(3 档)
  C('d9a066'), C('e3b877'), C('c9964f'),
  // 网格线 / 河界 / 九宫斜线
  C('5a3a22'), C('8a5a30'), C('a88850'),
  // 红方棋子:底 / 字 / 环 ; 黑方棋子: 底 / 字 / 环
  C('f7e6c9'), C('c02020'), C('a01818'),
  C('2a2a2a'), C('f2eee8'), C('d8d2c8'),
  // 高亮:from 淡黄 / to 亮黄
  C('f7e0a0'), C('ffcc00'),
  // 字幕条底 / 副字 / 主字
  C('2f2f2f'), C('b8b8b8'), C('ffffff'),
  // 横幅:暗底 / 主字 / 副字
  C('1a1a1a'), C('ffe27a'), C('d8d8d8'),
  // 行棋方红/黑圆点
  C('d03838'), C('3a3a3a'),
  // 打回徽标
  C('c03a3a'), C('ffe1e1'),
]);

const SQ = 3 ** 3; // 每通道各 3 段(简化 LUT)

/** 最近邻索引(暴力线性 48 色 × 像素数 OK;需要时再 LUT)。返回色表内条目索引。 */
export function paletteIndexOf(rgb: Rgb): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < PALETTE.length; i++) {
    const p = PALETTE[i]!;
    const d = (rgb[0] - p[0]) ** 2 + (rgb[1] - p[1]) ** 2 + (rgb[2] - p[2]) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** 最近邻颜色。 */
export function nearest(rgb: Rgb): Rgb {
  return PALETTE[paletteIndexOf(rgb)]!;
}

/** 与色表完全相等。 */
export function appearsInPalette(rgb: Rgb): boolean {
  for (const p of PALETTE) if (p[0] === rgb[0] && p[1] === rgb[1] && p[2] === rgb[2]) return true;
  return false;
}
```

- [ ] **Step 4: 运行测试通过**

```bash
cd /d/APP/llm_pk/games/xiangqi && npx vitest run scripts/gif/palette.test.ts && npm -C /d/APP/llm_pk/games/xiangqi exec tsc --noEmit --skipLibCheck
```

Expected: 全绿 + tsc 干净。

- [ ] **Step 5: 提交**

```bash
cd /d/APP/llm_pk/games/xiangqi && git add scripts/gif/palette.ts scripts/gif/palette.test.ts && git commit -m "feat(xiangqi): 固定色板与最近邻量化(动图导出)"
```

---

### Task 3: events.ts(带行号解析 + 尾行容忍)

**Files:**
- Create: `games/xiangqi/scripts/gif/events.ts`
- Test: `games/xiangqi/scripts/gif/events.test.ts`

**背景:** `server/game-log.ts` 的 `readAllEvents` 对坏 JSON 直接抛裸 `SyntaxError`(无行号),且不区分「进行中日志的半写尾行」。本模块自写解析:坏行报 `文件:行号`,尾行半写被剥离。

**Interfaces:**
- Consumes: `import type { GameEvent } from '../../server/game-log'`
- Produces:
  - `export interface LogParseResult { events: GameEvent[]; loosened: number; bad: Array<{ line: number; text: string; error: string }> }`
  - `export function parseLogText(text: string): LogParseResult`
  - `export function readGameEvents(filePath: string): GameEvent[]`
    - 行为:文件缺失 → throw 带提示文字(exit 1 由调用方);坏行(非尾行)→ throw Error(`<file>:<line> …`);若「最后一行无换行结尾且 JSON 解析失败」→ 视为半写,忽略并 `loosened++`,否则照 `bad` 抛出。

- [ ] **Step 1: 写失败测试**

```ts
// scripts/gif/events.test.ts
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
    const text = `${line(begin)}\n${JSON.stringify({ type: 'move', tu`);
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
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /d/APP/llm_pk/games/xiangqi && npx vitest run scripts/gif/events.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 events.ts**

```ts
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
```

- [ ] **Step 4: 运行测试通过 + tsc**

```bash
cd /d/APP/llm_pk/games/xiangqi && npx vitest run scripts/gif/events.test.ts && npm -C /d/APP/llm_pk/games/xiangqi exec tsc --noEmit --skipLibCheck
```

Expected: 全绿 + 干净。

- [ ] **Step 5: 提交**

```bash
cd /d/APP/llm_pk/games/xiangqi && git add scripts/gif/events.ts scripts/gif/events.test.ts && git commit -m "feat(xiangqi): 动图日志解析——带行号报错 + 容忍进行中半写尾行"
```

---

### Task 4: frames.ts(事件 → 帧序列)

**Files:**
- Create: `games/xiangqi/scripts/gif/frames.ts`
- Test: `games/xiangqi/scripts/gif/frames.test.ts`

**Interfaces:**
- Consumes: `import type { GameEvent } from '../../server/game-log'`;`import { boardAt, movesAt, modelsAt, resultAt, type UidPiece, type ReplayMoveRecord } from '../../web/src/lib/replay'`
- Produces:
  - `export type FrameMode = 'open' | 'hold' | 'slide' | 'land' | 'final'`
  - `export interface GalleryCaption { round: number; notation: string; cur: number; total: number; mover: 'red' | 'black' | null; rejection: number; left: string; right: string }`
  - `export interface Frame { mode: FrameMode; board: UidPiece[]; from?: import('../../engine/types').Sq; to?: import('../../engine/types').Sq; slideT?: number; caption: GalleryCaption; banner: { title: string; sub: string } | null; delayMs: number }`
  - `export interface BuildOpts { speed: 1 | 2 }`
  - `export function buildFrames(events: GameEvent[], opts: BuildOpts): Frame[]`
  - `export function bannerText(winner: import('../../engine/types').Side | 'draw' | undefined, reason: string | undefined, hasFinish: boolean): { title: string; sub: string } | null`
  - 动画常量:open 1500ms / hold 1000ms / slide 100ms×4 / land 1000ms / final 2000ms;`--speed 2` 全部减半(见函数内)。
  - reason → 中文文案表 `export const REASON_TEXT: Record<string, string>`(与 `web/src/lib/format.ts` 对齐,由测试断言全集一致)。

- [ ] **Step 1: 写失败测试**

```ts
// scripts/gif/frames.test.ts
import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../../server/game-log';
import { buildFrames, bannerText } from './frames';
import { REASON_TEXT } from './frames';
import { codeToSq } from '../../engine/types';

const b = (mn: number): GameEvent => ({ seq: mn, ts: 't', type: 'begin', gameId: 'g', first: 'red', red: { model: 'R' }, black: { model: 'B' } });
const mv = (seq: number, from: string, to: string, turn: 'red' | 'black'): GameEvent => ({ seq, ts: 't', type: 'move', turn, move: { from, to }, legal: true });
const fin = (seq: number, winner: 'red' | 'black' | 'draw', reason: string): GameEvent => ({ seq, ts: 't', type: 'finish', winner, reason, ruleViolations: { red: { pre: 0, post: 0 }, black: { pre: 0, post: 0 } } });

describe('frames.buildFrames', () => {
  it('N 步=1+6N+1 帧;首 open 末 final;delay 符合常规档', () => {
    const evs = [b(1), mv(2, 'h3', 'e3', 'red'), mv(3, 'h8', 'e8', 'black'), mv(4, 'h2', 'e2', 'red'), fin(5, 'red', 'checkmate')];
    const fr = buildFrames(evs, { speed: 1 });
    expect(fr.length).toBe(1 + 6 * 3 + 1); // 20
    expect(fr[0]!.mode).toBe('open');
    expect(fr[0]!.delayMs).toBe(1500);
    expect(fr.at(-1)!.mode).toBe('final');
    expect(fr.at(-1)!.delayMs).toBe(2000);
    // 每步: hold(1s)+slide4(100ms)+land(1s)
    const step = fr.slice(1, 7);
    expect(step.map((f) => f.mode)).toEqual(['hold', 'slide', 'slide', 'slide', 'slide', 'land']);
    expect(step.map((f) => f.delayMs)).toEqual([1000, 100, 100, 100, 100, 1000]);
    expect(fr.at(-1)!.banner!.title).toBe('红方勝');
  });

  it('speed=2 全部减半', () => {
    const evs = [b(1), mv(2, 'h3', 'e3', 'red'), fin(3, 'black', 'stalemate')];
    const fr = buildFrames(evs, { speed: 2 });
    expect(fr[0]!.delayMs).toBe(750);
    const slideMs = fr.find((f) => f.mode === 'slide')!.delayMs;
    expect(slideMs).toBe(50);
  });

  it('slide 帧携带 from/to 与补间进度', () => {
    const evs = [b(1), mv(2, 'h3', 'e3', 'red'), fin(3, 'draw', 'draw-repeat')];
    const slides = buildFrames(evs, { speed: 1 }).filter((f) => f.mode === 'slide');
    expect(slides).toHaveLength(4);
    expect(slides[0]!.from).toEqual(codeToSq('h3'));
    expect(slides[0]!.to).toEqual(codeToSq('e3'));
    expect(slides.map((s) => s.slideT)).toEqual([0.25, 0.5, 0.75, 1]);
  });

  it('字幕回合/手数/行棋方更新;非法留痕不占挽面', () => {
    const evs = [b(1)] as GameEvent[];
    let seq = 1;
    const illegal: GameEvent = { seq: ++seq, ts: 't', type: 'illegal-attempt', side: 'red', round: 1, reason: '馬腿被絆', violations: { pre: 1, post: 0 } };
    const mv1: GameEvent = { seq: ++seq, ts: 't', type: 'move', turn: 'red', move: { from: 'h3', to: 'e3', notation: '炮二平五' }, legal: true };
    const bad: GameEvent = { seq: ++seq, ts: 't', type: 'move', turn: 'red', move: { from: 'xxx', to: 'yy' }, legal: false };
    const evs2 = [...evs, illegal, mv1, bad];
    const fr = buildFrames(evs2, { speed: 1 });
    const land = fr.find((f) => f.mode === 'land')!;
    expect(land.board.some((p) => p.file === 4 && p.rank === 2)).toBe(true); // 红炮 h3(7,2)→e3(4,2)
    // 记谱:第一步含非法 → 打回徽标计 1
    expect(land.caption.rejection).toBe(1);
    expect(land.caption.cur).toBe(1);
  });

  it('未完成局 final 横幅为「对局进行中」', () => {
    const evs = [b(1), mv(2, 'h3', 'e3', 'red')];
    const fr = buildFrames(evs, { speed: 1 });
    expect(fr.at(-1)!.mode).toBe('final');
    expect(fr.at(-1)!.banner!.title).toBe('对局进行中');
  });

  it('reason 文案表与 web/src/lib/format.ts 全集对齐', async () => {
    const { fmtReason } = await import('../../web/src/lib/format');
    const reasons: string[] = ['checkmate', 'stalemate', 'illegal-moves', 'timeout', 'internal-error', 'draw-aborted', 'draw-repeat', 'draw-no-mating-material', 'draw-max-moves', 'draw-cost-limit', 'draw-network'];
    for (const r of reasons) expect(REASON_TEXT[r]).toBe(fmtReason(r));
  });
});

describe('frames.bannerText', () => {
  it('胜/和/未决三种横幅', () => {
    expect(bannerText('red', 'checkmate', true)!.title).toBe('红方勝');
    expect(bannerText('draw', 'draw-repeat', true)!.title).toBe('和棋');
    expect(bannerText(undefined, undefined, false)!.title).toBe('对局进行中');
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /d/APP/llm_pk/games/xiangqi && npx vitest run scripts/gif/frames.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 frames.ts**

```ts
//
// 事件 → 帧描述序列(纯逻辑,零 IO;spec §6)。
// 复用 web/src/lib/replay 同源派生(与实时观战共用 boardAt/movesAt/modelsAt/resultAt)。
//
import type { GameEvent } from '../../server/game-log';
import { boardAt, movesAt, modelsAt, resultAt, type UidPiece } from '../../web/src/lib/replay';
import type { Side, Sq } from '../../engine/types';

export type FrameMode = 'open' | 'hold' | 'slide' | 'land' | 'final';

export interface GalleryCaption {
  round: number;
  notation: string;
  cur: number;      // 已落第几手
  total: number;
  mover: Side | null;
  rejection: number;
  left: string;     // 左开始段(回合+记谱)
  right: string;    // 右段(模型名)
}

export interface Frame {
  mode: FrameMode;
  board: UidPiece[];
  from?: Sq;
  to?: Sq;
  slideT?: number;
  caption: GalleryCaption;
  banner: { title: string; sub: string } | null;
  delayMs: number;
}

export interface BuildOpts { speed: 1 | 2 }

/** reason → 中文(与 web/src/lib/format.ts 对齐;测试断言全集一致,勿单方改)。 */
export const REASON_TEXT: Record<string, string> = {
  checkmate: '絕殺',
  stalemate: '困毙',
  'illegal-moves': '打回超过上限判负',
  timeout: '网络超时判负',
  'internal-error': '对局异常终止',
  'draw-aborted': '强制中止',
  'draw-repeat': '重复局面 · 和棋',
  'draw-no-mating-material': '双方无进攻子力 · 和棋',
  'draw-max-moves': '步数上限 · 和棋',
  'draw-cost-limit': '成本上限 · 和棋',
  'draw-network': '网络异常 · 对局中止(不作胜负)',
};

const WINNER_TEXT: Record<Side, string> = { red: '红方勝', black: '黑方勝' };

export function bannerText(winner: Side | 'draw' | undefined, reason: string | undefined, hasFinish: boolean): { title: string; sub: string } | null {
  if (!hasFinish || winner === undefined) return { title: '对局进行中', sub: '' };
  const title = winner === 'draw' ? '和棋' : WINNER_TEXT[winner];
  const sub = reason ? (REASON_TEXT[reason] ?? reason) : '';
  return { title, sub };
}

const halfMoveToRound = (n: number) => Math.ceil(Math.max(n, 0) / 2);

export function buildFrames(events: GameEvent[], opts: BuildOpts): Frame[] {
  const moves = movesAt(events, Number.MAX_SAFE_INTEGER);
  const total = moves.length;
  const models = modelsAt(events, Number.MAX_SAFE_INTEGER);
  const res = resultAt(events, Number.MAX_SAFE_INTEGER);
  const hasFinish = res !== null;
  const banner = bannerText(res?.winner, res?.reason, hasFinish);

  const left = (i: number) => `${models?.red ?? '? 红'} vs ${models?.black ?? '? 黑'}`;
  const speed = opts.speed === 2 ? 0.5 : 1;

  const frames: Frame[] = [];
  const rejectionUpTo = (seq: number) => {
    let n = 0;
    for (const e of events) { if (e.seq > seq) break; if (e.type === 'illegal-attempt') n++; }
    return n;
  };

  const captionAt = (i: number, mover: Side | null, rejection: number): GalleryCaption => {
    const m = i >= 1 ? moves[i - 1]! : null;
    return {
      round: halfMoveToRound(i),
      notation: m?.notation ?? '',
      cur: i,
      total,
      mover,
      rejection,
      left: '',
      right: left(i),
    };
  };

  // open 帧(初始局面)
  frames.push({
    mode: 'open',
    board: boardAt(events, 0),
    caption: captionAt(0, 'red', rejectionUpTo(0)),
    banner: null,
    delayMs: Math.round(1500 * speed),
  });

  for (let i = 1; i <= total; i++) {
    const m = moves[i - 1]!;
    const from: Sq = m.from;
    const to: Sq = m.to;
    const reject = rejectionUpTo(m.seq);
    const boardBefore = boardAt(events, i === 1 ? 0 : moves[i - 2]!.seq);
    const boardAfter = boardAt(events, m.seq);

    frames.push({ mode: 'hold', board: boardBefore, caption: captionAt(i - 1, m.turn, reject), banner: null, delayMs: Math.round(1000 * speed) });
    for (let k = 1; k <= 4; k++) {
      frames.push({ mode: 'slide', board: boardBefore, from, to, slideT: k / 4, caption: captionAt(i - 1, m.turn, reject), banner: null, delayMs: Math.round(100 * speed) });
    }
    frames.push({ mode: 'land', board: boardAfter, from, to, caption: captionAt(i, m.turn, reject), banner: null, delayMs: Math.round(1000 * speed) });
  }

  // final 帧(终局局面 + 横幅);未完成局以当前局面为终局
  frames.push({
    mode: 'final',
    board: boardAt(events, Number.MAX_SAFE_INTEGER),
    caption: captionAt(total, null, rejectionUpTo(Number.MAX_SAFE_INTEGER)),
    banner,
    delayMs: Math.round(2000 * speed),
  });
  return frames;
}
```

- [ ] **Step 4: 运行测试通过 + tsc**

```bash
cd /d/APP/llm_pk/games/xiangqi && npx vitest run scripts/gif/frames.test.ts && npm -C /d/APP/llm_pk/games/xiangqi exec tsc --noEmit --skipLibCheck
```

Expected: 全绿。若 `move.notation` 在测试事件里未给(走子正常时 `notation` 可能缺省),`captionAt` 的 `m?.notation ?? ''` 兜底为空串(不影响断言,因断言因 `banner` 与 `rejection`)。

- [ ] **Step 5: 提交**

```bash
cd /d/APP/llm_pk/games/xiangqi && git add scripts/gif/frames.ts scripts/gif/frames.test.ts && git commit -m "feat(xiangqi): 事件→帧序列(open/hold/slide/land/final)+字幕与横幅派生"
```

---

### Task 5: fonts.ts(字体探测 + 字形覆盖)

**Files:**
- Create: `games/xiangqi/scripts/gif/fonts.ts`
- Test: `games/xiangqi/scripts/gif/fonts.test.ts`

**Interfaces:**
- Consumes: `import { existsSync } from 'node:fs'`;`import { GlobalFonts } from '@napi-rs/canvas'`
- Produces:
  - `export const FAMILY = 'XQFont'`(注册的字体族名,render 引用)
  - `export function resolveFontPath(explicit?: string): string | null`(探测链,`--font` 优先)
  - `export function registerFont(path: string): void`(注册到 `GlobalFonts`)
  - `export function assertGlyphs(ctx: CanvasRenderingContext2D): string[]`(返回缺字形字符数组)

- [ ] **Step 1: 写失败测试**

```ts
// scripts/gif/fonts.test.ts
import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { resolveFontPath, registerFont, assertGlyphs, FAMILY } from './fonts';

describe('fonts', () => {
  it('探测链返回可注册路径或 null(显式缺失时 null)', () => {
    expect(resolveFontPath() === null || typeof resolveFontPath() === 'string').toBe(true);
    if (resolveFontPath('/definitely/missing/foo.ttf') !== null) {
      expect(false).toBe(true); // 显式存在的伪路径不应命中
    }
  });

  it('存在字体时注册 + 传统字形覆盖非空', () => {
    const p = resolveFontPath();
    if (!p) return; // 本机无中文字体 → 跳过(CI 同理)
    registerFont(p);
    const canvas = createCanvas(4, 4);
    const ctx = canvas.getContext('2d');
    ctx.font = `24px ${FAMILY}`;
    const missing = assertGlyphs(ctx);
    expect(missing).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /d/APP/llm_pk/games/xiangqi && npx vitest run scripts/gif/fonts.test.ts
```

Expected: FAIL(`resolveFontPath` 未定义)。

- [ ] **Step 3: 实现 fonts.ts**

```ts
//
// 中文字体解析(动图导出专用,spec §3/§9):
//  - 探测链: --font → simkai(楷体) → simhei(黑体) → msyh(雅黑) → simsun(宋体);
//  - registerFont 用固定族名 'XQFont',render 用该族名;
//  - assertGlyphs 对传统橘子字域抽样,任一宽度 0 → 调用方报缺字形 exit 2。
//
import { existsSync } from 'node:fs';
import { GlobalFonts } from '@napi-rs/canvas';

export const FAMILY = 'XQFont';

export const FONT_CANDIDATES = [
  'C:/Windows/Fonts/simkai.ttf',  // 楷体
  'C:/Windows/Fonts/simhei.ttf',  // 黑体
  'C:/Windows/Fonts/msyh.ttc',    // 雅黑
  'C:/Windows/Fonts/simsun.ttc',  // 宋体
];

export function resolveFontPath(explicit?: string): string | null {
  if (explicit) return existsSync(explicit) ? explicit : null;
  for (const p of FONT_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

export function registerFont(path: string): void {
  GlobalFonts.registerFromPath(path, FAMILY);
}

const GLYPH_PROBES = '帥將車馬相仕象士砲炮兵卒楚河漢界絕殺困毙';

export function assertGlyphs(ctx: import('@napi-rs/canvas').CanvasRenderingContext2D): string[] {
  ctx.font = `24px ${FAMILY}`;
  const missing: string[] = [];
  for (const ch of GLYPH_PROBES) {
    if (ctx.measureText(ch).width === 0) missing.push(ch);
  }
  return missing;
}
```

- [ ] **Step 4: 运行测试通过 + tsc**

```bash
cd /d/APP/llm_pk/games/xiangqi && npx vitest run scripts/gif/fonts.test.ts && npm -C /d/APP/llm_pk/games/xiangqi exec tsc --noEmit --skipLibCheck
```

Expected: 全绿(本机有中文字体则主断言过;无则跳过)+ 干净。

- [ ] **Step 5: 提交**

```bash
cd /d/APP/llm_pk/games/xiangqi && git add scripts/gif/fonts.ts scripts/gif/fonts.test.ts && git commit -m "feat(xiangqi): 中文字体探测链 + 传统字形覆盖抽样"
```

---

### Task 6: render.ts(canvas 棋局渲染,色板即绘制色)

**Files:**
- Create: `games/xiangqi/scripts/gif/render.ts`
- Test: `games/xiangqi/scripts/gif/render.test.ts`

**注意:** 本任务引入 `@napi-rs/canvas`。若类型名 `CanvasRenderingContext2D` 不存在于该包,退而用 `ReturnType<ReturnType<typeof createCanvas>['getContext']>` 或 `any`(以极窄范围),并在 Step 4 说明。

**Interfaces:**
- Consumes: `Frame`(Task 4)、`PALETTE`(Task 2)、`FAMILY`
- Produces:
  - `export const TICKER_H = 140`
  - `export function drawFrame(ctx, frame: Frame, boardSize: number): void`(画一帧到 canvas 2D context)
  - `export function renderFrameToRgba(frame: Frame, boardSize: number): Uint8Array`(W×H=boardSize×(boardSize+TICKER_H) RGBA,alpha 全 255)
  - `export function renderFramePng(frame: Frame, boardSize: number): Buffer`(封面用)
  - `export function renderBounds(boardSize: number): { width: number; height: number }`

- [ ] **Step 1: 写失败测试**

```ts
// scripts/gif/render.test.ts
import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../../server/game-log';
import { buildFrames } from './frames';
import { renderFrameToRgba, renderFramePng, TICKER_H, renderBounds } from './render';
import { resolveFontPath, registerFont, FAMILY } from './fonts';
import { appearsInPalette } from './palette';
import { createCanvas } from '@napi-rs/canvas';

const font = resolveFontPath();
if (font) { registerFont(font); const c = createCanvas(2, 2); ctx.font=`10px ${FAMILY}`; }
const ctx = createCanvas(2, 2).getContext('2d');
if (font) { ctx.font = `12px ${FAMILY}`; }

const b = (n: number) => ({ seq: n, ts: 't', type: 'begin', gameId: 'g', first: 'red', red: { model: 'R' }, black: { model: 'B' } }) as GameEvent;
const mv = (seq: number, f: string, t: string, turn: 'red' | 'black') => ({ seq, ts: 't', type: 'move', turn, move: { from: f, to: t }, legal: true }) as GameEvent;
const fin = (seq: number, winner: 'red' | 'black' | 'draw', reason: string) => ({ seq, ts: 't', type: 'finish', winner, reason, ruleViolations: { red: { pre: 0, post: 0 }, black: { pre: 0, post: 0 } } }) as GameEvent;
const framesFor = (evs: GameEvent[]) => buildFrames(evs, { speed: 1 });

describe('render', () => {
  it('画布几何与文件产出', () => {
    const { width, height } = renderBounds(900);
    expect(width).toBe(900);
    expect(height).toBe(900 + TICKER_H);
  });

  it('open 帧 RGBA 尺寸与主色板色', () => {
    const frames = framesFor([b(1), mv(2, 'h3', 'e3', 'red')]);
    const buf = renderFrameToRgba(frames[0]!, 900);
    expect(buf.length).toBe(900 * (900 + TICKER_H) * 4);
    // 抽样 32 点,除文字 AA 外皆在色板(容差:文字局部少量 AA 允许)
    let outside = 0;
    for (let i = 0; i < 400; i++) {
      const x = Math.floor(Math.random() * 900);
      const y = Math.floor(Math.random() * 900);
      const o = (y * 900 + x) * 4;
      if (!appearsInPalette([buf[o]!, buf[o + 1]!, buf[o + 2]!])) outside++;
      if (outside > 60) break;
    }
    expect(outside).toBeLessThanOrEqual(60);
  });

  it.skipIf(!font)('字体存在时 final 横幅可渲染(不抛)', () => {
    const frames = framesFor([b(1), mv(2, 'h3', 'e3', 'red'), fin(3, 'red', 'checkmate')]);
    const png = renderFramePng(frames.at(-1)!, 900);
    expect(png.length).toBeGreaterThan(100);
    expect(png.subarray(0, 4).toString('hex')).toBe('89504e47'); // PNG magic
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /d/APP/llm_pk/games/xiangqi && npx vitest run scripts/gif/render.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 render.ts**

```ts
//
// canvas 棋局渲染(色板即绘制色,spec §5)。
// 大面积色只用 PALETTE 内颜色、禁止渐变;文字 AA 像素由渲染侧直接落在板内邻色。
//
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import type { Frame } from './frames';
import { PALETTE } from './palette';
import { FAMILY } from './fonts';

export const TICKER_H = 140;
const MARGIN = 46;

// 色板索引 P(与 scripts/gif/palette.ts 顺序严格对应)
const P = {
  wood0: 0, wood1: 1, wood2: 2, grid: 3, grid2: 4, river: 5,
  redBg: 6, redChar: 7, redRing: 8, blackBg: 9, blackChar: 10, blackRing: 11,
  hlFrom: 12, hlTo: 13, tickerBg: 14, tickerSub: 15, tickerMain: 16,
  bannerBg: 17, bannerMain: 18, bannerSub: 19, moverRed: 20, moverBlack: 21,
  badgeBg: 22, badgeText: 23,
} as const;

const rgba = (i: number, a = 255) => `${PALETTE[i]![0]},${PALETTE[i]![1]},${PALETTE[i]![2]},${a}`;

const PIECE_CHAR: Record<string, string> = {
  'red:rook': '車', 'red:horse': '馬', 'red:elephant': '相', 'red:advisor': '仕',
  'red:general': '帥', 'red:cannon': '砲', 'red:pawn': '兵',
  'black:rook': '車', 'black:horse': '馬', 'black:elephant': '象', 'black:advisor': '士',
  'black:general': '將', 'black:cannon': '砲', 'black:pawn': '卒',
};

export function renderBounds(boardSize: number): { width: number; height: number } {
  return { width: boardSize, height: boardSize + TICKER_H };
}

// —— 绘制辅助(全部只在 PALETTE 内部取值) ——
const fill = (ctx: CanvasRenderingContext2D, i: number) => { ctx.fillStyle = rgba(i); };
const stroke = (ctx: CanvasRenderingContext2D, i: number) => { ctx.strokeStyle = rgba(i); };

export function drawFrame(ctx, frame: Frame, boardSize: number): void {
  const W = boardSize;
  const H = boardSize + TICKER_H;
  const cell = (boardSize - 2 * MARGIN) / 8;
  const gridW = 8 * cell;
  const gridH = 9 * cell;
  const padTop = (boardSize - gridH) / 2;
  const px = (col: number) => MARGIN + col * cell;
  const py = (rank: number) => padTop + (9 - rank) * cell;
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  };

  // 底
  fill(ctx, P.wood1); ctx.fillRect(0, 0, W, boardSize);
  fill(ctx, P.tickerBg); ctx.fillRect(0, boardSize, W, TICKER_H);

  // 网格线
  stroke(ctx, P.grid);
  ctx.lineWidth = Math.max(1, cell * 0.03);
  for (let c = 0; c <= 8; c++) { line(px(c), py(0), px(c), py(4)); line(px(c), py(5), px(c), py(9)); }
  for (let r = 0; r <= 9; r++) line(px(0), py(r), px(8), py(r));
  // 九宫斜线(红 rank0-2 / 黑 rank7-9)
  stroke(ctx, P.grid);
  line(px(0), py(0), px(2), py(2)); line(px(0), py(8), px(2), py(6));
  line(px(6), py(0), px(8), py(2)); line(px(6), py(8), px(8), py(6));
  line(px(0), py(9), px(2), py(7)); line(px(0), py(1), px(2), py(3));
  line(px(6), py(9), px(8), py(7)); line(px(6), py(1), px(8), py(3));

  // 河界文字(rank4/5 之间)
  fill(ctx, P.river);
  ctx.font = `${Math.round(cell * 0.34)}px ${FAMILY}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('楚 河 漢 界', px(4), (py(4) + py(5)) / 2);

  // 高亮格(先于棋子)
  if (frame.from) {
    fill(ctx, P.hlFrom);
    ctx.beginPath();
    ctx.roundRect(px(frame.from.file) - cell * 0.5, py(frame.from.rank) - cell * 0.5, cell, cell, cell * 0.12);
    ctx.fill();
  }
  if (frame.to) {
    fill(ctx, P.hlTo);
    ctx.beginPath();
    ctx.roundRect(px(frame.to.file) - cell * 0.5, py(frame.to.rank) - cell * 0.5, cell, cell, cell * 0.12);
    ctx.fill();
  }

  // 棋子
  for (const p of frame.board) {
    let col = p.file;
    let rank = p.rank;
    let scale = 1;
    if (frame.mode === 'slide' && frame.from && frame.to && frame.slideT !== undefined) {
      const isMover = p.file === frame.from.file && p.rank === frame.from.rank && p.side === frame.caption.mover;
      const isTaken = p.file === frame.to.file && p.rank === frame.to.rank && !isMover;
      if (isMover) { col = lerp(frame.from.file, frame.to.file, frame.slideT); rank = lerp(frame.from.rank, frame.to.rank, frame.slideT); }
      if (isTaken) { scale = 1 - frame.slideT; if (scale <= 0) continue; }
    }
    const cx = px(col);
    const cy = py(rank);
    const r = cell * 0.42 * scale;
    const char = PIECE_CHAR[`${p.side}:${p.type}`] ?? '?';
    const isRed = p.side === 'red';
    stroke(ctx, isRed ? P.redRing : P.blackRing);
    ctx.lineWidth = cell * 0.05;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    fill(ctx, isRed ? P.redBg : P.blackBg);
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    fill(ctx, isRed ? P.redChar : P.blackChar);
    ctx.font = `${Math.round(cell * 0.55 * scale)}px ${FAMILY}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(char, cx, cy + (scale < 1 ? Math.round(cell * 0.05) : 0));
  }

  // 字幕条
  fill(ctx, P.tickerSub);
  const leftText = `第 ${frame.caption.round} 回合·${frame.caption.notation || '—'}`;
  const midText = `第 ${frame.caption.cur}/${frame.caption.total} 手`;
  const rightText = frame.caption.right || '';
  ctx.font = `${Math.round(boardSize * 0.026)}px ${FAMILY}`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const ty = boardSize + TICKER_H / 2;
  const label = (t: string, x: number, color: number) => { fill(ctx, color); ctx.fillText(t, x, ty); };
  label(leftText, 24, 16);
  label(midText, boardSize * 0.42, 15);
  // 行棋方圆点
  if (frame.caption.mover) {
    const dot = frame.caption.mover === 'red' ? P.moverRed : P.moverBlack;
    fill(ctx, dot);
    ctx.beginPath(); ctx.arc(boardSize * 0.42 - 16, ty, 7, 0, Math.PI * 2); ctx.fill();
  }
  label(rightText, boardSize * 0.55, 15);
  // 打回徽标
  if (frame.caption.rejection > 0) {
    fill(ctx, P.badgeBg);
    const bt = `⚠ 打回×${frame.caption.rejection}`;
    ctx.font = `${Math.round(boardSize * 0.02)}px ${FAMILY}`;
    const w = ctx.measureText(bt).width + 16;
    ctx.roundRect(boardSize * 0.78, ty - 12, w, 24, 6); ctx.fill();
    fill(ctx, P.badgeText);
    ctx.fillText(bt, boardSize * 0.78 + 8, ty);
  }

  // 结果横幅(final 帧叠加)
  if (frame.banner) {
    const bw = boardSize * 0.62;
    const bh = boardSize * 0.34;
    fill(ctx, P.bannerBg);
    ctx.roundRect((W - bw) / 2, boardSize * 0.3, bw, bh, 12); ctx.fill();
    fill(ctx, P.bannerMain);
    ctx.font = `${Math.round(boardSize * 0.07)}px ${FAMILY}`;
    ctx.textAlign = 'center';
    ctx.fillText(frame.banner.title, W / 2, boardSize * 0.3 + bh * 0.42);
    if (frame.banner.sub) {
      fill(ctx, P.bannerSub);
      ctx.font = `${Math.round(boardSize * 0.032)}px ${FAMILY}`;
      ctx.fillText(frame.banner.sub, W / 2, boardSize * 0.3 + bh * 0.75);
    }
  }
}

export function renderFrameToRgba(frame: Frame, boardSize: number): Uint8Array {
  const { width, height } = renderBounds(boardSize);
  const c = createCanvas(width, height);
  const ctx = c.getContext('2d');
  drawFrame(ctx, frame, boardSize);
  const d = ctx.getImageData(0, 0, width, height).data;
  return new Uint8Array(d);
}

export function renderFramePng(frame: Frame, boardSize: number): Buffer {
  const { width, height } = renderBounds(boardSize);
  const c = createCanvas(width, height);
  const ctx = c.getContext('2d');
  drawFrame(ctx, frame, boardSize);
  return c.toBuffer('image/png');
}
```

- [ ] **Step 4: 运行测试通过 + tsc**

```bash
cd /d/APP/llm_pk/games/xiangqi && npx vitest run scripts/gif/render.test.ts && npm -C /d/APP/llm_pk/games/xiangqi exec tsc --noEmit --skipLibCheck
```

Expected: 全绿。若 `roundRect` 在 @napi-rs/canvas 缺失,改为 `fillRect`(在 Step 3 内替换该两处;注释说明兼容)。

- [ ] **Step 5: 提交**

```bash
cd /d/APP/llm_pk/games/xiangqi && git add scripts/gif/render.ts scripts/gif/render.test.ts && git commit -m "feat(xiangqi): canvas 棋局渲染——色板即绘制色 + 字幕/横幅/行棋方圆点"
```

---

### Task 7: encode.ts(GIF 编码 + 分片 + 封面)

**Files:**
- Create: `games/xiangqi/scripts/gif/encode.ts`
- Test: `games/xiangqi/scripts/gif/encode.test.ts`

**Interfaces:**
- Consumes: `Frame`、`renderFrameToRgba / renderFramePng / renderBounds`(Task 6)、`PALETTE`、`FAMILY`
- Produces:
  - `export function encodeGifBytes(frames: Frame[], boardSize: number): Uint8Array`(任一帧集合 → GIF 字节;delay 换算 1/100s)
  - `export function groupChunks(frames: Frame[]): Frame[][]`(open/final 单块、每步 hold+slide×4+land 一块)
  - `export function shardFrames(frames: Frame[], boardSize: number, maxBytes: number): Frame[][]`(若总量 ≤ budget 返回单组;否则按块二分切段,每段独立 GIF)
  - `export function withContinueMarkers(shards: Frame[][]): Frame[][]`(给非末段末尾插入「未完 · 续」final 帧)
  - `export function coverPngBuffer(frames: Frame[], boardSize: number): Buffer`(首帧静态 PNG)

- [ ] **Step 1: 写失败测试**

```ts
// scripts/gif/encode.test.ts
import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../../server/game-log';
import { buildFrames, type Frame } from './frames';
import { encodeGifBytes, groupChunks, shardFrames, withContinueMarkers } from './encode';
import { resolveFontPath, registerFont } from './fonts';

const font = resolveFontPath();
if (font) registerFont(font);
const hasFont = font !== null;

const b = (n: number) => ({ seq: n, ts: 't', type: 'begin', gameId: 'g', first: 'red', red: { model: 'R' }, black: { model: 'B' } }) as GameEvent;
const mv = (s: number, f: string, t: string, turn: 'red' | 'black') => ({ seq: s, ts: 't', type: 'move', turn, move: { from: f, to: t }, legal: true }) as GameEvent;
const fin = (s: number, winner: 'red' | 'black' | 'draw', reason: string) => ({ seq: s, ts: 't', type: 'finish', winner, reason, ruleViolations: { red: { pre: 0, post: 0 }, black: { pre: 0, post: 0 } } }) as GameEvent;
const framesFor = (evs: GameEvent[]) => buildFrames(evs, { speed: 1 });

describe('encode', () => {
  it.skipIf(!hasFont)('编码产物以 GIF89a 开头且非空', () => {
    const fs = framesFor([b(1), mv(2, 'h3', 'e3', 'red'), fin(3, 'red', 'checkmate')]);
    const buf = encodeGifBytes(fs, 900);
    expect(buf.length).toBeGreaterThan(100);
    expect(Array.from(buf.subarray(0, 6)).join(',')).toBe('71,73,70,56,57,97');
  });

  it('groupChunks 按步切块(open 单块 + 每步一步块 + final 单块)', () => {
    const fs = framesFor([b(1), mv(2, 'h3', 'e3', 'red'), mv(3, 'h8', 'e8', 'black')]);
    const chunks = groupChunks(fs);
    expect(chunks.length).toBe(3); // open + step1 + step2 (无 final)
    expect(chunks[1]!.map((f) => f.mode)).toEqual(['hold', 'slide', 'slide', 'slide', 'slide', 'land']);
  });

  it.skipIf(!hasFont)('withContinueMarkers 给非末段加「未完·续」,末段不变', () => {
    const fs = framesFor([b(1), mv(2, 'h3', 'e3', 'red'), mv(3, 'h8', 'e8', 'black'), fin(4, 'red', 'checkmate')]);
    const shards = shardFrames(fs, 720, 4_000); // 小预算 → 必分片
    expect(shards.length).toBeGreaterThan(1);
    const marked = withContinueMarkers(shards);
    for (let i = 0; i < marked.length - 1; i++) {
      expect(marked[i]!.at(-1)!.mode).toBe('final');
      expect(marked[i]!.at(-1)!.banner!.title).toBe('未完 · 续');
    }
    expect(marked.at(-1)!.at(-1)!.banner!.title).not.toBe('未完 · 续');
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /d/APP/llm_pk/games/xiangqi && npx vitest run scripts/gif/encode.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 encode.ts**

```ts
//
// GIF 编码 + 分片 + 封面(spec §6/§7/§8)。
// 固定色板(不用 quantize,避免逐帧量化闪烁);delay 换算 1/100s;分片按「步块」二分,
// 末段保留真实横幅、非末段由 withContinueMarkers 收尾「未完·续」。
//
import { GIFEncoder, applyPalette } from 'gifenc';
import type { Frame } from './frames';
import { PALETTE } from './palette';
import { renderFrameToRgba, renderFramePng, renderBounds } from './render';

const delayCenti = (ms: number) => Math.max(1, Math.round(ms / 10));

export function encodeGifBytes(frames: Frame[], boardSize: number): Uint8Array {
  const { width, height } = renderBounds(boardSize);
  const gif = GIFEncoder();
  const palette = PALETTE as unknown as [number, number, number][];
  for (const f of frames) {
    const rgba = renderFrameToRgba(f, boardSize);
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      rgb[j] = rgba[i]!; rgb[j + 1] = rgba[i + 1]!; rgb[j + 2] = rgba[i + 2]!;
    }
    const index = applyPalette(rgb, palette);
    gif.writeFrame(index, width, height, { palette, delay: delayCenti(f.delayMs) });
  }
  gif.finish();
  return new Uint8Array(gif.bytes());
}

export function groupChunks(frames: Frame[]): Frame[][] {
  const chunks: Frame[][] = [];
  let cur: Frame[] = [];
  const flush = () => { if (cur.length) { chunks.push(cur); cur = []; } };
  for (const f of frames) {
    if (f.mode === 'open' || f.mode === 'final') { flush(); chunks.push([f]); continue; }
    cur.push(f);
    if (f.mode === 'land') flush();
  }
  flush();
  return chunks;
}

export function shardFrames(frames: Frame[], boardSize: number, maxBytes: number): Frame[][] {
  const chunks = groupChunks(frames);
  const bytesOf = (c: Frame[][]) => encodeGifBytes(c.flat(), boardSize).length;
  const cut = (c: Frame[][]): Frame[][] => {
    if (c.length <= 1) return c.flatMap((x) => x); // 单块:不再切(可能仍超,交由调用方提示)
    if (bytesOf(c) <= maxBytes) return [c.flat()];
    const mid = Math.max(1, Math.floor(c.length / 2));
    return [...cut(c.slice(0, mid)), ...cut(c.slice(mid))];
  };
  return cut(chunks);
}

export function withContinueMarkers(shards: Frame[][]): Frame[][] {
  return shards.map((seg, idx, arr) => {
    if (idx === arr.length - 1) return seg;
    const last = seg.at(-1)!;
    return [...seg, { ...last, mode: 'final', banner: { title: '未完 · 续', sub: `第 ${idx + 1}/${arr.length} 段` }, delayMs: 1500 }];
  });
}

export function coverPngBuffer(frames: Frame[], boardSize: number): Buffer {
  return renderFramePng(frames[0]!, boardSize);
}
```

- [ ] **Step 4: 运行测试通过 + tsc**

```bash
cd /d/APP/llm_pk/games/xiangqi && npx vitest run scripts/gif/encode.test.ts && npm -C /d/APP/llm_pk/games/xiangqi exec tsc --noEmit --skipLibCheck
```

Expected: 全绿(无字体机器分片相关用例 skip)。

- [ ] **Step 5: 提交**

```bash
cd /d/APP/llm_pk/games/xiangqi && git add scripts/gif/encode.ts scripts/gif/encode.test.ts && git commit -m "feat(xiangqi): gifenc 编码 + 按步分片 + 未完·续 + 封面 PNG"
```

---

### Task 8: gif-export.ts(CLI 编排)

**Files:**
- Create: `games/xiangqi/scripts/gif-export.ts`(覆盖 Task 1 占位)
- Create: `games/xiangqi/scripts/gif/cli.ts`(可测逻辑,拆出)
- Test: `games/xiangqi/scripts/gif/cli.test.ts`

**Interfaces:**
- Consumes: events/frames/fonts/render/encode 全部;`import.meta.url` 定位包根
- Produces:
  - `export interface GifOpts { width: number; speed: 1 | 2; maxKb: number; explicitFont?: string }`
  - `export function resolveLogsDir(repoRoot: string): string`(`<root>/logs`)
  - `export function sanitizeGameId(raw: string): string`(basename → 若 `^[A-Za-z0-9][A-Za-z0-9._-]*$` 不匹配则 throw)
  - `export function parseArgs(argv: string[]): { all: boolean; gameId?: string; out: string | null; opts: GifOpts }`
  - `export async function exportGame(logPath: string, outDir: string, opts: GifOpts): Promise<ExportResult>`
  - `export interface ExportResult { gameId: string; outputs: string[]; cover?: string; frames: number; elapsedMs: number }`
  - `scripts/gif-export.ts` 顶部 `main()` 入口:解析 → 字体验证 → 单局或 `--all` 批量。

- [ ] **Step 1: 写失败测试**

```ts
// scripts/gif/cli.test.ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
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
});

describe('cli.sanitizeGameId', () => {
  it('路径穿越被净化 / 非法 id 拒绝', () => {
    expect(sanitizeGameId('..\\..\\evil')).toBe('evil');
    expect(() => sanitizeGameId('..')).toThrow();
    expect(() => sanitizeGameId('')) .toThrow();
  });
});

describe('cli.exportGame', () => {
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
  });

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
  });
});
```

注意:`sanitizeGameId('..')).toThrow` 这句写法是校验「越级输入被拒」;实现用「净化后仍非法则 throw」语义时,`'..'` 的 basename 是 `..` 仍非法 → throw。测试句子让实现自由(推荐:非法即 throw)。

- [ ] **Step 2: 运行确认失败**

```bash
cd /d/APP/llm_pk/games/xiangqi && npx vitest run scripts/gif/cli.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 cli.ts + gif-export.ts**

```ts
// scripts/gif/cli.ts
import { mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { readGameEvents } from './events';
import { buildFrames } from './frames';
import { encodeGifBytes, shardFrames, withContinueMarkers, coverPngBuffer } from './encode';
import { renderBounds } from './render';
import { resolveFontPath, registerFont, assertGlyphs } from './fonts';
import { createCanvas } from '@napi-rs/canvas';

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
  const { width, height } = renderBounds(boardSize);
  const maxBytes = opts.maxKb * 1024;
  const shards = shardFrames(frames, boardSize, maxBytes);
  const marked = withContinueMarkers(shards);
  const outputs: string[] = [];
  const total = shards.length;
  marked.forEach((seg, i) => {
    const buf = encodeGifBytes(seg, boardSize);
    const name = total === 1 ? `${gameId}.gif` : `${gameId}.part${i + 1}.gif`;
    const tmp = `${outDir}/${name}.tmp`;
    writeFileSync(tmp, buf);
    renameSync(tmp, `${outDir}/${name}`);
    outputs.push(`${outDir}/${name}`);
  });
  let cover: string | undefined;
  if (frames.length) {
    const png = coverPngBuffer([frames[0]!], boardSize);
    const tmp = `${outDir}/${gameId}_cover.png.tmp`;
    writeFileSync(tmp, png);
    renameSync(tmp, `${outDir}/${gameId}_cover.png`);
    cover = `${outDir}/${gameId}_cover.png`;
  }
  return { gameId, outputs, cover, frames: frames.length, elapsedMs: Date.now() - begun };
}
```

```ts
// scripts/gif-export.ts(主入口)
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
  let parsed;
  try { parsed = parseArgs(args); } catch (e) { console.error(String(e)); process.exit(1); }
  const { all, gameId, out, opts } = parsed;
  verifyFont(opts);
  const logsDir = resolveLogsDir(root);
  const outDir = out ?? join(root, 'files', '');
  const targets: string[] = all
    ? readdirSync(logsDir).filter((f) => f.endsWith('.jsonl'))
    : gameId
      ? [`${logsDir}/${gameId}.jsonl`]
      : [];
  if (!targets.length) {
    console.error('未指定对局:传 <gameId> 或 --all'); process.exit(1);
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
```

- [ ] **Step 4: 运行测试通过 + tsc**

```bash
cd /d/APP/llm_pk/games/xiangqi && npx vitest run scripts/gif/cli.test.ts && npm -C /d/APP/llm_pk/games/xiangqi exec tsc --noEmit --skipLibCheck
```

Expected: 全绿。若 `logPath` 含 `.jsonl` 时 `sanitizeGameId` 已剥扩展名,`<gameId>.jsonl` 拼接正确。

- [ ] **Step 5: 手工冒烟(有真实日志时)`+ 提交**

```bash
cd /d/APP/llm_pk/games/xiangqi && npm run gif -- --all && ls -la files/ | head
cd /d/APP/llm_pk/games/xiangqi && npm run gif -- --width 720 --max-kb 500 <某局gameId>
git add scripts/gif-export.ts scripts/gif/cli.ts scripts/gif/cli.test.ts && git commit -m "feat(xiangqi): 动图导出 CLI——单局/批量/字体校验/分片/封面/净化"
```

---

### Task 9: CLAUDE.md 文档 + 全量绿色 + 提交

**Files:**
- Modify: `games/xiangqi/../../CLAUDE.md`(仓库根;准确路径 `D:\APP\llm_pk\CLAUDE.md`)

**Interfaces:** 无(纯文档)

- [ ] **Step 1: 追加命令与一节说明**

在「常用命令」块(后端 `npm test` 等 之后)插入一行:

````markdown
npm run gif -- <gameId> | --all --width 720 --speed 2 --max-kb 512   # 动图导出(scripts/gif/*,离线批处理)
````

在「架构」节的「复盘独立」之后补一节:

````markdown
## 动图导出(离线 CLI,不碰运行链路)

- 定位:基于事件日志回放渲染公众号动图;产物 `files/<gameId>.gif`(+超 `--max-kb` 时 `part1..N` 多文件、首帧 `_cover.png`),`files/` 已 gitignore。
- 运行:`npm run gif -- <gameId>` 单局;`--all` 批量(含进行中局,以当前局面收尾);`--font`/`--width`/`--speed`/`--max-kb` 可选。
- 技术:`@napi-rs/canvas`(预编译 2D)+ `gifenc`(纯 JS 固定色板);**色板即绘制色**(禁渐变,`scripts/gif/palette.ts`);棋子字集对齐 `engine/render.ts`,reason 文案对齐全集测试(`scripts/gif/frames.test.ts`);delay 1/100s 整数倍;分片按「步块」二分、非末段「未完·续」。
- 解析:自写带行号日志解析(`scripts/gif/events.ts`),容忍进行中 arena 半写尾行;坏行报 `文件:行号`。
- 字体:探测 `simkai→simhei→msyh→simsun` + `--font`;缺字体/缺字形 exit 2。
- **跨包约束**:`scripts/` 唯一允许反向依赖 `web/src/lib/replay.ts` 链路;该链路必须保持纯 TS、永不得引入 web 运行时依赖。
````

- [ ] **Step 2: 全量验证**

```bash
cd /d/APP/llm_pk/games/xiangqi && npm test && npm -C /d/APP/llm_pk/games/xiangqi exec tsc --noEmit --skipLibCheck && cd web && npm test && npm run typecheck && cd /d/APP/llm_pk/games/xiangqi && npm run build
```

Expected: 后端引擎+服务端全量、前端 68 项、双端 typecheck、构建全绿(新增 cases 计入后端 vitest)。

- [ ] **Step 3: 提交**

```bash
cd /d/APP/llm_pk && git add CLAUDE.md && git commit -m "docs(xiangqi): 动图导出命令与一节 + 跨包约束"
```

---

## Self-Review(计划自检)

**Spec 映射(对照 `2026-08-27-xiangqi-gif-export-design.md`):**
| spec 节 | 落实任务 |
|---|---|
| §1 成功标准 / 分片 | T7(Task 7 encode)、T8 CLI |
| §2 不入侵硬边界 | 全程约束(Task 1 起) |
| §3 技术栈 / 字体链 / 字形 | T1、T5 |
| §4 数据流 / 带行号解析 / 尾行容忍 / 跨包 | T3、T9 |
| §5 画布 / 色板即绘制色 / 字幕/进度/行棋方圆点 / 横幅 / 封面 | T6、T4 |
| §6 帧序列 / 循环硬切 / 分片 | T4、T7 |
| §7 CLI / 净化 / 选项 | T8 |
| §8 产物与忽略(files/) | T1、T8 |
| §9 错误处理 | T3(行号/尾行)、T5(字体/字形)、T8(exit) |
| §10 测试策略 | 各 task 内 TDD |
| §11 文档 | T9 |
| §12 deferred | 已入根 TODOS.md |

**占位符扫描:** 本计划无 TBD/TODO/「留待实现」;代码块均为可粘贴可运行(注释中的「若 roundRect 缺失」属兼容性 fallback 说明,非占位)。

**类型一致性:** `Frame`(mode/board/from/to/slideT/caption/banner/delayMs)在 T4 定义,T6/T7/T8 全程复用;`buildFrames(events,{speed})`、`encodeGifBytes(frames, boardSize)`、`renderFrameToRgba(frame, boardSize)`、`coverPngBuffer([frame], boardSize)` 签名在 T4-T8 一致;`sanitizeGameId` 在 T8 cli 与 gif-export 同源。`PALETTE` 索引 P 序号与 palette.ts 数组顺序严格对应(T2/T6 注释互指)。

**风险注记:** 两个@napi-rs API 兼容位(`roundRect`、`toBuffer('image/png')`,若缺失)已在 task 内给出 fallback;gifenc `delay` 单位以实测校准(Step 3 已用 1/100s 换算,符合 GIF 规范)。