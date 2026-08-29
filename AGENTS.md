# AGENTS.md

LLM PK 项目：多个大语言模型分别扮演对弈双方、在 Web 上实时对战，事件日志驱动回放与复盘。**权威开发约定见 [CLAUDE.md](CLAUDE.md)（改动任何核心逻辑前必读）**；项目理念见 README.md。

## 目录

- `games/xiangqi/` —— 唯一已实现游戏（中国象棋）：Node+TS 后端 + Vue3 前端，双 npm package（根 = 引擎+服务端，`web/` = 前端）
- `docs/models/` —— 模型特有问题档案（症状/根因/规避/最终配置），新增 `config.json` profile 必须同步建档
- `docs/superpowers/{specs,plans}/` —— 设计与计划工件；`TODOS.md` 待办
- `archive/` —— 存档对局日志（**入库**）；`archive_debug/` —— 存档调试日志（**不入库**）

## 命令（分别在两个 package 内执行，根目录无 Node 工程）

```bash
cd games/xiangqi
npm test              # 服务端+引擎单测（vitest，385 项）
npm test -- <文件>    # 单个测试文件
npm run dev           # 后端服务（tsx watch，端口 3010）
npm run smoke         # 端到端冒烟（脚本化 Player，不触网）
npm run gif -- <gameId>   # 事件日志 → 动图（scripts/gif/*）
cd web
npm run dev           # Vite（5173，代理 /api 与 /ws → 3010）
npm run test          # 前端单测
npm run typecheck     # vue-tsc 严格类型检查
```

## 架构红线

- **事件日志是唯一真相源**：`logs/<gameId>.jsonl`（append-only JSONL，`GameEvent` union）。实时观战、回放、动图都从事件重建，同一算法（`web/src/lib/replay.ts` 纯函数）。任何改动不得破坏「日志可完整重建局面」。
- **仲裁在 `server/arena.ts`**，只吃 `this.game.*` 泛型接口；象棋规则封印在 `server/games/xiangqi-game.ts` + `engine/` 全纯函数（零 IO）。
- **Player 适配器**：`server/models/openai.ts`（原生 /chat/completions + Bearer）与 `anthropic.ts`（/v1/messages + x-api-key），由 profile `protocol` 选择。**双适配器行为必须对称**（公平性）；`stream: true`、usage 统计等能力要两端一致。
- **自由出招（原则 D）**：模型自提记谱/坐标，不给合法清单；非法打回只讲原因、不枚举正确答案；单半步内打回满 `illegalAttemptsLimit`（默认 10）才判负，换方重新计数。
- **思考强度在配置定义（原则 E）**：`config.json` 的 `models.<name>.thinking` 整段透传进请求体，代码零映射。
- **密钥红线**：`api_key` 只在 config.json/请求体/客户端构造内存中；绝不进日志、事件、WS、响应（`sanitizeForLog` 强制）。密钥回落按 profile 粒度同源校验。

## 关键 gotcha

- **服务重启/热重载 = 进行中对局丢失**：对局状态在内存。`tsx watch` 改 server 代码会自动重启；改 `config.json` 不热重载（启动时读取），**改配置必须手动重启服务**。对局进行中不要动 server 代码或重启。
- **max_tokens 语义**：程序不传 = 交端点默认——**方舟 openai 兼容端点默认 4096（会截断思考），智谱官方默认不限**。config.json 顶层 `max_tokens` 是全局托底（模型级 > 顶层）。方舟上限 128000，无"不限"写法。
- **GLM-5.3 系列思考无自然上界**：过度思考是模型特性，max_tokens 是唯一的断路器；档位仅 low/high/max（无 medium），coding 端点未知值静默映射 max。GLM-5.3 系强制思考，`disabled` 会报错。
- **流式思考**：anthropic 协议的思考在 SSE 里是 `thinking_delta`（已支持推流）；GLM anthropic 兼容端点可能无 thinking_delta，思考在工具参数 analysis 里（AnalysisScraper 兜底）。两种互斥，勿双份推送。
- **git 策略**：`logs/`、`debug_logs/`、`archive_debug/`、`config.json`（含真实密钥）一律不入库；`archive/` 随 git 入库。**不要提交 config.json 或把密钥写进任何输出**。
- **finish reason 码**是稳定字符串（`draw-repeat`/`illegal-moves`/`timeout` 等），与 `web/src/lib/format.ts` 两侧同步，新增需改两端。
- 端口：后端 3010（可 PORT 覆盖）、前端 Vite 5173（IPv6 localhost）。

## 沟通

与用户沟通一律**中文**；代码、技术术语、文件名可用英文。
