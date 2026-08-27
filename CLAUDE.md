# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

面向人类读者的完整项目介绍与规范见 [README.md](README.md)。AI 协作者遵循本文件。

## 项目定位

- 本项目存放「由大语言模型直接对战(PK)」的游戏集合。每款游戏由多个 LLM 分别扮演对弈各方角色,通过 Web 页面实时展示对局,记录结构化日志以支持回放与复盘。
- **第一游戏已完成实现**:`games/xiangqi/`(中国象棋,Node+TS 单体服务 + Vue3 前端),可作为新增游戏的参考骨架。设计稿见 `docs/superpowers/specs/2026-08-26-xiangqi-llm-pk-design.md`。

## 常用命令

全部命令在 **`games/xiangqi/`**(后端+引擎)与 **`games/xiangqi/web/`**(前端)**两个独立 npm package** 内执行;根目录无 Node 工程,依赖没有全局共享。改动某侧代码前先在本侧 `npm install`。

```bash
cd games/xiangqi
npm test            # 引擎+服务端单测(235 项,✓)
npm test -- engine/notation.test.ts   # 单个测试文件
npm run test:watch  # 后端口 vitest 监视
npm run dev         # 后端服务执行(3010,读 config.json,缺配置给提示)
npm run smoke       # 端到端冒烟(48 断言,不触网,脚本化 Player)
npm run spike:parse # M0 解析率基线(需 config.json 配 key,否则 exit 2)
# 前端:
cd web
npm run dev         # Vite (5173,代理 /api 与 /ws → 3010)
npm run test        # 前端单测(68 项)
npm run typecheck   # vue-tsc 严格类型检查(后端请用 npm -C games/xiangqi exec tsc --noEmit --skipLibCheck)
npm run build       # 产物校验(编译含 .vue)
```

提示:根目录无顶层 tsconfig——`tsc` 全仓全局跑会有预存在的 .vue/双 vite 噪音,请按上表分侧执行。

## 架构(跨文件才能理解的"大图")

**唯一真相源 = 事件日志。** 一次对局是一条 append-only JSONL(`server/game-log.ts` 的 `GameEvent` union → `logs/<gameId>.jsonl`)。实时观战与回放都由事件重建,**同一算法**:

```
server/arena.ts(仲裁) ──appendEvent──► logs/*.jsonl ──GET /:id/replay─► web/src/lib/replay.boardAt(seq)
        │  onEvent 广播                                          ▲
        ▼                                                       └ 前端 useGame 实时 WS——与回放共用
    前端 WS(web/src/composables/useGame.ts)                         lib/replay.applyMoveToPieces(同源无偏差)
```

- **回放是纯重放**:服务端 `GET /:id/replay` 只回传原始事件数组;**重建为前端纯函数 `web/src/lib/replay.ts`**(`boardAt`/`applyMoveToPieces`),零 arena/模型运行时调用;`seq` 单调、`since` 断线按序补发;`useGame` 与回放共用同一 `applyMoveToPieces` ⇒ 「回放 vs 实时」双跑零偏差。
- **平台化 Game 接口(已落地)**:`server/game.ts` 泛型仲裁接口,象棋实现 `server/games/xiangqi-game.ts` 封印全部 engine 纯函数;`arena.ts` 只吃 `this.game.*`,新游戏接入仅新增一个实现文件、调度骨架零改。
- **公证 = 引擎是全司法权**:`engine/`(types/board/moves/attack/judge/notation/resolver/render)全纯函数、零 IO;单一解析入口 `parseMove`/`parseResolve`;**红黑镜像测试**(同断言跑两侧)。
- **自由出招(原则 D)**:模型只收棋盘+规则,自提中文记谱/坐标;非法/不可解析被**打回**(`engineReason` 只讲原因、绝不枚举合法走法),打回次数是测评指标(教学前/后分计)。打回解析结果按 `(cacheKey…)` 缓存,同回合只算一次。
- **流式思考(实时)**:`AnthropicPlayer` 默认 `stream:true`(SSE 解析 `input_json_delta`,非 SSE 响应自动回退非流式);analysis 增量经 `ctx.onThought` → arena `onLive` 广播 → WS 以 `seq:0` `player-message` 帧实时推流(不落日志、不占日志 seq、不参与断线补发;重连只显示最终 analysis)。前端 `useGame` 对 `player-message` 在 seq 过滤前特判累积 `liveThoughts`。
- **中文记谱(参照展示)**:`engine/notation.ts` 增 `moveToChinese(move,board,side)` 纯函数(红中文列号/黑阿拉伯、进退平、同线前/后);`move` 事件与历史带 `notation` 旁注,前端记谱履历优先展示。
- **隔离(原则 C)**:`server/session.ts` 红黑各自独立会话,`selfThoughts` 回显最近 N 步(默认 6),对方 analysis 绝不出现;Arena 组装上下文时只取本方思考+公共记谱。
- **守卫在 arena**:`illegalAttemptsLimit=3`、`drawRepeat`(默认 3)、`maxTotalMoves=200`、`maxCostPerGame`、网络退避重试——配置与 `begin.rules` 快照同一来源。
- **平台化薄协议**:`Game<State,Move>` 接口(见 spec §3)——第二个游戏接入时只新增实现文件,骨架(调度/日志/回放/前端订阅)零改。
- **复盘独立**:`server/review.ts` 用**独立凭据**(绝不借红/黑 key)读公共日志生成 `review` 事件;失败仅降级、不伤对局。

## 新增游戏必须满足的五个约定

1. **规则明确** —— 规则无歧义,胜负由规则客观、自动判定;
2. **多角色** —— 至少双方,每个 LLM 各操作一个角色,互不共享状态;
3. **Web 展示** —— 对局通过 Web 页面实时展示,尽量展示模型思考过程;
4. **日志完整** —— 结构化记录对局全程(回合、操作、时间、决策依据),用于复盘分析;
5. **回放支持** —— 基于日志提供对局回放,可定位到任意回合。

## 与模型交互的原则(项目级,所有 PK 游戏)

1. **文本化(原则 A)** —— 局面一律以 ASCII/文本形态传给模型,禁止位图/截图/SVG(模型大多非多模态);
2. **单代码公证(原则 B)** —— 所有对弈方共用同一份裁判代码、同一个玩家适配器、同一份提示词模板(仅身份词差异);**唯一允许的不对称是各方所选模型不同**;
3. **上下文隔离(原则 C + 回显)** —— 各方会话互相独立,看不到对方历史、思考、裁判内部状态;**己方思考默认恒回显**(最近 N 步,默认 6),绝不给对方;
4. **棋手式自由出招(原则 D)** —— 模型只看到局面与规则自行提行动,**不向其提供合法行动清单**;由确定性裁判代码解析+校验;不合规则即打回(解释原因、给予修正机会、绝不枚举正确答案);打回次数=规则掌握度指标;超限判负。

## 工程注意(实施期沉淀)

- **密钥红线**:`api_key` 只存在于 `config.json`/请求体与模型客户端构造;**绝不**进日志、事件、WS、response;`server/game-log.ts` 的 `sanitizeForLog` 强制执行。服务默认绑 `127.0.0.1`。密钥回落按 **profile 粒度同源校验**:请求未给 key 时,服务端 key 只回落给与最终 `baseUrl` **完全同源**的那份(被引用 profile 或旧顶层 `base_url`);请求体篡改 `baseUrl` 又不给 key → 400,密钥绝不外发。
- **LLM profiles 配置**:`config.json` 用 `models: { <name>: {base_url, api_key, model, ...} }` 注册表定义任意多个可复用 LLM,`red.use`/`black.use`/`review.use` 按名引用(红黑可打不同厂商/key);请求体内联 `baseUrl/apiKey/model` 优先,表单**全空**则回落 config profile。客户端走 Anthropic Messages 协议(`/v1/messages`),国内用智谱/Kimi 的 Anthropic 兼容端点。**`max_tokens` 默认不传**(请求体省略,交端点默认;仅 profile 显式 `max_tokens` 才带)。旧扁平结构(顶层 `base_url`+`red.model`)仍兼容。解析在 `server/http.ts` 的 `resolveSide`/`resolveReview`/`resolveProfile`。
- **分数段与事实**:`begin` 事件保留 `model` 名(评估标识,非密钥)。
- **M0 spike 待 key**:`npm run spike:parse` 需 `config.json`(`models` profile + 红/黑 `use`,或旧扁平 `baseUrl/apiKey/model`)才跑真实解析率;无 key 时 exit 2。
- **`finish` reason 码**是稳定字符串(`draw-repeat`/`draw-no-mating-material`/`draw-max-moves`/`draw-cost-limit`/`draw-network`/`illegal-moves`/`timeout`/`internal-error`),前端 `web/src/lib/format.ts` 与之对齐,新增 reason 需两侧同步。**`draw-network` 仅表示网络重试超限→和棋收尾,绝不判一方输**;`timeout`(旧判负码)保留兼容但 arena 已不产生。
- 计划与评审工件在 `docs/superpowers/{specs,plans}/`;待办见根 `TODOS.md`(批量匹配、分享链接、一键复跑等 deferred)。

## 沟通约定

- 与用户沟通一律使用**中文**;代码、技术术语、文件名可使用英文。