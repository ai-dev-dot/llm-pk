# 存档（archive/）

用户指定的**值得留存的已完成对局**。`logs/` 与 `debug_logs/` 是运行时数据（gitignore，可能被清理），本目录是人工精选的永久副本，**随 git 入库**。

## 目录约定

| 目录 | 内容 | git |
|---|---|---|
| `archive/` | 对局事件日志（`logs/<id>.jsonl` 的副本，几 KB~几十 KB） | ✅ 入库 |
| `archive_debug/` | 双方 debug 日志（`debug_logs/<id>_<model>.jsonl` 副本，含思考全文，MB 级） | ❌ gitignore，仅本地留存 |

对局事件日志可完整回放（`GET /api/games/:id/replay` 同源格式）；debug 日志含每手思考原文，是复盘的原始材料，量大不入库，需要时本地查阅。

## 索引

| 文件前缀 | 对局 | 结果 | 意义 |
|---|---|---|---|
| `20260828-GLM-5-3-Flash-pk-deepseek-v4-flash-24` | GLM-5.3-Flash(high, 方舟) vs deepseek-v4-flash(max, 方舟) | 黑方 checkmate 胜，28 手 / 99 分钟 | **本项目第一局完整下完的对局**（2026-08-28）。验证配置：high + max_tokens 32768 + stream；红方 13 次请求 2 次顶闸（88k/92k 字符思考），截断→精简重发均一次收敛 |

## 约定

- 由人工判断后手动存档（终局横幅「存档本局」按钮，或服务端 `POST /api/games/:id/archive`），不做自动归档。
