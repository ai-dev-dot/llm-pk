# GLM-5.3 / GLM-5.3-Flash 特有问题档案

> 建档 2026-08-28。本档案覆盖 GLM-5.3、GLM-5.3-Flash（智谱 Coding Plan 套餐）。同家族同问题。

## 基本信息

- 厂商：智谱 AI（Z.ai）
- 协议：OpenAI `chat/completions`（`protocol: 'openai'`）
- 端点：`https://open.bigmodel.cn/api/coding/paas/v4`（Coding Plan 套餐 key 专用；`/api/paas/v4` 报 429、`/api/v1` 报 403）
- 思考：**强制开启（always-thinking）**，但两端口行为不同（官方文档 2026-08-28 核实，见「档位事实」节）：
  - 常规 API（`/api/paas/v4`）：`thinking.type: "disabled"` **直接报错**；
  - Coding 端点（`/api/coding/paas/v4`，本项目在用）：传 `disabled/false/none/off` **不报错，静默映射为 `low`**（「仍会轻量思考」）。

## 配置档案

```json
"GLM-5.3-Flash": {
  "protocol": "openai",
  "base_url": "https://open.bigmodel.cn/api/coding/paas/v4",
  "model": "GLM-5.3-Flash",
  "thinking": { "thinking": { "type": "enabled" }, "reasoning_effort": "high" },
  "max_tokens": 16384
}
```

> **2026-08-28 档位定案：high**（low 已实测否决，见实测数据表 19 局——单手 4-30s 很快，但 11 手 9 次打回，棋力崩到不可用）。high 档「中盘思考爆炸」不再降档解决，提示词只做**去除过度引导**（20 局起）：
> - `server/prompts/xiangqi-rules.md` 最终形态 = 原版**纯删除**，四改三删：「每步落子前必须完成自检」过程义务、第 3 步「推演走完后的局面」推演措辞（= 诱导无停止点前瞻搜索）、「反复违反会触发判负」威慑（诱导焦虑式反复自检）、整块「出招自检三步」（流程性框架；三条内容 ①② 已全有，删后规则信息零损失，代价=送将类打回率可能升）。
> - **不加任何反向引导**（「少思考/不深算/两三句讲清」类措辞均否决）：会惩罚指令遵循好的模型，破坏 PK 公平性。
> - `carrySelfAnalysisN` 回显未启用（裁决：不为此改变对局口径）。
>
> 诊断结论（回答「为什么 coding 没事、下棋爆炸」）：**任务形状差异，不是程序缺陷**——coding 是增量小步、上下文自带前情、验证外包给测试；本项目每手是无状态单发「从裸局面解整个局面」= 推理模型的最坏情况。GLM 在 coding 上同样过度思考（社区实锤），只是 coding 工具链扛得住。

为什么这样配（**每一步都是踩坑换来的**）：
- `reasoning_effort: high` 而非 `max`：max 档思考最长、复杂局面易「思考过度不收敛」（见问题 1）；high 智能几乎持平 max（Z.ai 官方图表口径）但思考量大幅下降。
- `max_tokens: 16384`：给单次输出设顶，防止思考失控无限膨胀；顶穿时走 G3c 截断检测带提示重发（最多 2 次）。**注意：16384 也会被顶穿**（见问题 2），它是「最后一道闸」而非万灵药。
- 非流式：coding 端点「流式 + thinking」实现不完整（黑洞/狂流不收敛/max_tokens 不生效）。
- 配套：本项目 `timeout_minutes: 15` 客户端超时 + 网络重试 3 次 + 超时挂起手动 retry（对局不废）。

## 已知问题

### 问题 1：思考过度 / 不收敛（本项目第 15 局撞上，社区实锤）

- **症状**：单步思考量巨大；病态局面下思考轨迹塌缩成无限重复单一 token（如 `"locklocklock…"`），**永不收敛、永不输出最终答案**，请求一直挂到被网络层/网关掐断（本项目观察到 ≈5 分钟整断连，表现为 `fetch failed`），重试全部白烧。
- **复现场景**：多轮工具循环 + 非流式 + 长上下文 + `reasoning_effort: max`。间歇性发作，工具繁重步骤更容易触发。
- **根因**：GLM-5.3 是 always-thinking 模型，`reasoning_effort: max` 时思考最长，复杂局面可能进入不收敛循环。
- **证据**：
  - `ollama/ollama#18069`（2026-08-27）：glm-5.3-flash 思考塌缩成无限 "lock" 重复、永不终止，请求挂到客户端 abort 或超时——与本项目现象完全一致；
  - `NousResearch/hermes-agent#89241`：GLM-5.3 always thinks；非流式请求思考阶段被 90s stale detector 杀掉（"slow-but-alive"）；**coding 端点把 glm-5.2 请求偷偷路由到 5.3 后端**；
  - `NousResearch/hermes-agent#91789`：实测 `reasoning_effort` 分级真实生效——(不传)=69 / low=4 / medium=11 / high=98 / max=125 reasoning tokens。**注意：medium 是该第三方自托管栈的行为，智谱官方端点并无此档**（见「档位事实」节，勿据此配 medium）；
  - `openkursar/hello-halo#343`、`farion1231/cc-switch#6739`：GLM-5.3 家族 forced-thinking 的多方处理。
- **本项目应对**：
  1. `reasoning_effort` max → **high**（第一道闸，已上线）；
  2. `max_tokens: 16384`（第二道闸，G3c 截断重发兜底）；
  3. 15 分钟超时 + 3 次网络重试 + 超时挂起手动 retry（最后兜底，对局不终止）。

### 问题 2：max_tokens 会被顶穿，且截断重发烧钱

- **症状**：4096/8192 都顶穿过（07/09/10/11 局），16384 也顶穿过（09/10/12 局）；顶穿 = `stop=max_tokens` 且无 tool_use → G3c 带提示重发最多 2 次，每次 ~170s+，成本翻倍。
- **根因**：`reasoning_effort: max` 时自然思考长度 10-13k 字符（探针），复杂局面超过预算。
- **应对**：`max_tokens: 16384`（安全余量）+ high 档压缩思考量。若仍频繁顶穿，考虑降到 8192 或进一步审视 high/max 档位。

### 问题 3：budget_tokens 静默无效（coding 端点）

- **症状**：`thinking.budget_tokens` 在 coding 端点被静默忽略，不控制思考长度。
- **证据**：探针实测（2026-08-28），A/B/C/D 四档 budget 无差异。
- **应对**：不传 `budget_tokens`，思考量交给 `reasoning_effort` + `max_tokens` 双闸。

### 问题 4：长请求 ≈5 分钟被掐断

- **症状**：单次请求持续约 5 分钟整时被断（三次实测 5:04/5:06/5:05），表现为 `fetch failed`，非 5xx。
- **根因判断**：非端点硬超时（我们的客户端超时是 15 分钟，从未触发），而是「思考过长 + 长连接」被链路/网关掐断；与 ollama 报告「请求挂到超时被掐」同症状类。
- **应对**：问题 1 的三道闸（high 档把单步压回 4 分钟内，是最有效的规避）。

### 问题 5：流式 + thinking 不稳（历史）

- coding 端点「流式 + thinking」下：黑洞、思考狂流不收敛、`max_tokens` 不生效。**默认非流式**（`AnthropicPlayer` `stream:false`；OpenAI 适配器同理）。

## 档位事实（官方文档联网核实 2026-08-28）

> 来源：智谱开放平台《深度思考》《Coding Plan 说明》与 Z.ai 文档/博客。此节推翻本档案旧结论「medium 可用」「disabled 必报错」。

- **合法档位仅 `low` / `high` / `max` 三档**，默认 `max`。常规 API 传其余值（含 medium）**直接报错**；知乎实测：独立 API 传未文档化值（medium/none/minimal/xhigh）会**返回 200 但按 max 级别计费**。
- **Coding 端点做静默映射**（不报错）：`none/minimal/light/low→low`；`medium/high→high`；`xhigh/max/ultra→max`；**未知字符串→回退默认 `max`**。⇒ 配 `medium` 不但不省，反而落到最重档。
- **Coding 端点 `thinking.type: disabled/false/none/off` → 映射为 `low`**（「继续请求；仍会轻量思考」），不报错、不换模型。⇒ 与直接传 `low` 等价。
- 档位实测差异（知乎踩坑文，GLM-5.3）：小 prompt 下 low 中位输出仅 3 token；代码任务 low=519 / high=658 / **max=3700** 中位输出 token —— **high≈low，max≈low×7**。重活主要在 max；high 与 low 之间是不连续的质量/思考跳变，无中间档。
- 质量口径（Reddit r/ZaiGLM「PSA: MUST use MAX」帖及评论）：高赞评论引 Z.ai 官方博客图表「**High 智能几乎持平 Max**，Max 多烧的 token 只换边际提升」；另有用户「max 过度思考太慢，high 恰到好处」；low 被普遍认为明显变笨。
- 延迟是模型固有属性：HN/Artificial Analysis 口径 Flash 单任务耗时 ≈ 同类 7 倍、最慢梯队之一；OpenRouter 史上 4 倍 token 消耗纪录。⇒ 工程参数（超时/重试）救不了慢，只能降档。

## 实测数据（本项目）

| 对局 | 配置 | 观测 |
|---|---|---|
| 14 局 | 16384 + effort:max | GLM 单步最大 7361 token/173s 一次过；但黑方第 5 手 25,710 token/208s（deepseek）；GLM coding 端点 2 次 `fetch failed` |
| 15 局 | **不限 max_tokens** + effort:max | GLM 第 7 手 12,231 token/289s（贴线）；第 10 手三次请求全部 ≈5 分钟断连白烧（0 产出，成本累计 $1.24） |
| 17 局 | **无 max_tokens** + effort:high + **stream:true** | GLM 单步 29,265 reasoning token/675s（流式 29k chunks、8.3 万字符思考全文）；另一手 15,303 token/378s；单步成本最高 $0.46；终局前一手 15 分钟超时挂起手动 retry。→ 印证问题 5：流式下 max_tokens 闸缺失则思考放飞 |
| 18 局 | 16384 + effort:high + stream:true | 思考量随局面复杂度单调膨胀：红 1-6 手思考 508→5.9k→4k→**12.4k**→9.9k 字符，耗时 9s→50s→41s→106s→83s；红第 6 手首试 **351s 顶穿 16384 token（全烧在思考，`finish_reason=length`，零产出，$0.25 白烧）**，截断重发再 286s——**单手 10.6 分钟**，对局无法完成，随服务重启终止于 6.5 回合。⇒ high 档对中盘对弈仍过重，触发降档 low |
| 19 局 | 16384 + effort:**low** + stream:true | 单手 4-30s（速度达标），但**11 手 9 次打回**（非法步率 ~82%/手），棋力崩到不可用；且对 effort:max 的黑方不公平。⇒ **low 否决**，档位定案 high，转攻任务形状 |
| 20 局 | 16384 + effort:high + stream:true + 棋规卡中性版（四删零增） | **证伪「提示词诱导」假说**：思考量不降反升——第 2 手 18.5k 字符/140s（18 局同手 5.9k/50s）；第 6 回合红方 **G3c 三连全截断**（attempt0/1/2 各 ~350s、思考 4.0/4.3/4.2 万字符、全部零产出，白烧 ~17 分钟），带「请精简」提示的重发无效（思考量反升），随后 4 次瞬时网络失败触发 `network-exhausted` 挂起。⇒ 思考深度=模型在 high 档对复杂局面的固有行为，与提示词无关；16384 闸对中盘复杂局面必然不够 |
| 21 局起 | **max_tokens:32768** + effort:high + stream:true（方舟端点 `ark.cn-beijing.volces.com/api/coding/v3`，模型名 `glm-5-3-flash`） | **24 局 = 本项目第一局完整下完的对局**（已存档 `games/xiangqi/archive/`）：黑 checkmate 胜，28 手/99 分钟。红方 13 次请求：开局手思考仅百余字符、接触手 1-4 万、**2 次顶闸（88,424 / 92,443 字符）均「截断→精简重发一次收敛」**，重发思考 ≈1.9 万字符（16384 闸下装不下故 20 局三连死、32768 装得下故可活）。⇒ **思考量无自然上界、会吃满任何预算**——max_tokens 即「单手断路器/时长旋钮」；32768 ≈ 15 分钟客户端超时下流式速度（~39 tok/s）能容纳的最大闸位，勿再放大（65536 须配 30min 超时且撤掉断路器）。遗留：方舟流式默认不回 usage，需适配器加 `stream_options.include_usage` |

## 结论与建议

1. **GLM-5.3 家族接入必须带思考闸**：`reasoning_effort`（别用默认 max）+ `max_tokens`，两者缺一都可能失控。
2. **档位选择按任务性质**：编码类任务 high 智能几乎持平 max（省一大截 token）；**对弈/多回合类任务 high 仍会中盘爆炸（18 局实证），要用 low**。没有 medium 档——智谱端点传 medium 轻则报错、重则静默按 max 计费，勿试。
3. **不要再试**：GLM-5.2（coding 端点偷偷路由到 5.3，hermes 实证）、`budget_tokens`（静默无效）、流式关闭（问题 5 为历史，现 stream:true 已在用且 max_tokens 闸有效）、任何未文档化档位值。
4. **继续观察**（20 局起）：high + 中性棋规卡（仅去除「推演局面」类过度引导）能否让对局完赛；失败信号=中盘思考仍爆炸（则属模型固有，再议工程兜底）。公众号描述「参与模型问题」时引用问题 1（有社区实锤）。
