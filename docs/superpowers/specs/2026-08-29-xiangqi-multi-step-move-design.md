# 单步多轮交互出招(mode: multi) · 设计文档

日期:2026-08-29
状态:**已搁置(deferred)**--阶段 0 探针证伪核心假设 R1(见 §9 搁置记录);设计本身完整保留,若未来模型/档位变化可重启评估
关联设计:[2026-08-26-xiangqi-llm-pk-design.md](./2026-08-26-xiangqi-llm-pk-design.md)

## 0. 范围决策记录(用户已逐项拍板,不再重议)

| 来源 | 决策 | 状态 |
|---|---|---|
| 决策点 1 | `mode` 为 `config.json` **顶层**参数(`"single"` \| `"multi"`,缺省 single);红黑**强制同 mode**,无单边配置 | ✅ 已拍板(方案 A) |
| 决策点 2 | 重试粒度三场景:a) 阶段截断各自走 G3c 重发;b) ④输出非法只重跑④(最多 2 次,超限走 arena 现有打回循环);c) ①候选全被过滤带「换一批」重跑①(最多 2 次,超限**整步回退 single 模式**) | ✅ 已拍板 |
| 决策点 3 | `selfThoughts` 回显**只含阶段④最终 analysis**;`carrySelfAnalysisN` 语义不变,中间阶段产物不跨步 | ✅ 已拍板(方案 A) |
| 决策点 4 | 日志**只增不改**:`move.analysis` = ④产出(与 single 同构);新增可选 `stages` 摘要字段;中间原文仅落 `debug_logs/`(现有机制,零新代码);前端流式思考按阶段加标签(`【侦察】/【评估】/【定稿】`) | ✅ 已拍板 |
| 决策点 5 | 流水线**不继承**顶层 128000 托底;阶段各自独立小上限,配置化初值 ①8292 / ③16384 / ④8292,G3c 重发兜底 | ✅ 已拍板 |

## 1. 概述与动机

**动机**:GLM-5.3 系在 effort max 下推理无自然上界(单步 64k+ token、824s+),max_tokens 只能当断路器用(截断-重发),治标不治本。根因是单次调用把**模式识别、深度验证、最终决策**三个认知任务压进一条无终点的推理流。

**方案**:把一步棋分解为 3 次 LLM 调用 + 1 次免费引擎过滤。每个子任务有天然的工作量终点——「列 3 个候选」不需要 64k 推理,「从已评估清单里选一个」也不需要。分步不是限制模型能力,而是给能力找到有终点的出口。

**成功标准**:
- mode=multi 下,单步墙钟时间与 token 成本相对 single 模式(GLM-5.3 max 档)显著下降(目标:<1/3),且打回率不升;
- 双方流水线代码、prompt 模板、阶段上限完全对称(原则 B 不破);
- single 模式零行为变化(385 项现有测试全绿,不改出招路径);
- 日志格式向后兼容(老日志可读,新字段缺省容忍)。

**前置验证(阶段 0,实现前必跑)**:核心假设是「小任务提示在 max 档下推理量小」。探针脚本 `scripts/probe-stages.mjs`(已写好)以真实中局局面+侦察 prompt 打方舟端点,验证:finish=tool_calls(非 length)、completion tokens 显著小于单步全推演。**若假设不成立(侦察也要烧 50k+),先调 scoutTokens 与任务定义再实现,方案骨架不变。**

## 2. 范围与不入侵(硬边界)

**改到**:
- `server/http.ts`:`mode`/`mode_multi` 配置解析 + PlayerFactory 按 mode 分流;
- `server/models/` 新增 multi 流水线实现(新文件);
- `server/models/openai.ts` / `anthropic.ts`:**仅**抽公开可复用的传输/解析原语(见 §7),出招路径行为不变;
- `server/session.ts` 或 arena 组装处:multi 模式下 selfThoughts 注入④产出(实现落点见 §7);
- `server/game-log.ts`:`move` 事件可选 `stages` 字段类型;
- 前端 `web/src/composables/useGame.ts` + 展示组件:阶段标签(纯前缀文本,无协议改动);
- `config.example.json`、`CLAUDE.md`、`AGENTS.md`:文档同步。

**绝不改**:
- `engine/*` 全部(过滤阶段是引擎的**新消费者**,不是引擎的改动);
- 事件日志既有字段的语义与格式(`move.analysis`/`usage`/`seq` 流);
- WS 帧协议(`player-message` 通道不变,只在文本内容加前缀);
- single 模式下两个 Player 适配器的请求构造与解析行为;
- 回放/GIF 链路(`web/src/lib/replay.ts` 零改动;GIF 只读 `move.analysis` 自动兼容);
- 密钥红线、sanitizeForLog、debug-log 目录结构与文件命名。

## 3. 流水线总览

```
arena.playTurn(side) ──► Player.pickMove(ctx)          [接口不变!arena 无感知]
                             │
              mode=single    │    mode=multi
             (现有 Player)   ▼
                      MultiStepPlayer(包装底层传输原语)
                             │
   ① 侦察 scout      LLM 调用 1:「列 3 个候选着法,各 1-2 句理由,勿深算」
                             │  输出: candidates[3] {move, reason}
   ② 过滤 filter     引擎(免费):parseResolve 逐个验合法;去重;剔除己方非法
                             │  输出: legalCandidates[1..3]
   ③ 评估 evaluate   LLM 调用 2:「对每个合法候选,各推演对手最可能的 2 种应手,
                             │   评估吃子/将军/防守缺口」 输出: evaluations[1..3]
   ④ 定稿 decide     LLM 调用 3:「从已评估合法候选中选定最终着法」
                             │  输出: pick_move {analysis, move}(与 single 同构)
                             ▼
                    MoveChoice{analysis, move, usage=Σ三阶段, elapsedMs=Σ}
```

- **②是确定性代码,零成本零延迟**,正是象棋引擎「生成-搜索」两段式的 LLM 翻版;
- **合法性前置**:④只能从引擎已验证的候选里选(打回率结构性下降);
- 三阶段的每次调用都走现有 debug-log/debug_logs 与流式 onThought 通道(天然成档、天然推流)。

## 4. 各阶段详规

### 阶段① 侦察(scout)

- **任务**:`列出此刻最值得考虑的 3 个候选着法,各 1-2 句理由;不要深度推演,不要走完整变例`。
- **输入**:与 single 相同的局面上下文(ASCII 棋盘 + 记谱历史 + 己方 selfThoughts),系统提示词为规则卡 + 侦察任务说明。
- **输出契约**:结构化工具 `propose_candidates`,参数 schema:
  ```json
  { "candidates": [ { "move": "h3-e3", "reason": "..." } ] }   // 恰 3 个(允许 2-4 容差)
  ```
  move 用坐标格式(解析层与 single 的 `parseMove` 同一入口,中文记谱也接受)。
- **上限**:`scoutTokens`(默认 8192)。
- **失败处理**:截断/无工具输出/解析失败 -> G3c 式带「请精简」重发(计入阶段 attempt);连续 2 次失败 -> 决策点 2 的整步回退 single。

### 阶段② 过滤(filter,免费)

- **实现**:对①的每个候选跑 `engine` 的 `parseMove` + `resolve`(与 arena 打回**同一入口、同一语义**);
- 合法候选去重(同坐标);数量 1-3;
- **全部被过滤** -> 带「上次候选均不合法:<原因>,请换一批」重跑①(决策点 2-c),2 次后回退 single;
- 过滤结果(合法数/非法数/非法原因)并入 `stages` 摘要与重跑提示。

### 阶段③ 评估(evaluate)

- **任务**:`对以下 N 个合法候选逐一评估:吃子潜力/将军威胁/防守缺口/离场风险;每个候选推演对手最可能的 2 种应手并给出简短应对结论`。
- **输入**:局面上下文 + ②的合法候选清单(**程序注入,防幻觉**);
- **输出契约**:工具 `evaluate_candidates`,参数 schema:
  ```json
  { "evaluations": [ { "move": "h3-e3", "verdict": "好棋|可下|有风险", "lines": "简短推演", "score": -2..+2 } ] }
  ```
- **上限**:`evaluateTokens`(默认 16384);
- **失败处理**:同①(G3c 重发,2 次后回退 single)。

### 阶段④ 定稿(decide)

- **任务**:`基于以下评估结论,选定最终着法`——**就是现有 pick_move 语义**,提示词带候选清单+评估结论(程序注入);
- **输出契约**:现有 `pick_move` 工具 `{analysis, move}`——**与 single 模式完全同构**,下游(arena/日志/前端/GIF)零适配;
- analysis 为观众可读的最终叙述(选择+主理由,长度自估);
- **上限**:`decideTokens`(默认 8192);
- **失败处理**(决策点 2-b):move 不在合法候选集合内/为空 -> 只重跑④,提示带「只能从 N 个已评估候选中选择」+违规原因,最多 2 次;超限返回空 move,交 arena 现有打回循环(与 single 同语义,`illegalAttempts` 计数照常)。

### 整步回退 single(兜底出口)

- 触发:①连续 2 轮失败(解析/全过滤),或③连续 2 轮失败;
- 行为:本步直接走现有 single 路径(一次全推演,继承 single 的 max_tokens 语义=顶层托底);
- `stages` 记 `{fallback: true, reason}`,回退本身**不是失败**,不打回、不计非法。

## 5. 配置设计

```jsonc
// config.json 顶层
{
  "mode": "multi",              // "single"(缺省) | "multi";红黑强制同 mode
  "mode_multi": {               // 缺省全走默认值;整块可省
    "scoutTokens": 8192,
    "evaluateTokens": 16384,
    "decideTokens": 8192
  }
}
```

- **校验**:`mode` 只认 `single`/`multi`,未知值启动报错(不静默回退,吸取方舟档位静默映射的教训);
- `mode_multi` 数值必须 ≥1;请求体**不提供** mode 覆盖(对局模式是对局级决策,防误配不对称);
- **优先级明确**:multi 流水线内阶段上限 = `mode_multi.*`,**不穿透** profile/顶层 max_tokens(决策点 5);single 模式 max_tokens 语义完全不变(profile > 顶层托底);
- 超时:每阶段各自享有现有 `timeoutMs` 配置(阶段任务更小,实际耗时更短;极端 3×30min 上限可接受,不在本期收缩)。

## 6. 日志、事件与前端

**`move` 事件(只增字段)**:
```jsonc
{
  "type": "move", "turn": "red", "move": {...}, "analysis": "④产出(同 single 形态)",
  "usage": { ...Σ三阶段之和, costUsd 求和 }, "elapsedMs": Σ,
  "stages": [                                    // 可选;single 模式事件无此字段
    { "name": "scout",    "attempt": 0, "elapsedMs": 42000, "usage": {...}, "candidates": 3, "legal": 2 },
    { "name": "evaluate", "attempt": 0, "elapsedMs": 88000, "usage": {...} },
    { "name": "decide",   "attempt": 1, "elapsedMs": 15000, "usage": {...} }
    // 或回退: { "name": "fallback", "reason": "scout-exhausted" }
  ]
}
```
- `stages` 内不含 prompt/响应原文(**只摘元数据**;原文在 debug_logs 天然全量);
- 老读日志器(`replay.ts`/GIF/前端)对 `stages` 缺省容忍,**零改动即兼容**;
- `begin.rules` 快照增加 `mode` 字段(回放时可知本局模式)。

**debug_logs(零新代码)**:三次调用各落一条 `player-request`/`player-response`(现有机制按 attempt 区分);`player-request.body` 自带各阶段 prompt 与工具定义,天然可审计。阶段区分:debug log 行加 `stage` 字段(meta 注入,与 gameId/side 同机制)。

**前端流式思考**:`player-message` 帧文本加前缀 `【侦察】/【评估】/【定稿】`——前缀在 MultiStepPlayer 调 `onThought` 时包装,`useGame`/WS 零协议改动;落子后 `liveThoughts` 清空逻辑不变。

**GIF 导出**:零改动(只消费 `move.analysis`)。

## 7. 实现落点(文件级)

| 文件 | 改动 |
|---|---|
| `server/models/multi-step.ts`(新) | `MultiStepPlayer implements Player`:pickMove 编排①②③④,阶段重试/回退,usage/elapsed 汇总,stages 摘要,onThought 阶段前缀包装;阶段 prompt 模板与工具 schema 定义 |
| `server/models/openai.ts` | 抽公开模块级原语:`buildRequestBody`(参数化 tools/max_tokens/messages)+ `readSseStream`(增量回调)——**类内出招路径改为调原语,行为不变**;新增导出 `stageStage` debug meta 透传 |
| `server/models/anthropic.ts` | 同上对称抽取(`readSseBody`/`messagesUrl` 等已是模块函数,补请求构造原语) |
| `server/http.ts` | `mode`/`mode_multi` 解析进 ServerDefaults + 启动校验;`defaultBuildPlayer` 按 mode 包 MultiStepPlayer |
| `server/arena.ts` | **近零改动**:pickMove 返回值扩展可选 `stages`,move 事件透传(纯 append) |
| `server/game-log.ts` | `MoveEvent` 类型加可选 `stages?`;begin.rules 加 `mode` |
| `server/session.ts` | selfThoughts 注入点不变(由 MultiStepPlayer 产出④analysis,session 无感知) |
| `web/src/composables/useGame.ts` | liveThoughts 展示加阶段标签(前缀已含在文本里,零逻辑改动;仅展示组件可能调样式) |
| `config.example.json` / `CLAUDE.md` / `AGENTS.md` | 文档同步 |

**传输原语抽取原则**(双协议对称性的落点):openai/anthropic 各自的「构造请求体 + 发请求 + 流式读 + usage/超时/取消 + debug-log」下沉为模块级纯函数,出招 Player 与 MultiStepPlayer **消费同一批原语**——协议对称不再靠两份相似代码,而靠共享原语;每协议的原语各自有单测覆盖。

## 8. 测试计划

- **单测(MultiStepPlayer,mock fetch)**:①happy path 三阶段产出+usage 求和+stages 结构;②候选含非法被过滤(prompt 注入的合法清单正确);③④选了清单外着法->只重跑④;④连续 2 次非法->空 move 交 arena;⑤①全过滤->换一批提示重跑①;⑥①两轮失败->回退 single(stages 记 fallback);⑦各阶段截断->G3c 重发带「请精简」;⑧onThought 前缀【侦察】/【评估】/【定稿】;⑨双协议(openai/anthropic)同跑同断言(镜像对称);
- **配置校验测试**:mode 未知值/缺省;mode_multi 数值非法;请求体不提供 mode;
- **回归**:385 项现有测试全绿(single 零行为变化的硬证明);日志兼容性测试(老日志样例回放);
- **集成(smoke,e2e)**:scriptPlayer 走 multi 编排路径的冒烟场景(不触网);
- **实测验收**(上线后):一局完整 multi 对局,stages 数据对比 single 局的 token/时长/打回率(写入 `docs/models/glm-5.3-family.md` 经验表)。

## 9. 风险与未决

- **风险 R1(核心假设)**:小任务在 max 档下推理量仍大 -> 阶段 0 探针先行;不成立则调上限与任务定义,骨架不变;
- **风险 R2**:三阶段总计仍可能慢于单次快收敛模型(deepseek 单步本来 5k 内收敛,multi 对它是 3 倍调用)-> multi 首期只与 GLM-5.3 系配用,deepseek 侧收益观察后再说(但**代码双方同跑**,公平性不依赖收益);
- **未决 U1**:候选数固定 3 还是可配(1-5)?-- 初版固定 3,`mode_multi.candidates` 留作后续;
- **未决 U2**:评估阶段推演对手应手的深度(固定 2 手)是否够 -> 实测后调;
- **明确不做**:阶段间「树搜索式」多分支扩展(ToT 全量)、候选间的并行调用、阶段④降级为引擎选子(违反原则 B,已否决)。

## 10. 搁置记录(2026-08-29)

**R1 探针实证,假设证伪,方案搁置(deferred)。**

探针(`scripts/probe-stages.mjs`,方舟 GLM-5.3,effort max,流式,真实中局局面+侦察 prompt):

| 实验 | max_tokens | 思考量 | 结果 |
|---|---|---|---|
| 侦察「列3候选」×2 次 | 8192 | 26k / 28k 字符 | finish=length,**0 产出** |
| 侦察「列3候选」 | 32768 | 108k 字符 | finish=length,**0 产出** |
| 侦察「列3候选」 | 65536 | 107k 字符(≈65k tokens) | finish=stop,产出正常,**耗时 509s** |
| 截断后带「请精简」重发 | 8192 | 27k 字符 | finish=length,**0 产出** |

**结论**:
1. GLM-5.3 在 effort max 下,思考量由**档位**决定,不由任务大小决定--「列 3 个候选」的认知推演与「找最佳着法」本质重叠(用户判断:与 single 的穷举目标差别不大),模型内部没有更便宜的路径;
2. 「请精简」重发对该任务无效(带提示仍 27k 字符超 8192 截断);
3. 分步对 GLM-5.3 (max) 无时间/成本收益:单步 65k 思考不会拆成 3×20k,只会变 3×65k。成功标准的第一条(<1/3 时长)结构性不可达。

**重启条件**(任一满足可重新评估):模型/档位变化(如未来 GLM 版本小任务推理量显著下降)、或换用思考量随任务伸缩的模型、或接受 multi+high 档组合(每阶段推理量降一档,可能重现收益,未测)。

**已沉淀资产**:设计文档本体(决策 1-5 与流水线/配置/日志设计保留)、探针脚本 `scripts/probe-stages.mjs`、模型档案新条目(见 `docs/models/glm-5.3-family.md`)。
