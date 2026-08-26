# 中国象棋 · LLM 对战游戏设计文档

- **项目**:llm-pk / games/xiangqi
- **日期**:2026-08-26
- **状态**:设计定稿,待审阅
- **关联约束**:本游戏必须满足 `README.md` 中的四大通用约定(规则清晰胜负分明、多角色 Web 展示、详细日志、可回放)。

---

## 1. 概述与目标

首个"由大语言模型直接对战(PK)"的游戏:**中国象棋**。两位 LLM 分别执红、执黑,在同一个公平裁判(象棋引擎)的监督下逐回合对弈;对局通过 Web 页面实时展示双方的思考过程;全程结构化落日志,支持回放与复盘。

首版范围(核心规则,已在方案阶段确认):

- 完整的走法合法性(七个兵种、不得送将、九宫/河界约束);
- 胜负判定:**将死**、**困毙**、走法非法/超时判负;
- 和棋简化:**重复局面判和**、**双方均无可胜子力判和**(不作竞赛级长将长捉精确裁定)。

## 2. 设计原则(本项目不可妥协的三条)

> 这三条由用户明确提出,优先级高于其余所有设计细节。

### 原则 A:一切传递给 LLM 的信息都是**文本**

我们的模型大多不是多模态模型,不能"看"棋盘图片。因此:

- 局面一律渲染为 **ASCII 文本棋盘**,用字符表示棋子(红/黑分色);
- 棋步一律用 **结构化文本坐标**表达;
- 禁止把位图/截图/SVG 图像放入模型请求。

### 原则 B:公证优先——双方使用**完全同一份代码**

对局双方在代码层面没有任何差异化路径:

| 公共部分 | 要求 |
|---|---|
| 引擎(判定) | 唯一的 `engine/` 模块,红黑用同一份逻辑,无 `side` 分支裁决 |
| 棋手适配器 | 唯一的 `AnthropicPlayer` 实现,红黑仅传入不同构造参数(角色名) |
| 提示词模板 | 唯一模板,只允许因 `红/黑` 角色而出现的文本差异(角色声明、执先/执后),杜绝任何"黑方更宽容"类分支 |
| 超时/重试/判罚 | 同参数量级,红黑对称 |
| 局面文本渲染 | 统一坐标,同一渲染函数,仅打印 `(红)`/`(黑)` 标签 |

**唯一允许的不对称**:红黑模型选择(`red.model`/`black.model`、各自的 base_url/key)。这正是 PK 的意义。

### 原则 C:上下文严格隔离

- 红、黑各自维护**独立的会话上下文**,互不可见;
- 任何一方**都不能**读到:对方的思考内容、对方的历史消息、裁判的未公开状态;
- **思考过程处理**:每方"自己上一步的思考"是否回显给该方自己,作为设计决策,见 §8(默认开启,可通过配置关闭)。

## 3. 架构总览(方案 A:单体应用)

一个 Node+TS 进程承载全部后端能力,前端为 Vue3+Vite 独立目录;引擎在代码层面保持纯函数、零 IO、零框架依赖并配独立单测。

```
games/xiangqi/
├── package.json / tsconfig.json / vite.config.ts
├── engine/                        # 纯函数裁判引擎(原则 B 的中心)
│   ├── types.ts                   # 棋子/坐标/局面/走法 类型
│   ├── board.ts                   # 局面初始化、国内外坐标换算
│   ├── moves.ts                   # 七个兵种走法生成、合法性(含不得送将)
│   ├── judge.ts                   # 将死/困毙/自杀、和棋判定
│   ├── render.ts                  # 局面 → ASCII 文本棋盘(原则 A)
│   ├── notation.ts                # 坐标 ↔ 中文记谱(参照展示)
│   └── __tests__/                 # Vitest 单测
├── server/
│   ├── main.ts                    # Express + WebSocket 启动,装配依赖
│   ├── arena.ts                   # 调度器:回合仲裁、状态机、超时/重试
│   ├── session.ts                 # 双方独立会话上下文管理(原则 C)
│   ├── game-log.ts                # append-only JSONL 事件日志
│   ├── replay.ts                  # 日志 → 回放事件序列
│   └── models/anthropic.ts        # Anthropic 协议客户端(single class)
├── web/                           # Vue3+Vite 前端(SVG 棋盘、思考面板、记谱、回放)
├── config.example.json / .env.example
├── logs/                          # 对局日志(.gitignore)
│   └── <gameId>.jsonl
└── README.md
```

统一坐标体系(供引擎、文本棋盘、走法列表、日志共通):

- **列**:观者视角从左到右 `a b c d e f g h i`;
- **行**:红方底线为 `1`,向黑方递增至黑方底线 `10`;
- **走法编码**:`<from>-<to>`,如红方「炮二平五」= `h3-e3`;文本中也附中文记谱作为参照。

## 4. 象棋引擎(裁判)

- 局面表示:`BoardState` = `Board[90]` + `turn` + `halfMove` + 必要历史(用于重复局面)。
- 纯函数 API:
  - `legalMoves(state, side) → Move[]`
  - `applyMove(state, move) → { state, captured? } | throws`
  - `classify(state) → { type: 'ongoing' | 'check' | 'checkmate' | 'stalemate' | 'draw' }`
- 判定细节:
  - 走法合法性含**不得送将**(走完不得使己方将军被吃或裸帅将对面);
  - **将死**:行棋方处于被将军状态且无任何合法应将;
  - **困毙**:行棋方无合法走法且未被将军 → 判负(中国象棋规则困毙为负);
  - **重复局面**:同一局面(相同棋盘 + 当前行棋方)累计出现 N 次 → 和棋(N 初值 3,可配);
  - **无可胜子力**:双方均无「进攻子力」(车、马、炮、兵、卒)残留,即仅剩将/帅与仕/相级防守子力 → 判和(实施期以此为准,可扩展)。
- render.ts 示例文本棋盘(执黑视角同为该 ASCII 图,统一坐标):

```
    a   b   c   d   e   f   g   h   i
10  [車] [馬] [象] [士] [將] [士] [象] [馬] [車]  黑(顶)
 9  .   .   .   .   .   .   .   .   .
 8  .   [砲] .   .   .   .   .   [砲] .
 7  [卒] .   [卒] .   [卒] .   [卒] .   [卒]
 6  .   .   .   .   .   .   .   .   .
 5  ─────────────── 楚 河 漢 界 ─────────────
 4  [兵] .   [兵] .   [兵] .   [兵] .   [兵]
 3  .   [砲] .   .   .   .   .   [砲] .
 2  .   .   .   .   .   .   .   .   .
 1  [車] [馬] [相] [仕] [帥] [仕] [相] [馬] [車]  红(底)
```

## 5. 对局模型与事件日志

- **唯一真相源**:一次对局 = 一条 append-only JSONL 日志;实时观战与回放都由日志事件重建。
- 事件类型:`begin`、`move`、`check`、`captured`、`draw`、`finish`(winner+reason)、`illegal-move`、`retry`、`timeout`、`error`、`player-message`(思考)。
- `move` 事件示例:

```jsonc
{ "seq": 12, "ts": "2026-08-26T20:11:33.120Z", "type": "move", "turn": "red",
  "move": { "from": "g3", "to": "g6", "notation": "炮二平五" },
  "analysis": "先手架中炮,意在直取中路……", "elapsedMs": 2314,
  "legal": true }
```

- 思考内容(`analysis`)写入日志,用于复盘,但**不对对方可见**(原则 C)。

## 6. 棋手模型接口与文本化交互(原则 A)

```ts
interface Player {
  readonly side: Side;                                        // "red" | "black"
  pickMove(ctx: MoveContext): Promise<MoveChoice>;
}
interface MoveContext {
  side: Side;
  asciiBoard: string;        // render.ts 输出的文本棋盘(统一坐标)
  legalMoves: { from: string; to: string }[];   // 合法走法清单(统一坐标)
  history: string[];         // 双方已走记谱(公共信息)
  carrySelfAnalysis: boolean;// 是否附带己方此前思考(原则 C)
}
interface MoveChoice { analysis: string; move: { from: string; to: string } }
```

`AnthropicPlayer` 实现:

1. 以 `system` 说明角色(红/黑)、规则边界、输出要求——**同一份模板**,仅角色词不同;
2. 用 **tool-use / JSON schema** 强制结构化输出 `{analysis, move}`;
3. 把 `asciiBoard`、`legalMoves`(带记谱参照)、`history` 置于 `user` 消息;
4. 解析输出后交由引擎校验;非法则按 §9 回退策略处理。

**明确禁止**:向请求中注入位图、截图、SVG;局面信息只能走文本通道。

## 7. 公证性保证(原则 B 的落地清单)

- 引擎 `engine/` 全部纯函数,判定史上过一次代码;单测以"红走"与"黑走"镜像对同断言,防止 side 相关性;
- 服务器只有一条 `AnthropicPlayer` 类,红黑实例化仅参数不同;
- 提示词:唯一的 `buildSystemPrompt(side)` / `buildUserPrompt(ctx)`,diff 检查保证除 `红/黑`、`执先/执后` 文本外零差异;
- 超时、重试次数、退避、判罚滥用同一常量与同一策略函数;
- 回合顺序由引擎 `turn` 决定,调度器不得偏爱任一方;
- 对局日志中出现任何"同一局面两种裁决"即视为 bug,单测覆盖。

## 8. 上下文隔离设计(原则 C 的具体化)

**会话模型**:`session.ts` 为每方维护独立的对话消息数组:

```
session.red = [ systemPrompt(红), ...历史(公共移动序列), 当前回合(棋盘+走法清单) ]
session.black = [ systemPrompt(黑), ...历史(公共移动序列), 当前回合(棋盘+走法清单) ]
```

隔离边界:

| 数据项 | 对红方 | 对黑方 |
|---|---|---|
| 红方的历史消息与思考 | ✓ | ✗ |
| 黑方的历史消息与思考 | ✗ | ✓ |
| 对方的思考内容(analysis) | ✗ | ✗ |
| 公共走法记谱序列 | ✓ | ✓ |
| 当前局面 ASCII | ✓ | ✓ |
| 裁判内部状态 | ✗ | ✗ |

**思考回显决策(用户提出的不确定点)**:有意识地**默认开启**`carrySelfAnalysis = true`——把**己方上一步的 analysis** 作为附注回传给自己,使模型能延续自己的推理链(不同模型的"自省连续性"差异本就是 PK 看点),因此它**写日志但不给对方**;

- 隔离性不受影响:回显仅在本方自己的会话内;
- **可关闭**:`config.game.carrySelfAnalysis=false` 时完全不带任何思考,仅局面+走法清单,便于对照实验;
- 成本/token 与收益平衡在实施期用真实对局观察,结论记入本游戏 README。

## 9. 调度器(arena)

状态机:

```
idle → running →(pause)⇄(resume / step)running → finished
```

每回合:`引擎.legalMoves` → `session[side].push(当前问题)` → `player.pickMove` → `engine` 校验 → `applyMove` / `classify` → 写事件广播 → 换 side。

异常与判罚(对双方完全对称):

| 情形 | 处理 |
|---|---|
| 网络超时/5xx | 指数退避重试 3 次(参数统一),期间前端"思考中" |
| 输出 JSON 解析失败 | 回告错误重试 1 次 |
| 走法不在合法清单 | 回告"非法走法,请从清单选择"重试 1 次 |
| 仍失败 / 超限 | **判该方负** `reason: timeout | illegal`,正常收尾并留痕 |

控制接口:`POST /api/games/:id/pause|resume|step`(step 仅在暂停态可用)。

## 10. Web 展示、API 与回放

- REST:`GET/POST /api/games`、`GET /api/games/:id`、`GET /api/games/:id/replay`、控制端点;
- WebSocket `/ws/games/:id`:增量推流事件,断线按 `seq` 补发;
- 前端(沿用 demo 的视觉语言与 SVG 棋盘):
  - 棋盘 + 最后一步高亮 + 盖印动效;
  - 双方思考卡片:`thinking…/分析流式输出`、耗时、累计用时;
  - 记谱履历(悬停显示各步思考)、回合/步数/用时;
  - 播放/暂停/单步/重开、速度、**静音开关**、结束横幅;
- 回放:`replay.ts` 从日志重建事件序列,前端提供播放/步进/回退/时间轴拖动;回放与实时同源。

## 11. 错误处理与鲁棒性

- 模型超时/非法输出:见 §9 表;进程崩溃:日志已落盘,可基于日志恢复回放,不做自动续赛;
- 服务器与前端错误统一格式:`{ error: { code, message, hint } }`,界面文案基于 `hint`;
- 空目录/缺配置:给出明确错误与配置示例。

## 12. 测试策略

- **引擎单测**(优先级最高):七兵种走法、过河/不得送将/九宫/河界、将帅照面、将军与应将、将死、困毙、重复局面、无胜子和棋;每类红黑镜像断言(公证性);
- **服务集成测试**:mock `Player`(脚本化走法),验证回合流程、日志落盘、暂停/单步、非法判负、隔离(构造 spy 断言一方上下文绝不含对方 analysis);
- 真实 Anthropic 冒烟脚本(需 key)供手动联调;声音/渲染为前端手工验收部分。

## 13. 配置与运行

```bash
npm install
# config: base_url / api_key / red.model / black.model / carrySelfAnalysis / drawRepeat / timeoutMs …
npm run dev      # 后端 + Vite 前端;打开 localhost:5173
```

对局日志落 `games/xiangqi/logs/<gameId>.jsonl`(目录在 `.gitignore`)。

## 14. 里程碑

1. 引擎(规则+判定)+ 单测 → 2. 会话/日志/调度器 + 集成测试 → 3. Anthropic 棋手适配器(文本化提示词)→ 4. REST/WS 服务 → 5. Vue 前端(沿用 demo 视觉)→ 6. 端到端联调 + 真实对局验收。