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
- 和棋简化:**重复局面判和**、**双方均无可胜子力判和**、**步数上限判和**(默认 200 半回合,可配);不作长将长捉精确裁定——**向模型明示**本局采用简化裁定,避免预期不一致。

**核心理念(用户明确决定,最高优先级之一)**:模型要**像真正的棋手一样独立思考**——它只看到棋盘,自主提出走法(以自由表达方式,如中文记谱"炮二平五"或坐标),由裁判代码校验合法性;不合规则会被**打回并记录**——模型对规则的掌握本身就是被测评的能力,计入指标。**绝不**向模型提供合法走法清单让它挑选。

## 2. 设计原则(本项目不可妥协的三条)

> 这三条由用户明确提出,优先级高于其余所有设计细节。

### 原则 A:一切传递给 LLM 的信息都是**文本**

我们的模型大多不是多模态模型,不能"看"棋盘图片。因此:

- 局面一律渲染为 **ASCII 文本棋盘**,用字符表示棋子(红/黑分色);
- 系统内部棋步一律用 **结构化文本坐标**表示(`h3-e3`);模型侧允许自由表达(记谱/坐标),由 `parseMove` 收口归一;
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

### 原则 D:棋手式自由出招——规则掌握是被测评的能力

- 模型只接收**棋盘与规则说明**,自行提出走法,不接受任何"合法走法清单";
- 走法解析与合法性校验**全部由确定性裁判代码**完成(§4、§6);
- 非法/不可解析的走法被**打回**(reject),打回信息只解释原因、**绝不泄露"哪个才是合法走"**,否则模型高考打回逆向推出清单,原则就被架空了;
- 每方被打回次数(`ruleViolations`)作为**测评指标**记入日志与 UI,联同胜负一起回答"它懂多少规则"。对红黑完全对称。

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
│   ├── game-registry.ts           # 多局并存:Map<gameId, ArenaSession>(每局一实例)
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

### Game 接口(平台化的第一步,本期已批准)

本项目定位是"LLM 对弈擂台"集合,而非单款象棋。为实现第二个游戏时不必重构,新增**最小对弈协议**,象棋作为它的第一个实现:

```ts
interface Game<State, Move> {
  initialState: () => State;
  legalMoves:    (s: State) => Move[];
  render:        (s: State) => string;      // 纯文本渲染(原则 A)
  apply:         (s: State, m: Move) => State;
  classify:      (s: State) => MoveResult;  // ongoing/check/checkmate/stalemate/draw
  meta:          { name: string; sides: string[]; drawRule: string };
}
```

本期**不建**真正的多游戏引擎/目录,但所有依赖(调度器、日志、回放、前端)只吃这个接口 + 文本渲染,不做象棋特判——让第二个游戏接进来时只新增一个实现文件,零改动调度骨架。

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
  - **无可胜子力**:双方均无「进攻子力」(车、马、炮、兵、卒)残留,即仅剩将/帅与仕/相级防守子力 → 判和(实施期以此为准,可扩展);
  - **步数上限(外审采纳)**:双方总半回合数达 `maxTotalMoves`(默认 200,可配)→ 判和 `reason: draw-max-moves`——防耗局无限、成本失控。
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
- 事件类型:`begin`、`move`、`check`、`captured`、`illegal-attempt`(打回:含 `round`/`reason`/`violations` 增量)、`draw`、`finish`(winner + reason + 双方 `ruleViolations`)、`retry`、`timeout`、`error`、`player-message`(思考)。
- `move` 事件示例:

```jsonc
{ "seq": 12, "ts": "2026-08-26T20:11:33.120Z", "type": "move", "turn": "red",
  "move": { "from": "h3", "to": "e3", "notation": "炮二平五" },
  "analysis": "先手架中炮,意在直取中路……", "elapsedMs": 2314,
  "usage": { "promptTokens": 1840, "completionTokens": 212, "costUsd": 0.0031 },
  "legal": true }
```

`usage` 取自 Anthropic 响应的 usage 字段,展示"思考成本指标"(本期已批准),是评估模型效率的关键数据,写入日志不进入任一方上下文。

- 思考内容(`analysis`)写入日志,用于复盘,但**不对对方可见**(原则 C);
- 每方被打回次数(`ruleViolations`)、每次打回的 `reason` 均入日志,是"规则掌握度"测评指标(原则 D)。

## 6. 棋手模型接口与文本化交互(原则 A)

```ts
interface Player {
  readonly side: Side;
  pickMove(ctx: MoveContext): Promise<MoveChoice>;   // 单次请求;打回报复循环由 server 侧控制
}
interface MoveContext {
  side: Side;
  asciiBoard: string;         // render.ts 输出的文本棋盘(统一坐标)
  history: { move: string; notation: string }[];  // 双方已走历史:统一绝对坐标 + 中文记谱,不因方属镜像
  selfThoughts: { move: string; analysis: string }[];  // 己方最近 N 步思考(窗口截断,仅己方可见)
  rejection?: { round: number; reason: string };   // 本回合若曾被拒,携带最近一次打回原因
}
interface MoveChoice { analysis: string; move: string; } // move 为自由文本:中文记谱(炮二平五)或坐标(h3-e3)
```

**历史视角(外审采纳)**:`history` 一律用**统一绝对坐标**(与棋盘同一标度),两侧收到完全相同的记录序列,不用"黑方视角记谱"——规避单侧记谱歧义与双解析入口;中文记谱仅作旁注参照。

`AnthropicPlayer` 实现:

1. `system` 用**同一份模板**说明角色、**完整中国象棋规则**(蹩腿、塞象眼、不得送将、应将、记谱约定……)、**本局简化裁定说明**(多次重复判和、步数上限、无长将长捉)与输出要求;**只允许"红/黑、执先/执后"的文本差异**;
2. 用 **tool-use / JSON schema** 强制输出 `{analysis, move}`,其中 `move` 是自由文本(不限定格式);
3. `user` 消息含 `asciiBoard` 与 `history`;若本回合曾被拒,再附最近一次 `rejection{ reason }`;
4. 输出交给唯一解析入口 `engine.notation.parseMove(text, state, side) → {ok, move, reason}`,解析与合法性校验全在此处完成,结果按 §9 打回循环处理。

**明确禁止**:向请求中注入位图/截图/SVG;把 `legalMoves` 清单序列化进任何 `user` 消息;打回原因里"枚举合法走法"。

## 7. 公证性保证(原则 B 的落地清单)

- 引擎 `engine/` 全部纯函数,判定史上过一次代码;单测以"红走"与"黑走"镜像对同断言,防止 side 相关性;
- 服务器只有一条 `AnthropicPlayer` 类,红黑实例化仅参数不同;
- 提示词:唯一的 `buildSystemPrompt(side)` / `buildUserPrompt(ctx)`,diff 检查保证除 `红/黑`、`执先/执后` 文本外零差异;
- 超时、重试次数、退避、判罚滥用同一常量与同一策略函数;
- 走法解析入口唯一(`engine.notation.parseMove`,见 §6),红黑同一实现:解析不出的记谱一律走打回,绝不猜测;打回文案同一模板;`illegalAttemptsLimit` 红黑同参;
- 回合顺序由引擎 `turn` 决定,调度器不得偏爱任一方;
- 对局日志中出现任何"同一局面两种裁决"即视为 bug,单测覆盖。

## 8. 上下文隔离设计(原则 C 的具体化)

**会话模型**:`session.ts` 为每方维护独立的对话消息数组:

```
session.red = [ systemPrompt(红·含规则说明), ...历史(公共移动序列), 当前回合(棋盘 + [打回原因]) ]
session.black = [ systemPrompt(黑·含规则说明), ...历史(公共移动序列), 当前回合(棋盘 + [打回原因]) ]
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

**思考回显决策(用户拍板:默认恒开)+ 上下文长度管理(用户拍板)**:己方思考**默认且恒回显**——棋手记住自己为何走到这里,不同模型的"自省连续性"差异正是 PK 看点。回显仅在本方会话内,**绝不给对方**。

- **回显窗口**:`carrySelfAnalysisN`(默认 6,可配)。只回传最近 N 步自己 analysis,更早丢弃;
- **上下文长度(关键工程点)**,四条配合保证长局不失控:
  1. 历史采用**紧凑记谱**(每步一行),不重发整盘棋盘,只发当前棋盘;
  2. analysis 用上述**窗口截断**,旧思考不无限累积;
  3. 护栏 `contextBudgetTokens`(默认 32000,须小于所用模型窗口):超预算先从最旧 analysis 剪,再则从历史尾部截断并记录提示;——**校准真实长局之前仅作软护栏(记录超预算观测、不硬裁剪)**,校准后再启用硬裁剪(外审采纳);
  4. **可观测**:每方会话 token 用量取自 response usage,写入日志与 UI,实施期据真实对局校准默认值;
- 不做"关闭回显"的常规开关(对照实验如需,临时把窗口设 0)。

## 9. 调度器(arena)

状态机:

```
create ─► idle ─(start)─► running ─(move完成)─► …running…
             ▲              │  ▲
             │ (resume/step) └──┘ (pause)
             └────────────────┘
  running ─(finish / draw / 判负)─► finished(终态,不可写)
```

每局一个 `ArenaSession` 实例,由 `game-registry.ts` 注册/销毁;WS/REST 按 `gameId` 路由到对应实例。回合数据流(含打回循环):

```
ArenaSession          Player(model)
 state,turn ─render──►┌──────────────┐
   当前棋盘/history/    │ 自由思考,自提走法│
   selfThoughts窗口/   └──────┬───────┘
   rejection?                │ {analysis, move文本}
             ┌───────────────▼───────────────┐
             │ engine.notation.parseMove      │
             │   → 合法性校验(legalMoves)     │
             └───────────────┬───────────────┘
   非法 → rejection{reason}(同回合覆盖最新一条)
        ← 再调一次 Player(附该 reason)
   合法 → applyMove → judge → 写事件(append JSONL)
        → WS 广播 → 换 turn → 重复
   finish/draw/判负 → finished(不可写)
```

**并发(评审已批准)**:`game-registry.ts` 以 `Map<gameId, ArenaSession>` 管理多局并存;每局独立实例、独立状态机,互不污染;`/ws/games/:id` 与 REST 均按 `gameId` 路由。

异常与打回/判罚(对双方完全对称):

| 情形 | 处理 |
|---|---|
| 输出结构解析失败或走法文本不可解析(`parseMove` 失败) | **打回**:回告 parser 原因(如"无法理解你的走法,请用中文记谱或 a3-c3 形式"),计入统一打回计数 |
| 解析成功但走法非法(不在 `legalMoves`) | **打回**:回告**具体规则原因**(如"马被蹩腿""走后将帅照面"——源于 `engine.reason(move)`),**绝不枚举合法走法**;`ruleViolations++`,同时计入统一打回计数 |
| 同一回合连续打回达 `illegalAttemptsLimit`(默认 3) | **判该方负** `reason: illegal-moves`,正常收尾留痕 |
| 网络超时/5xx | 指数退避重试 3 次(参数统一,网络层),期间前端"思考中" |
| 网络重试超限 | **判该方负** `reason: timeout`,正常收尾留痕 |

- **打回 ≠ 异常**:是调试过程中的正常回合;UI 展示"被裁判打回一次"并可回看原因;
- **同回合打回消息覆盖(评审已批准)**:`session[side]` 中每回合只保留**最新一条** `rejection{ reason }`(覆盖前一条),避免多轮打回造成会话膨胀与旧错误信息干扰;
- 每次打回都以 `rejection{ reason }` 呈现"裁判的讲解",帮助模型下次走对——但**不含"正确答案枚举"**;
- **每回合只算一次裁决**(评审建议):`parseMove`+`legalMoves` 结果按 `(gameId, halfMove, round)` 缓存,打回重试时复用,避免重复计算;
- **格式失败与非法走法共用打回计数器**(外审采纳)——消灭"重试 vs 打回"双计数歧义;
- 终局事件 `finish` 携带双方 `ruleViolations` 作测评维度;**分阶段展示(评审采纳)**:区分「首次打回前失误(教学前)」与「被拒后重犯(教学后)」两个计数,UI 与日志都分开展示——诚实回应"初始规则知识 + 局中辅导"的混叠;
- **成本/步数守卫(外审采纳)**:`maxCostPerGame`(可配,默认不设)与 `maxTotalMoves` 生效时,对局以 `reason: draw-max-moves | cost-limit` 友好收尾并留痕,不猝杀。

控制接口:`POST /api/games/:id/pause|resume|step`(step 仅在暂停态可用)。

## 10. Web 展示、API 与回放

- REST:`GET/POST /api/games`、`GET /api/games/:id`、`GET /api/games/:id/replay`、控制端点;
- WebSocket `/ws/games/:id`:增量推流事件,断线按 `seq` 补发;
- 前端(沿用 demo 的视觉语言与 SVG 棋盘):
  - 棋盘 + 最后一步高亮 + 盖印动效;
  - 双方思考卡片:`thinking…/分析流式输出`、耗时、累计用时;
  - 记谱履历(悬停显示各步思考)、回合/步数/用时;
  - 播放/暂停/单步/重开、速度、**静音开关**、结束横幅;
  - **先手标注(外审采纳)**:单局结果旁标注『单局·未换色,胜负不作模型强弱结论』,避免先手优势误导;
- 回放:`replay.ts` 从日志重建事件序列,前端提供播放/步进/回退/时间轴拖动;回放与实时同源(实施时做"回放 vs 实时双跑 diff"测试,确保回放无重演偏差);回放链路(评审新增图):

```
<gameId>.jsonl ──► replay.ts ──► 逐事件重建(无状态纯函数,不触 arena 实例)
  append-only       ▲             ├─ 棋盘渲染(与实时同一 render)
                    │             ├─ 思考/耗时/token 成本展示
 WS 实时(seq 增量)──┘             └─ 时间轴(播放/步进/回退/拖动)
 与回放共用同一事件序列 ⇒ 严格同源
```
- **思考成本展示(本期已批准)**:UI 每步显示耗时 + token + 折算成本($US),顶部汇总本局总计,供评估比较;
- **赛后 AI 复盘摘要(本期已批准)**:`POST /api/games/:id/review` 或自动在对局终局后异步生成——由专用审查模型(可配,可能与对局模型无关)阅读公共日志(含各步已披露的 analysis,不含任何私有上下文),输出关键转变/失误要点;结果作为 `review` 事件追加进日志与展示;摘要生成失败不影响对局,**绝不**回写对弈上下文(原则 C);**复盘模型以独立进程/独立凭据构造(外审采纳)**,确认绝不进入任何对战 session。

## 11. 错误处理与鲁棒性

- 模型超时/非法输出:见 §9 表;**打回是正常控制流**,不计入 `error` 事件,只写 `illegal-attempt`;
- 进程崩溃:日志已落盘,可基于日志恢复回放,不做自动续赛;
- `parseMove` 的所有失败原因都有稳定 `reason` 码,UI 文案基于码渲染;
- 服务器与前端错误统一格式:`{ error: { code, message, hint } }`,界面文案基于 `hint`;
- 空目录/缺配置:给出明确错误与配置示例。

## 12. 测试策略

- **引擎单测**(优先级最高):七兵种走法、过河/不得送将/九宫/河界、将帅照面、将军与应将、将死、困毙、重复局面、无胜子和棋;每类红黑镜像断言(公证性);
- **记谱解析单测**(原则 D 的核心):`parseMove` 覆盖中文记谱(含同线双车需"前/后"字、同名子歧义)、坐标格式、非法文本、红黑两向;歧义走法一律解析失败走打回(绝不猜测);
- **服务集成测试**:mock `Player` 脚本化走法,验证回合流程、日志落盘、暂停/单步;**连续非法 → 打回循环与 `illegalAttemptsLimit` 上限判负**;spy 断言打回 `reason` 中不含任何合法走法串;`ruleViolations` 进入 `finish`;隔离(断言一方上下文绝不含对方 analysis);
- **评审新增测试矩阵(评审已批准并入)**:
  1. **会话管理测试** — `contextBudgetTokens` 超预算时的裁剪顺序(先剪旧 analysis 再截历史)与 `carrySelfAnalysisN` 窗口截断行为;
  2. **WS 断线重连测试** — 断线后按 `lastSeq` 增量续传、不丢步;
  3. **密钥隔离断言** — 事件与日志全程不含 config 的敏感字段;
  4. **摘要降级测试** — 审查模型超时/500 时,对局正常结束、摘要缺位不阻塞、UI 降级提示;
  5. **回放↔实时双跑 diff(评审采纳:提前)**:自 M2(日志/调度集成测试)即开始,不等联调;
- **M0 解析 spike(外审采纳,第 0 里程碑)**:写引擎前先用 2-3 个真实模型跑 30-50 步,统计 `parseMove` 成功率与打回成因分布,产出基线;若解析成功率不达标,先回调解析宽容度与提示词,再开始正式实现;
- 真实 Anthropic 冒烟脚本(需 key)供手动联调;声音/渲染为前端手工验收部分。
- **性能(评审无阻塞)**:引擎兵种枚举 O(90),每回合裁决缓存复用;LLM 调用延迟主导观感,不构成代码性能热点。

## 13. 配置与运行

```bash
npm install
# config: base_url / api_key / red.model / black.model / carrySelfAnalysisN(默认6) /
#            contextBudgetTokens(默认32000,校准前为软护栏) / drawRepeat /
#            illegalAttemptsLimit(默认3) / networkRetries(默认3) / timeoutMs /
#            maxTotalMoves(默认200判和) / maxCostPerGame(可选成本守卫)
npm run dev      # 后端 + Vite 前端;打开 localhost:5173
```

对局日志落 `games/xiangqi/logs/<gameId>.jsonl`(目录在 `.gitignore`)。

**密钥与配置分层(评审已批准,硬性条款)**:`config` 的 `base_url / api_key` 只存在于 `.env`/`config.json`,仅在**构造模型客户端时**被读取;**绝不**序列化进事件、日志、WS 消息或任何对外 payload;日志写入器对事件对象执行敏感字段黑名单断言(见 §12 测试)。**例外**:`model` 名可进入 `begin` 事件——它是评估与复盘识别红黑所用模型的关键标识,非密钥。

## 14. 里程碑

0. **M0 解析 spike**(真实模型出招集,统计 parseMove 成功率与打回成因)→ 1. 引擎(规则+判定)+ 单测 → 2. Game 接口封装 + 会话/日志/调度器 + 集成测试(含回放↔实时双跑 diff)→ 3. Anthropic 棋手适配器(文本化提示词 + usage 采集)→ 4. REST/WS 服务 → 5. Vue 前端(沿用 demo 视觉,含思考成本展示 + 先手标注)→ 6. 赛后 AI 复盘摘要(独立审查进程)→ 7. 端到端联调 + 真实对局验收。

## 15. 本期外(TODOS)

由 CEO 评审记录,未进本期:

- 批量对局匹配(同配置赛 N 局并汇总胜率);
- 对局分享链接(每局唯一 URL);
- 一键复跑(固定随机种子/同配置确定性重跑)。

以上入 `TODOS.md` 台账,实施计划不包含,避免范围蔓延。