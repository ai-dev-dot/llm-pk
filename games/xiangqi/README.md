# 中国象棋 · LLM 对战

两个大语言模型(LLM)分执红黑,在实时 Web 棋盘上对弈中国象棋。规则由确定性裁判代码(**引擎**)统一裁定:模型自由出招(中文记谱或坐标),非法走法被**打回**并记录,连续打回超限判负。

- **思维可见** —— 每步展示模型思考(analysis)与耗时/token/折算成本($US);
- **一切可回放** —— 每局留下结构化 JSONL 日志(`logs/<gameId>.jsonl`),支持逐 seq 回放、任意拖动、断线续传;
- **规则即裁判** —— 引擎单代码公证,红黑行为完全对称,唯一不对称是双方所选模型;
- **密钥隔离** —— `apiKey`/`baseUrl` 只在内存中构造模型客户端,绝不落日志/事件/对外响应。

---

## 目录结构

```
games/xiangqi/
├── engine/        # 规则引擎:棋盘/走法/裁决(parseMove/parseResolve)/将军·将死·困毙/和棋三态/ASCII 渲染
├── server/        # 服务与调度:HTTP(REST)+ WebSocket、Arena 回合仲裁、会话隔离、模型适配器、赛后复盘
├── scripts/       # M0 spike:spike-prompt(提示词模板)、spike-parse(真实模型解析率基线)
├── e2e/smoke.ts   # 端到端冒烟(无 key,注入脚本化 Player)
├── web/           # 前端:新局表单 / 实时对局 / 回放视图 / 复盘摘要
├── config.json    # 局级配置(含 api_key,gitignore,绝不入库)
├── logs/          # 对局日志(gitignore)
└── demo.html      # 引擎 ASCII 演示页
```

---

## 安装

两个子包各自有依赖:

```bash
cd games/xiangqi
npm install

cd web
npm install
```

要求 Node ≥ 18(原生 `fetch` + `AbortController`)。

---

## 配置

复制模板并填写(文件已被 `.gitignore`,禁止入库):

```bash
cp config.example.json config.json
```

在 `models` 里定义任意多个**可复用的 LLM profile**(各自独立端点/密钥/模型),红、黑、复盘用 `use` 按名引用——红黑可以打不同厂商、不同 key:

```jsonc
{
  "models": {
    "glm46": {
      "base_url": "https://open.bigmodel.cn/api/anthropic",  // 须为 Anthropic 兼容端点(/v1/messages)
      "api_key": "sk-…",                                    // 仅用于构造客户端,绝不落日志
      "model": "glm-4.6"
      // 可选:system_prompt / max_tokens / timeout_ms / tokens_per_m
    },
    "kimi": {
      "base_url": "https://api.moonshot.cn/anthropic",
      "api_key": "sk-…",
      "model": "kimi-k2-0905-preview"
    }
  },
  "red":    { "use": "glm46" },   // 红方引用 glm46
  "black":  { "use": "kimi" },    // 黑方引用 kimi(不同厂商/key 对打)
  "review": { "use": "glm46" },   // 【可选】赛后复盘,同样按名引用
  "steps": 40,                    // 折成 maxTotalMoves(步数上限判和)
  "timeout_ms": 120000
}
```

**国内模型**:客户端走 Anthropic Messages 协议(`/v1/messages` + 强制 tool_use + SSE),请用提供 **Anthropic 兼容端点**的国内服务,如智谱 GLM(`https://open.bigmodel.cn/api/anthropic`)、Kimi(`https://api.moonshot.cn/anthropic`);直连国内端点无需代理。`base_url` 末尾带不带 `/v1` 都会自动补全。

**`max_tokens` 默认不传**:请求体省略该字段,由模型端点用自身默认输出上限(适配长思考,不再保守卡在 1024)。仅当某端点强制要求时,在对应 profile 里加 `"max_tokens": 8192`。

> **[review 段可选]** 复盘用**独立凭据**(`use` 引用一个 profile,与对局红黑隔离,绝不借用对局方 key)。引用的 profile 缺 base_url/api_key/model 三要素 ⇒ 复盘自动静默降级。不配也可正常对局,仅无复盘摘要。
>
> **[旧格式兼容]** 仍支持顶层 `base_url`/`api_key` + `red.model`/`black.model` 的扁平结构;密钥外带防护不变——未显式给 key 时,服务端 key 只会回落给与配置端点**完全同源**的请求。

规则参数(可选,缺省走引擎默认):`maxTotalMoves`(默认 200 判和)、`illegalAttemptsLimit`(默认 3 判负)、`drawRepeat`(默认 3)、`networkRetries`(默认 3)、`maxCostPerGame`(成本守卫,超限判和)、`carrySelfAnalysisN`(己方思考回显窗口,默认 6)、`contextBudgetTokens`(软护栏,默认 32000)。

---

## 启动

后端与前端分开两个终端运行。

```bash
# 终端 1:后端(端口优先级 PORT 环境变量 > config.json.port > 3010)
cd games/xiangqi
npm run dev          # tsx watch server/main.ts

# 终端 2:前端 Vite dev(默认 http://localhost:5173)
cd games/xiangqi/web
npm run dev          # vite;自动代理 /api、/ws → 127.0.0.1:3010
```

打开 <http://localhost:5173>。

---

## 对局操作

1. **新局表单**:红黑可各填 `baseUrl / apiKey / model`(直填),`systemPrompt` 可选;**也可全部留空**,回落服务器 `config.json` 里 `red.use`/`black.use` 引用的 profile。每侧要么填全、要么全空(半套会被本地拦截)。apiKey 仅存于浏览器内存,随请求直发后端,不落 UI 状态。
2. **实时对局页**:
   - 棋盘实时落子,顶栏显示本局 cost 汇总($ US);
   - 侧栏**思考面板**流式呈现当前行棋方思考(analysis),逐步累计成本数字;
   - 行棋方非法走法被**打回**,侧栏留档「裁判打回」原因与次数;
   - **暂停 / 单步 / 恢复**(REST pause/step/resume),可逐半回合观看;
   - **重开**:用同一配置再开一局(新 gameId 重新订阅);
   - 终局横幅显示**胜负 + reason + 双方打回总数**,并标注 `单局 · 未换色,胜负不作模型强弱结论`。
3. **回放**:对局页右上「回放」进入;时间轴以事件 `seq` 为轴,可播放/暂停/单步/回退/拖动到**任意 seq**;侧栏复盘摘要(如有)与打回次数。
4. **断线重连**:WS 订阅 `/ws/games/:id?since=<lastSeq>`,断线自动按 `lastSeq` 增量重连续传,不丢步。

### REST / WS 速查

| 端点 | 说明 |
| --- | --- |
| `POST /api/games` | 建局,body `{ red, black, config?, review? }` → `201 { id }` |
| `GET /api/games` | 对局列表(红黑 model / status / moveCount / winner) |
| `GET /api/games/:id` | 详情(phase / turn / cost / winner / reason) |
| `GET /api/games/:id/replay` | 事件数组(与日志严格同源) |
| `POST /api/games/:id/{pause,resume,step}` | 控制(非法状态 409,不存在 404) |
| `WS /ws/games/:id?since=N` | 增量推 `{ seq, event }`;since=lastSeq 断线续传 |

Web UI 使用相对路径 `/api`、`/ws`,经 Vite 代理到后端 3010;直接 curl 走后端 3010 任意端口均可。

---

## 端到端冒烟(无需 key)

不依赖任何真实模型 key,全链路自动跑通并自校验:

```bash
cd games/xiangqi
npm run smoke
```

覆盖(注入脚本化 Player,走法序列固定):起服务 → POST 建局 → arena 自动跑至 finish → 读日志文件 → `GET /:id/replay` 与日志事件**逐条对齐** → 校验 finish(winner/reason/**分阶段 ruleViolations**) → 断言日志/响应/全日志目录不含 `api_key|baseUrl` 与密钥值。共 3 个脚本化场景:

- **A** 红方连续非法 → 黑胜 `illegal-moves`,红违规 `pre=1/post=2`(分阶段);
- **B** 红黑小局 → `draw-max-moves`,违规全 0;
- **C** 配齐 review 凭据但 client 抛错 → 复盘**降级**:无 review 事件、对局结论不变。

---

## M0 解析 spike(需真实 key)

第 0 里程碑:先用真实模型实测 `parseMove` 成功率,验证解析宽容度与提示词质量的基线。

```bash
# 先配置 config.json 的 api_key(与 red/black.model)
cd games/xiangqi
npm run spike:parse     # 等效 npx tsx scripts/spike-parse.ts
```

- 未配 key:`spike awaiting key: …` 并以 exit code 2 退出,**不触发任何网络调用**;
- 配 key 后:红黑各按 `steps` 上限轮流出招,输出每步解析结果与成因分布,写 `scripts/spike-result.json`(gitignore);
- **解析率基线阈值 ~90%**:`summary.parseRate ≥ 0.9` 为达标;若低于阈值,优先回调提示词/解析宽容度再继续正式演进。

---

## 验收清单(联调)

状态标注:✅ = 本环境(无真实 key)**已自动化验证**(单测 / 集成测试 / e2e 冒烟);⬜ = **需真实 key + 浏览器人工补验**(当前无 key 环境未做)。

- [ ] 1. 真实两模型完整一局(含**至少一次打回**) ⬜ —— 打回→判负全链路由 e2e 场景 A 以脚本化走法**确定性覆盖**(3 次打回 → `illegal-moves` 判负、违规分阶段计数);真实模型侧联调未做(**未做项 A**)
- [x] 2. 思考面板流式、成本数字可见 ✅ —— ThoughtPanel / 成本汇总前端单测覆盖;e2e 事件含 `analysis`/`usage` 断言数据链路
- [x] 3. 暂停 / 单步 / 重开 ✅ —— REST pause/step/resume 集成测试覆盖(非法状态 409);「重开」按上次配置再建一局
- [x] 4. 断线重连续传 ✅ —— WS `since=lastSeq` 增量补发不丢步,集成测试覆盖
- [x] 5. 回放从任意 seq 起 ✅ —— 时间轴以 seq 为轴,`boardAt`/`seekTo` 前端单测覆盖任意位置
- [x] 6. finish 显示 winner / 规则失误分阶段 ✅ —— 终局横幅 `winner+reason+打回总数`;`ruleViolations` 分 `pre`/`post`(教学前累计 / 被拒后重犯);e2e 场景 A/B 逐项断言
- [x] 7. 复盘缺位降级 ✅ —— 未配复盘 / 三要素不全 / review 调用失败 → 无 `review` 事件、终局结论不变;UI 显示「复盘生成中…(或不可用);不影响本局结果」;集成测试 + e2e 场景 C 覆盖
- [ ] 8. 浏览器无 console error、声音可用(静音切换 🔊/🔇) ⬜ —— 前端组件/单测无报错;浏览器人工确认待补(key + 人工开页)
- [x] 9. `grep -rn 'api_key\|baseUrl' logs/` 为空 ✅ —— 日志写入器强制 `sanitizeForLog`(敏感键黑名单);e2e 冒烟对全日志目录做运行时断言

### 未做项(需真实 key / 网络环境)

- [ ] A. **真实两模型完整一局** —— 无真实 key 环境,尚未在浏览器用两个真实模型跑完一整局(引擎/服务/Arena 链路已由 e2e 脚本化全覆盖,此处为模型侧联调)
- [ ] B. **断网手工演练** —— 真实对局中断网观察重试/超时判负的病态路径(arena 网络重试已有网络型错误测试覆盖,手工演练待有条件)

> 说明:以上 ⬜ 未做项均是「缺 key/缺浏览器网络环境」所致,**不影响无 key 环境的脚本化冒烟结论**;补齐 key 后按上表 ⬜ 项逐条补验即可。

---

## 测试与常用命令

```bash
cd games/xiangqi
npm test             # 引擎 + 服务端单测(14 文件)
npm run smoke        # 端到端冒烟(无 key,全链路自校验)
npm run spike:parse  # M0 解析率基线(需 key)

cd games/xiangqi/web
npm test             # 前端单测(Vue 组件 + composables)
npm run build        # vite 构建
npm run typecheck    # vue-tsc
```