# GLM-5.3 / GLM-5.3-Flash 特有问题档案

> 建档 2026-08-28。本档案覆盖 GLM-5.3、GLM-5.3-Flash（智谱 Coding Plan 套餐）。同家族同问题。

## 基本信息

- 厂商：智谱 AI（Z.ai）
- 协议：OpenAI `chat/completions`（`protocol: 'openai'`）
- 端点：`https://open.bigmodel.cn/api/coding/paas/v4`（Coding Plan 套餐 key 专用；`/api/paas/v4` 报 429、`/api/v1` 报 403）
- 思考：**强制开启（always-thinking）**——`thinking.type: "disabled"` 直接报错，无关闭开关

## 配置档案（本项目最终形态）

```json
"GLM-5.3-Flash": {
  "protocol": "openai",
  "base_url": "https://open.bigmodel.cn/api/coding/paas/v4",
  "model": "GLM-5.3-Flash",
  "thinking": { "thinking": { "type": "enabled" }, "reasoning_effort": "high" },
  "max_tokens": 16384
}
```

为什么这样配（**每一步都是踩坑换来的**）：
- `reasoning_effort: high` 而非 `max`：max 档思考最长、复杂局面易「思考过度不收敛」（见问题 1）；high 是官方默认推荐档，思考量 ≈max 的 78%，单步时长可压回 4 分钟以内规避断连。
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
  - `NousResearch/hermes-agent#91789`：**实测 `reasoning_effort` 分级真实生效**——(不传)=69 / low=4 / medium=11 / high=98 / max=125 reasoning tokens（注：智谱文档称 5.3 仅支持 max/high/low，第三方实测 medium 亦接受且生效，以实测为准）；
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

## 实测数据（本项目）

| 对局 | 配置 | 观测 |
|---|---|---|
| 14 局 | 16384 + effort:max | GLM 单步最大 7361 token/173s 一次过；但黑方第 5 手 25,710 token/208s（deepseek）；GLM coding 端点 2 次 `fetch failed` |
| 15 局 | **不限 max_tokens** + effort:max | GLM 第 7 手 12,231 token/289s（贴线）；第 10 手三次请求全部 ≈5 分钟断连白烧（0 产出，成本累计 $1.24） |
| 15 局 | 未测 high | 待新局验证：期望单步回到 3-4 分钟、不再断连 |

## 结论与建议

1. **GLM-5.3 家族接入必须带思考闸**：`reasoning_effort: high` + `max_tokens: 16384`，两者缺一都可能失控。
2. **不要再试**：GLM-5.2（coding 端点偷偷路由到 5.3，hermes 实证）、`budget_tokens`（静默无效）、流式（不稳）。
3. **继续观察**：high 档下是否仍有思考不收敛/断连；公众号描述「参与模型问题」时引用问题 1（有社区实锤）。
