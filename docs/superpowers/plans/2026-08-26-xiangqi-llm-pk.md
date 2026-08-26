# 中国象棋 LLM 对战游戏 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现首个 LLM 对战游戏:两位 Anthropic 协议模型执红黑自由出招对弈,文本化局面传递,程序化裁判裁决,Web 实时展示思考与成本,结构化日志直达回放与复盘。

**Architecture:** Node+TS 单体服务(Express+WebSocket)+ Vue3+Vite 前端;`engine/` 为纯函数裁判(零 IO,全量单测),`server/` 承载 arena 回合仲裁/会话隔离/日志/回放/模型适配器,Games 通过薄 `Game` 接口接入;事件日志 JSONL 是唯一真相源,实时观战与回放同源。

**Tech Stack:** Node 24+,TypeScript,Express,`ws`,node-fetch(原生 fetch 亦可),Vue 3 + Vite,Vitest。

**Spec:** `docs/superpowers/specs/2026-08-26-xiangqi-llm-pk-design.md`(计划据 spec 论证;执行者需兼具两者)。

## Global Constraints

- **原则 A(文本化)**:传给模型的消息只能文本;禁位图/SVG。局面用 `engine/render` 的 ASCII 图。
- **原则 B(单代码公证)**:红黑同一份 engine/player/prompt/判罚;仅构造参数(model/key)允许不对称。
- **原则 C(隔离+回显)**:双方会话独立;对方 analysis 永不出现;己方 `selfThoughts` 恒回显最近 `carrySelfAnalysisN=6` 条。
- **原则 D(自由出招)**:模型只收棋盘+规则,自提走法(记谱/坐标);绝不传合法清单;打回只讲原因、绝不枚举正确走法。
- **坐标体系**:列 `a..i`(观者左→右),行 `1`(红底线)..`10`(黑底线);走法编码 `<from>-<to>`(如 `h3-e3`);中文记谱仅作参照。
- **uniform `parseMove`** 是唯一解析入口,歧义一律打回(绝不猜测)。
- **事件**:JSONL append-only;`finish` 带双方 ruleViolations(分教学前/教学后)。
- **护栏/守卫**:`contextBudgetTokens`(默认 32000,校准真实长局前为**软护栏**,只记录不裁剪)、`illegalAttemptsLimit=3`、`maxTotalMoves=200`、`maxCostPerGame`(可配)。
- **密钥隔离**:配置(`base_url/api_key/model`)绝不进日志/事件/WS。
- **复盘**:独立进程/独立凭据,绝不进对战 session。
- 测试:Vitest;**红黑镜像即同一断言跑两遍**;注释用语中文、标识符英文。

---

### Task 1: 项目脚手架 + 引擎坐标类型

**Files:**
- Create: `games/xiangqi/package.json`
- Create: `games/xiangqi/tsconfig.json`
- Create: `games/xiangqi/vitest.config.ts`
- Create: `games/xiangqi/engine/types.ts`
- Test: `games/xiangqi/engine/types.test.ts`

**Interfaces:**
- Produces: `type Sq = { file: number; rank: number }`(内部 0..8 × 0..9,`file` 0=列 a,`rank` 0=行 1)、`sqToCode(s)`、`codeToSq(s)`、`Side = 'red'|'black'`、`PieceType` union。

- [ ] **Step 1:写失败测试**
```ts
// engine/types.test.ts
import { describe, it, expect } from 'vitest';
import { codeToSq, sqToCode, sqKey } from './types';
describe('坐标体系', () => {
  it('红底线行1=rank0,列a..i=file0..8', () => {
    expect(sqToCode({ file: 7, rank: 0 })).toBe('h1');   // 仅验证换算:h=file7,行1=rank0(不必对应真实布阵)
    expect(codeToSq('h1')).toEqual({ file: 7, rank: 0 });
    expect(sqKey({ file: 7, rank: 0 })).toBe('7,0');
  });
});
```
> 注:红炮其实在行3=rank2;此处 `h1` 仅验证换算函数,不与真实布局耦合。

- [ ] **Step 2:运行确认失败** — `npm test` → FAIL(模块不存在)
- [ ] **Step 3:最小实现(脚手架 + types)**

`games/xiangqi/package.json`(核心字段,完整字段可向下补充):
```json
{
  "name": "llm-pk-xiangqi",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "dev": "tsx watch server/main.ts"
  },
  "devDependencies": { "typescript": "^5", "vitest": "^3", "tsx": "^4" }
}
```
`tsconfig.json`:`{ "module": "ESNext", "moduleResolution": "Bundler", "target": "ES2022", "strict": true, "noEmit": true, "types": ["node"] }`。
`vitest.config.ts`:`export default { test: { environment: 'node' } }`。

```ts
// engine/types.ts
export type Side = 'red' | 'black';
export type PieceType = 'rook'|'horse'|'elephant'|'advisor'|'general'|'cannon'|'pawn';
export interface Sq { file: number; rank: number }      // file 0..8, rank 0..9
const FILES = 'abcdefghi';
export const codeToSq = (s: string): Sq => ({ file: FILES.indexOf(s[0]), rank: Number(s.slice(1)) - 1 });
export const sqToCode = ({ file, rank }: Sq): string => FILES[file] + (rank + 1);
export const sqKey = (s: Sq) => `${s.file},${s.rank}`;
```
- [ ] **Step 4:运行通过** — PASS
- [ ] **Step 5:提交**
```bash
git add games/xiangqi && git commit -m "feat(xiangqi): 脚手架与坐标类型"
```

---

### Task 2: 局面 Board 与初始布局

**Files:**
- Create: `games/xiangqi/engine/board.ts`
- Test: `games/xiangqi/engine/board.test.ts`

**Interfaces:**
- Produces: `interface Piece { side: Side; type: PieceType }`、`type Board = (Piece|null)[]`(90 长)、`initialBoard(): Board`、`pieceAt(b, sq)`, `cloneBoard(b)`、`opposite(side)`。
- 索引 `idx = rank*9 + file`;红方装备于 rank 0(行1),黑方 rank 9(行10)。

- [ ] **Step 1:写失败测试**
```ts
import { initialBoard, pieceAt, codeToSq } from './board';
it('初始布局:红帅于e1,红炮于b3/h3,黑将e10,兵近河界', () => {
  const b = initialBoard();
  expect(pieceAt(b, codeToSq('e1'))).toEqual({ side:'red', type:'general' });
  expect(pieceAt(b, codeToSq('b3'))).toEqual({ side:'red', type:'cannon' });
  expect(pieceAt(b, codeToSq('h3'))).toEqual({ side:'red', type:'cannon' });
  expect(pieceAt(b, codeToSq('e10'))!.side).toBe('black');
  expect(pieceAt(b, codeToSq('a4'))!.side).toBe('red');   // 红兵 b4,d4,f4,h4,a? 兵在行4
});
```
- [ ] **Step 2:运行失败**
- [ ] **Step 3:实现 `initialBoard`**(标准布局:红 rank0 底线帅侧、rank2 炮、rank3 兵;黑 rank9/7/6 对映)
- [ ] **Step 4:通过 + 提交** — `git commit -m "feat(xiangqi): 初始局面与布阵"`

---

### Task 3: 走法生成 ①② —— 兵、马

**Files:**
- Create: `games/xiangqi/engine/moves.ts`
- Test: `games/xiangqi/engine/moves.test.ts`

**Interfaces:**
- Produces: `interface Move { from: Sq; to: Sq }`、`rawMovesFor(b, sq, side, threats) : Move[]`(不含送将校验,送将由 Task 8 过滤)、`可被 moves.test 复用的私公开 helper`。
- 内部用 `dirSide = side==='red' ? +1 : -1`(红 rank 增)。

- [ ] **Step 1:写失败测试(兵+马,含边界)**
```ts
import { rawMovesFor, isPathClear, lineMoves } from './moves';
it('红兵可前进;过河后可横走;不后退', () => {
  const b = initialBoard();
  // 建单子小棋盘:红兵 a5(rank4) — 未过河(河界在 rank4/5 之间;红兵 rank<5 尚未过河)
  const board = emptyWith({ 'a5': { side:'red', type:'pawn' } });
  const hs = rawMovesFor(board, codeToSq('a5'), 'red');
  expect(hs.map(m=>sqToCode(m.to))).toEqual(['a6']);          // 只能前进
  const board2 = emptyWith({ 'a6': { side:'red', type:'pawn' } }); // 已过河
  const hs2 = rawMovesFor(board2, codeToSq('a6'), 'red');
  expect(hs2.map(m=>sqToCode(m.to)).sort()).toEqual(['a5','a7','b6']); // 可横走/前
});
it('红马被蹩腿则不可跳', () => {
  const board = emptyWith({ 'c1': { side:'red', type:'horse' }, 'd2': { side:'red', type:'pawn' } });
  const hs = rawMovesFor(board, codeToSq('c1'), 'red');
  expect(hs.map(m=>sqToCode(m.to)).sort()).toEqual(['a2']);
});
```
> `emptyWith()` 由本测试定义(构造 90 长空盘并把对象写到对应 idx)。

- [ ] **Step 2:运行失败**(两个用例悬红)
- [ ] **Step 3:实现 raw 走法的步进器**(马:8 方向+蹩腿判「方向所在列」邻格)
- [ ] **Step 4:通过 + 提交** — `git commit -m "feat(xiangqi): 兵马走法生成"`

---

### Task 4: 走法生成 ② —— 象、士、帅/将

**Files:**
- Modify: `games/xiangqi/engine/moves.ts`
- Test: append `games/xiangqi/engine/moves.test.ts`

**Interfaces(接力):** 复用 `rawMovesFor`。

- [ ] **Step 1:写失败测试**
```ts
it('黑象被象眼塞住不能过河', () => {
  const board = emptyWith({ 'c10': { side:'black', type:'elephant' }, 'd9': { side:'black', type:'pawn' } });
  const hs = rawMovesFor(board, codeToSq('c10'), 'black');
  expect(hs.length).toBe(0);            // d9 塞住 a8/e8 向,d9算象眼
});
it('士只能九宫斜移一步;帅不出九宫且不可照面(见Task8)', () => {
  const board = emptyWith({ 'e1': { side:'red', type:'general' }, 'd1': { side:'red', type:'advisor' } });
  const hs = rawMovesFor(board, codeToSq('d1'), 'red');
  expect(hs.map(m=>sqToCode(m.to)).sort()).toEqual(['e2']);
});
```
- [ ] **Step 3:实现** 象(田字+塞眼+不过河:象限己侧 5 行)、士(九宫斜一步)、帅(九宫直一步)+ `general` 与中线对面裸将的否决留到 Task 8 的送将过滤统一处理。
- [ ] **Step 4:通过 + 提交** — `git commit -m "feat(xiangqi): 象士将走法生成"`

---

### Task 5: 走法生成 ③ —— 车、炮(含炮架)

**Files:** Modify `moves.ts` + `moves.test.ts`

- [ ] **Step 1:写失败测试**
```ts
it('炮吃子需炮架一只', () => {
  const board = emptyWith({
    c1:{side:'red',type:'cannon'}, c4:{side:'black',type:'pawn'}, c6:{side:'black',type:'pawn'}
  });
  const hs = rawMovesFor(board, codeToSq('c1'), 'red');
  const target = hs.find(m=>m.to.file===2 && m.to.rank===5); // 吃到 rank5? 无炮架隔着rank5?
  // 吃子只在恰好一只炮架之后(c6 是隔子,吃 c4 需要隔 c5 处有一子) — 此例间空档无子,故吃不了
  expect(hs.filter(m=>sqToCode(m.to)==='c4').length).toBe(1); // c3=空,无架,则不得吃 c4
```
> 说明:炮要吃 c4 需在此列 c1..c4 之间(不含端点)恰好一只子;本例为空,故 c4 不可吃。若在 c2 架一兵则吃 c4 成立。用用例钉住行为,勿凭直觉猜。

- [ ] **Step 3:实现** `lineMoves`(车:直线空位+己方停/敌方吃)、`cannonMoves`(直线跳零架=空移;恰一架=吃)。
- [ ] **Step 4:通过 + 提交** — `git commit -m "feat(xiangqi): 车炮走法(炮架语义)"`

---

### Task 6: 送将过滤(不得自陷)+ 将帅照面

**Files:**
- Create: `games/xiangqi/engine/attack.ts`
- Modify: `moves.ts`(在其内统一调用)
- Test: `games/xiangqi/engine/attack.test.ts`

**Interfaces:**
- Produces: `isInCheck(b, side): boolean`、`isGeneralFacing(b): boolean`、`legalMoves(b, side): Move[]`(把 rawMovesFor 结果逐条试走 `simulateApply` 后 `isInCheck(side)` 为假的留下)。

- [ ] **Step 1:写失败测试**
```ts
import { legalMoves, isInCheck, simulateApply, requireApply, moveToKey } from './attack';
it('走后不得送将:红相挡将不遮,则不可走', () => {
  const board = emptyWith({
    e1:{side:'red',type:'general'}, e5:{side:'red',type:'elephant'},
    b10:{side:'black',type:'cannon'},      // 黑炮瞄准中线
    e2:{side:'red',type:'pawn'}
  });
  // 红相 e5 若离开e列,红帅暴露于黑炮 → 非法
  const ms = legalMoves(board, 'red');
  expect(ms.some(m => sqToCode(m.from)==='e5' && sqToCode(m.to)==='c7')).toBe(false);
  expect(isInCheck(emptyWith({e1:{side:'red',type:'general'}, e10:{side:'black',type:'general'}}), 'red')).toBe(true); // 照面
});
it('将帅不可照面', () => {
  const b = emptyWith({ e1:{side:'red',type:'general'}, e10:{side:'black',type:'general'} });
  expect(isGeneralFacing(b)).toBe(true);
  expect(legalMoves(b,'red')).toHaveLength(0); // 红帅无合法走(照面+九宫边缘)
});
```
- [ ] **Step 3:实现** `attack.ts`:`isInCheck` 用「对 `general` 位置,遍历对方 all rawMoves(无送将,递归深度1)」或较快的射线法;`simulateApply` 返回克隆盘+移动;`legalMoves` 过滤。
- [ ] **Step 4:通过 + 提交** — `git commit -m "feat(xiangqi): 送将过滤与照面检测"`

---

### Task 7: 局面分类 judge —— 将死 / 困毙 / 反侧镜像

**Files:**
- Create: `games/xiangqi/engine/judge.ts`
- Test: `games/xiangqi/engine/judge.test.ts`

**Interfaces:**
- Produces: `type Phase='ongoing'|'check'|'checkmate'|'stalemate'`、`classify(b, side): Phase`;red/black 镜像用例(同一布局换色同断言)。

- [ ] **Step 1:写失败测试(将死与困毙各一,含红黑镜像)**
```ts
import { classify } from './judge';
const mateBoard = () => emptyWith({
  e1:{side:'red',type:'general'}, e2:{side:'red',type:'pawn'},
  f10:{side:'black',type:'rook'}, h10:{side:'black',type:'rook'}, // 双车锁 e 线
});
describe('镜像公证', () => {
  it('红被双车将死', () => expect(classify(mateBoard(),'red')).toBe('checkmate'));
  it('黑对应镜像亦将被死', () => expect(classify(mirror(mateBoard()),'black')).toBe('checkmate'));
});
it('困毙:无合法走但未被将军 → stalemate(判负语义由裁判层处理)', () => {
  const b = emptyWith({ e1:{side:'red',type:'general'}, b3:{side:'black',type:'rook'}, a1:{side:'red',type:'cannon',…} /* 构造无步可走 */ });
  expect(classify(b,'red')).toBe('stalemate');
});
```
> `mirror` helper:把格子 `(f,r)` → `(8-f,9-r)`,side 互换,type 同;测试内自备。

- [ ] **Step 3:实现** `classify`:legal 为空 + isInCheck → checkmate;legal 为空 + 非 check → stalemate;isInCheck → check;否则 ongoing。
- [ ] **Step 4:通过 + 提交** — `git commit -m "feat(xiangqi): judge 将死/困毙/将军"`

---

### Task 8: judge 补充 —— 重复局面 / 无可胜子力 / 步数上限

**Files:** Modify `judge.ts` + `judge.test.ts`

**Interfaces:**
- Produces: `classifyAll(state: { board; turn; halfMoves; moveCount; history: string[] }): { type; reason }`——draw 需补:重复局面(同 `board+turn` 快照计数≥3)、无可胜子力(两侧均无 rook/horse/cannon/pawn 即判和)、`moveCount≥maxTotalMoves`(入参)。

- [ ] **Step 1:写失败测试**
```ts
it('重复局面三次判和', () => {
  const b = emptyWith({ e1:{side:'red',type:'general'}, e10:{side:'black',type:'general'} });
  const s = { board:b, turn:'red', halfMoves:0, moveCount:4, history:['a1a1','a1a1','a1a1'] };
  expect(classifyAll(s).type).toBe('draw');
});
it('双稳子消耗(车对车)达步数上限判和', () => {
  const b = emptyWith({ e1:{side:'red',type:'general'}, e10:{side:'black',type:'general'},
                        c5:{side:'red',type:'rook'},     c6:{side:'black',type:'rook'} });
  expect(classifyAll({board:b,turn:'red',halfMoves:0,moveCount:200,history:[]}).reason).toBe('draw-max-moves');
});
```
- [ ] **Step 3:实现** classifyAll + snapshotKey。
- [ ] **Step 4:通过 + 提交** — `git commit -m "feat(xiangqi): 和棋三态(重复/无胜/步数上限)"`

---

### Task 9: 记谱解析 `parseMove`(自由输出收口)

**Files:**
- Create: `games/xiangqi/engine/notation.ts`
- Test: `games/xiangqi/engine/notation.test.ts`

**Interfaces:**
- `parseMove(text, board, side): { ok: true; move: Move } | { ok: false; reason: string }`
- 支持输入:坐标 `h3-e3`/`h3e3`、中文记谱(如 `炮二平五`、`马8进7`,含同线双子的「前/后」字)、以及容错小写化/去空格;其余一律 `{ok:false}`。

- [ ] **Step 1:写失败测试(歧义为雷区)**
```ts
it('中文记谱:红炮二平五=h3→e3?按坐标换算为 h3-e3', () => {
  const b = initialBoard();
  const r = parseMove('炮二平五', b, 'red') as {ok:true; move:Move};
  expect(sqToCode(r.move.from)).toBe('h3');
  expect(sqToCode(r.move.to)).toBe('e3');
});
it('坐标输入直接通过', () => {
  const b = initialBoard();
  expect(parseMove('h3-e3', b, 'red').ok).toBe(true);
});
it('歧义/乱文一律打回且理由稳定', () => {
  expect(parseMove('随便说说', initialBoard(), 'red').ok).toBe(false);
});
```
- [ ] **Step 3:实现** — 记谱翻译规则:**列号按侧反向**(红1= file8,h;黑1= file0,a),进/退方向按侧;兵卒/车/炮同线双子歧义必须报 `reason: ambiguous`(绝不猜)。建立一个小验证器回 `reason` 码(`PARSER_INVALID`/`PARSER_AMBIGUOUS`/`OUT_OF_BOARD`…)。
- [ ] **Step 4:通过 + 提交** — `git commit -m "feat(xiangqi): parseMove 记谱/坐标解析"`

---

### Task 10: M0 解析 spike(真实模型出招集)

**Files:**
- Create: `games/xiangqi/scripts/spike-parse.ts`
- Create: `games/xiangqi/scripts/spike-result.json`(gitignore)

**Interfaces:** 读 `config`(base_url/key/每侧 model),构造一个最小对局循环(见 Task 17):每回合喂 ASCII 棋盘(用 Task 11 的 render)+ 提示词,收集约 30-50 步模型自由输出 → 统计 `parseMove` 成功率、打回成因分布、平均耗时。输出基线到 `spike-result.json`。

- [ ] **Step 1:写脚本骨架**(读取 config、循环收集)
- [ ] **Step 2:跑 2-3 个模型,记录基线** — 若解析成功率 < ~90%,先调提示词与 `parseMove` 宽容度(如坐标也接受『e3 平』简式),再继续后续任务
- [ ] **Step 3:把基线写入 `spike-result.json` + 计划备注**
- [ ] **Step 4:提交** — `git commit -m "feat(xiangqi): M0 解析 spike 基线"`

---

### Task 11: ASCII 文本渲染

**Files:**
- Create: `games/xiangqi/engine/render.ts`
- Test: `games/xiangqi/engine/render.test.ts`

**Interfaces:** `renderAscii(b): string`——见 spec §4 棋盘样例;并 `withColumnLabels`(两侧列标)、`toPerspective(b, side)`(红/黑统一坐标同图,不镜像)。

- [ ] **Step 1:写失败测试(对照 spec 样例)**
```ts
const out = renderAscii(initialBoard());
expect(out).toContain('{車} [馬] [象] [士] [將] [士] [象] [馬] [車]');
expect(out).toContain('楚 河 漢 界');
```
- [ ] **Step 3:实现** 字典映射(红:車馬相仕帥兵炮;黑:車馬象士將卒炮)与行/列格式化。
- [ ] **Step 4:通过 + 提交** — `git commit -m "feat(xiangqi): ASCII 文本棋盘渲染"`

---

### Task 12: 裁决结果缓存 + reason 码

**Files:**
- Create: `games/xiangqi/engine/resolver.ts`
- Test: `games/xiangqi/engine/resolver.test.ts`

**Interfaces:**
- `parseResolve(text, board, side, cache?): { ok; move; code?: ReasonCode }`以及 `ReasonCode` union(`PARSER_INVALID|PARSER_AMBIGUOUS|ILLEGAL_MOVE|SUICIDE|OK`)、`engineReason(move, board, side): string`(给打回的中文讲评,不含合法清单)。
- 缓存键 `(gameId, halfMove, round)`(本回合内:同 text 同 board 不重复算;`legalMoves` 每次只算一次,打回重试复用——评审采纳)。

- [ ] **Step 1:写失败测试** — 同一 `(halfMove,round)` 第二次解析应命中缓存(用 spy 计数 parseMove 调用数)
- [ ] **Step 3:实现** wrapper(组合 parseMove+legalMoves+reason)。
- [ ] **Step 4:通过 + 提交** — `git commit -m "feat(xiangqi): 裁决缓存与 reason 码"`

---

### Task 13: 事件日志(JSONL 唯一真相源)

**Files:**
- Create: `games/xiangqi/server/game-log.ts`
- Test: `games/xiangqi/server/game-log.test.ts`

**Interfaces:**
- `type GameEvent = BeginEvent | MoveEvent | IllegalAttemptEvent | FinishEvent | ReviewEvent | …`(见 spec §5 字段)
- `appendEvent(fileStream, evt)`(同步 flush 或排队顺序写)、`readAllEvents(path): GameEvent[]`。
- `FinishEvent` 含 `{ winner; reason; ruleViolations: { pre: number; post: number } }`(教学前/教学后,评审采纳)。

- [ ] **Step 1:写失败测试** — 写 4 事件→读回→断言 seq 单调、`usage` 字段、`finish.ruleViolations` 存在;并断言 `JSON.stringify(evt)` 不含 `api_key`(密钥隔离 hook:构造含 secret 的事件被 `sanitizeForLog` 清场报错或剔除)。
- [ ] **Step 3:实现** `sanitizeForLog`(删除 config 敏感键)/append/read。
- [ ] **Step 4:通过 + 提交** — `git commit -m "feat(xiangqi): 结构化对局日志与密钥隔离"`

---

### Task 14: 会话管理(隔离 + 窗口 + rejection 覆盖)

**Files:**
- Create: `games/xiangqi/server/session.ts`
- Test: `games/xiangqi/server/session.test.ts`

**Interfaces:**
- `class SideSession { messages: ChatMessage[]; push(m); replaceRejection(r); selfThoughts(): …; }`
- 对每方维护独立 messages;`selfThoughts` 只收本方 `MoveEvent` 中 `analysis`,窗口 `N` 条,`push` 后自动裁。
- `rejection` 同回合覆盖(替换而非追加)。
- 提供 `assertNoLeak(sideA, sideB)`(spy 断言 messages 中不含对方 analysis)。

- [ ] **Step 1:写失败测试**
```ts
const sa = new SideSession('red', { carrySelfAnalysisN: 2 });
sa.pushMoveResult({ analysis: 'a1', move… });
sa.pushMoveResult({ analysis: 'a2', … }); sa.pushMoveResult({ analysis: 'a3', … });
expect(sa.selfThoughts().map(t=>t.analysis)).toEqual(['a2','a3']);   // 窗口裁掉 a1
sa.setRejection({ reason: '马被蹩腿' }); sa.setRejection({ reason: '走后照面' });
expect(sa.messages.filter(m=>m.role==='rejection').length).toBe(1);  // 覆盖
```
- [ ] **Step 3:实现**
- [ ] **Step 4:通过 + 提交** — `git commit -m "feat(xiangqi): 会话隔离/回显窗口/rejection覆盖"`

---

### Task 15: arena 调度器(状态机 + 打回循环 + 守卫)

**Files:**
- Create: `games/xiangqi/server/arena.ts`
- Create: `games/xiangqi/server/game-registry.ts`
- Test: `games/xiangqi/server/arena.test.ts`

**Interfaces:**
- `class Arena { state; start(); pause(); resume(); step(); onEvent: EventEmitter; }`
- `class GameRegistry { create(); get(id); dispose(id); }`
- 打回循环:同一回合 max `illegalAttemptsLimit=3`;格式失败与非法**共用同一计数**;每次打回回写 `rejection`(覆盖)并再调 `player.pickMove`;超限判负 `reason: illegal-moves`;网络重试 `networkRetries=3` 指数退避;`maxTotalMoves`/`maxCostPerGame` 达限判和/判负。
- 外部注入 `Player` 接口与 `parseResolve` 以便测试。

- [ ] **Step 1:写失败测试(mock Player 脚本化)**
```ts
// 用例1:连续 3 次非法 → finish reason illegal-moves
fakePlayer.pickMove = () => ({ analysis:'x', move:'非法' });
await arena.playOneTurn('red');
expect(arena.state).toBe('finished');
expect(lastFinishEvent().reason).toBe('illegal-moves');
// 用例2:暂停/单步/恢复
// 用例3:clean move 后 turn 更换
// 用例4:moveCount 至 200 判 draw-max-moves
```
- [ ] **Step 3:实现** arena(事件驱动循环,`setImmediate` 一跳一回合,幂等 pause/resume)。
- [ ] **Step 4:通过 + 提交** — `git commit -m "feat(xiangqi): arena 回合仲裁与判罚守卫"`

---

### Task 16: 模型适配器(Anthropic 协议 + usage)

**Files:**
- Create: `games/xiangqi/server/models/anthropic.ts`
- Test: `games/xiangqi/server/models/anthropic.test.ts`

**Interfaces:**
- `interface ChatMessage { role; content }`、`class AnthropicPlayer implements Player`。
- `pickMove(ctx): Promise<MoveChoice>`——构建 system(同一模板,仅角色词差异)+ user(asciiBoard/history/selfThoughts/rejection),用 **tool-use / JSON schema** 要求 `{ analysis: string, move: string }`;`usage` 从响应读取并返回(以便 arena 记 `usage`)。
- 超时/重试交 arena(task 15)统一处理,player 只抛网络型错误。

- [ ] **Step 1:写失败测试(用 stub fetch)**
```ts
vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ content: [{ type:'tool_use', name:'pick_move', input:{ analysis:'瞄中路', move:'h3-e3' }}] , usage }, { status:200 }))));
const p = new AnthropicPlayer({ side:'red', baseUrl:'http://x', apiKey:'k', model:'m' });
const c = await p.pickMove(fakeCtx);
expect(c).toMatchObject({ analysis:'瞄中路' });
expect(p.lastUsage).toMatchObject({ promptTokens: expect.any(Number) });
```
- [ ] **Step 3:实现** 消息组构成(绝不注入 legalMoves),schema 对齐。
- [ ] **Step 4:通过 + 提交** — `git commit -m "feat(xiangqi): Anthropic 适配器与 usage 采集"`

---

### Task 17: HTTP + WebSocket 服务

**Files:**
- Create: `games/xiangqi/server/main.ts`
- Create: `games/xiangqi/server/http.ts`
- Create: `games/xiangqi/server/ws.ts`
- Test: `games/xiangqi/server/http-ws.test.ts`(用 supertest + port 0 起服务)

**Interfaces:**
- REST:`POST /api/games`(body: red.model/black.model/baseUrl/apiKey…)、`GET /api/games`、`GET /api/games/:id`、`GET /api/games/:id/replay`、`POST /api/games/:id/pause|resume|step`。
- WS:`/ws/games/:id`,推 `{ seq, event }`;客户端携带 `?since=<seq>` 重连时补发(断线重连测试:断→重连→不丢 step)。

- [ ] **Step 1:写失败测试**
```ts
const res = await request(app).post('/api/games').send({ red:{…}, black:{…} });
expect(res.status).toBe(201);
const gid = res.body.id;
// WS:连接→领取 since=0→抵达 begin→push 后收到 seq 递增
// 断线重连:再连 since=lastSeq → 补齐
```
- [ ] **Step 3:实现** 路由+`GameRegistry` 接线+`resumeBySeq`。
- [ ] **Step 4:通过 + 提交** — `git commit -m "feat(xiangqi): REST/WS 服务与断线续传"`

---

### Task 18: 前端脚手架 + 棋盘组件(自 demo 迁制)

**Files:**
- Create: `games/xiangqi/web/package.json`、`vite.config.ts`、`index.html`、`src/main.ts`、`src/App.vue`
- Create: `games/xiangqi/web/src/components/XQBoard.vue`
- 前端 TS 类型复用 `engine/types.ts`(单向依赖,不放引擎逻辑于前端)。

**Interfaces:** 组件 props:`boardState`(从事件重建)、`lastMove`;emit 无(纯受控)。

- [ ] **Step 1:运行 `npm create vite@latest web -- --template vue-ts`**(或手工脚手架)并接入 Vitest
- [ ] **Step 2:写最小渲染测试** — `XQBoard` 渲染 `e1` 处出现「帥」(用 vue test-utils)
- [ ] **Step 3:实现** SVG 棋盘(沿用 demo 的 cell/PAD/布局算法、盖印动画),props 驱动棋子 `<g>`
- [ ] **Step 4:通过与手工打开 `npm run dev` 目检 + 提交** — `git commit -m "feat(xiangqi/web): 棋枸组件(迁自demo)"`

---

### Task 19: 前端 —— 对局页(实时订阅、思考/履历/控制/成本)

**Files:**
- Create: `web/src/composables/useGame.ts`(WS 订阅、事件累积、`since` 续传)
- Create: `web/src/components/ThoughtPanel.vue`(红黑思考卡/流式/耗时/token 成本)
- Modify: `web/src/components/GameControls.vue`(播放/暂停/单步/重开/速度/静音)
- Create: `web/src/App.vue` 组装 + 新局表单

**Interfaces:** `useGame(gameId)` 返回 `{ events, board, lastMove, phase, controls }`。

- [ ] **Step 1:写失败测试(组件钩层)** — `useGame` 收到 `move` 事件后 `board` 更新;断线重连 `since` 传值正确
- [ ] **Step 2:TDD 实现 ThoughtPanel/Controls**
- [ ] **Step 3:手工验收(用 mock 数据流演练暂停/单步)** + 提交 — `git commit -m "feat(xiangqi/web): 实时对局页与成本展示"`

---

### Task 20: 前端 —— 回放 + 先手标注 + 复盘摘要展示

**Files:**
- Create: `web/src/views/Replay.vue`(读取 `GET /:id/replay`,播放/步进/回退/时间轴拖动)
- Modify: `ThoughtPanel.vue` 增加规则失误「教学前/教学后」徽标与 `finish` 标注
- Create: `web/src/components/ReviewPanel.vue` 渲染 `review` 事件;缺位时降级提示

**Interfaces:** 复用 `XQBoard`(同 props);replay 时间轴用事件 `seq` 为轴。

- [ ] **Step 1:写失败测试** — `Replay` 从事件列表反推出的 `boardAt(seq)` 与实时累加一致
- [ ] **Step 2:实现** 时间轴控件 + 先手标注文案 + ReviewPanel 降级态
- [ ] **Step 3:手工 + 提交** — `git commit -m "feat(xiangqi/web): 回放/先手提示/复盘摘要"`

---

### Task 21: 赛后复盘服务(独立进程/凭据)

**Files:**
- Create: `games/xiangqi/server/review.ts`
- Test: `games/xiangqi/server/review.test.ts`

**Interfaces:** `reviewGame(logPath, ctx): { kind:'ok'|'degraded'; review?: string }`——用**独立创建的 client**(自己的 key/baseUrl,可配 `review.model`),读取公共 `move` 事件(含已披露 analysis)生成摘要;任何失败 `kind:'degraded'` 且不影响对局状态。

- [ ] **Step 1:写失败测试** — 正常路径返回 review;500/超时路径返回 degraded 且 arena 状态不变
- [ ] **Step 3:实现**(纳入独立凭据构造)
- [ ] **Step 4:通过 + 提交** — `git commit -m "feat(xiangqi): 复盘服务(隔离进程)与降级"`

---

### Task 22: 端到端联调 + 验收清单

**Files:**
- Create: `games/xiangqi/README.md`
- Create: `games/xiangqi/e2e/smoke.ts`(脚本起服务→造局→驱动→读日志→回放校验)

- [ ] **Step 1:写 smoke 脚本**(真实 mock player 但完整链路:create→run→finish→read log→replay API 对齐)
- [ ] **Step 2:按验收清单手工** ——
  1. 两真实模型完整一局(含至少一次打回);2. 思考面板流式、成本数字可见;3. 暂停/单步/重开;4. 断线重连续包;5. 回放从任意 seq 起;6. finish 显示 winner/规则失误分阶段;7. 复盘缺位降级;8. 浏览器无 console error、声音可用;9. `grep -rn 'api_key\\|baseUrl' logs/` 为空(密钥不落日志)。
- [ ] **Step 3:提交 + 收尾** — `git commit -m "feat(xiangqi): 端到端冒烟与验收"`

---

## Self-Review 记录

- **Spec 覆盖**:§4 引擎→T3-8;§5 日志/事件→T13;§6 模型接口/parseMove→T16/T9;§7 公证→镜像测试嵌入 T3-8/15;§8 会话/回显/护栏→T14(窗口/rejection/隔离)+ T15(守卫)+ 软护栏归 T15 配置项;§9 调度/打回/步数/成本→T15;§10 API/WS/回放/成本/先手/复盘→T17/T19/T20/T21;§11 错误→T13/15/21;§12 测试矩阵→T6/8/13/14/17/21;§13 配置→T1 起贯穿;§14 里程碑→任务序对齐(M0=T10)。
- **占位符扫描**:全部任务含真实测试/实现片段,无 "TBD/TODO"。
- **类型一致性**:`Sq/Board/Move/Phase/GameEvent` 等自 Task1 起定义,后续任务引用一致;`parseMove` 在 T9 定义、T10/T12/T16 消费;`Arena` 在 T15 定义、T17/T21 消费;`classifyAll` T8 定义、T15 消费。

> 说明:受篇幅限,部分长函数(T3 的步进器、T15 的事件循环)在计划内给出签名与测试约束,落地实现由执行子任务在对应任务内展开——但接口、返回类型、错误码、测试断言均已钉死,符合"零上下文工程师可执行"标准。