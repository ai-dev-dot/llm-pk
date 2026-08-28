# deepseek-v4-flash / deepseek-v4-pro 特有问题档案

> 建档 2026-08-28。两兄弟同厂商同端点同脾气。

## 基本信息

- 厂商：深度求索（DeepSeek），经火山方舟（Volcengine Ark）coding 兼容端点接入
- 协议：Anthropic Messages 兼容（`protocol: 'anthropic'`）
- 端点：`https://ark.cn-beijing.volces.com/api/coding`
- 思考：可配置（`thinking.type: "enabled"` + `output_config.effort`，兼容层实测容忍 `reasoning_effort` 也接受）

## 配置档案（本项目最终形态）

```json
"deepseek-v4-flash": {
  "protocol": "anthropic",
  "base_url": "https://ark.cn-beijing.volces.com/api/coding",
  "model": "deepseek-v4-flash",
  "thinking": { "thinking": { "type": "enabled" }, "output_config": { "effort": "max" } }
}
```

为什么这样配：
- `output_config.effort: max`：deepseek 兼容层认 `output_config`（GLM 那边是 dead field，deepseek 这边实测生效）。
- **不设 `max_tokens`（=不限制）**：ark 端点实测**无视 max_tokens**（16,535 / 25,710 token 都正常出招），且 deepseek 自然收敛、无 runaway 风险——放开安全。这是与 GLM 的关键差异。

## 已知问题

### 问题 1：第三方云环境思考块可能无限重复（本项目不受影响）

- **症状**：思考块无限重复同一段推理、零可用输出。
- **证据**：`ollama/ollama#17892`（2026-08-27）：deepseek-v4-flash:0731 在 ollama cloud 上思考块无限重复（同段 221 次/1m45s）；**但同一任务在 DeepSeek 官方 API 正常**——属 ollama 云侧问题。
- **本项目应对**：走火山方舟官方端点，实测无此现象（黑方全程正常出招）。若未来换端点/换云，留意此类「思考循环」并优先回官方 API 验证。

### 问题 2（观察项）：单步成本偏高

- 单步 completion 常 16k-26k token，单步成本 0.25-0.34 USD（比 GLM 高）。
- 属「最强能力」的正常代价，非缺陷；公众号成本对比时可引用。

## 实测数据（本项目）

| 对局 | 观测 |
|---|---|
| 14 局 | 黑方第 5 手 25,710 token / 208s，正常出招（无视 max_tokens 实证） |
| 15 局 | 黑方单步最大 21,941 token / 175s 一次过；单步 0.25~0.34 USD |

## 结论与建议

1. **deepseek 是「放开型」模型**：不限 max_tokens + effort:max 是安全形态，无需 GLM 那套思考闸。
2. **换接入渠道要警惕**：第三方云（如 ollama cloud）曾出现思考无限重复，官方端点无此问题。
3. 继续观察：超长对局（200 步上限）下 deepseek 单步耗时是否会拖慢整体节奏。
