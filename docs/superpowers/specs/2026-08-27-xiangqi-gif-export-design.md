# 观战动图导出 · 设计文档(基于日志回放生成公众号 GIF)

日期:2026-08-27
状态:已批准(设计在 chat 共识后落盘)
关联设计:[2026-08-26-xiangqi-llm-pk-design.md](./2026-08-26-xiangqi-llm-pk-design.md)

## 1. 概述与目标

将已完成(或进行中)的一场对局,基于**事件日志 + 回放纯函数**渲染成一帧帧 GIF 动图,产物可直接上传微信公众号文章。

对局自动推进(app-only JSONL),动图导出是**离线批处理工具**,不参与仲裁、不占观战资源、不阻塞正在进行的 PK。

**成功标准**:
- `npm run gif -- <gameId>` 输出 `files/<gameId>.gif`,`GIF89a` 签名、循环播放;
- 尺寸/节奏符合公众号要求(默认宽 900px、< 2M 目标、自动循环);
- 复用既有回放算法(`web/src/lib/replay.ts`),实时与动图零重演偏差(原则 B)。

## 2. 范围与不入侵(硬边界)

**改到**:
- 新增 `scripts/gif-export.ts`(CLI 入口)+ `scripts/gif/`(渲染纯逻辑 + 测试);
- `package.json`(新增依赖 + `gif` script)、`.gitignore`(`files/`)、`CLAUDE.md`(命令与说明)。

**绝不改**:
- `server/arena.ts`、`server/http.ts`、`server/game-log.ts`、`server/ws.ts`、`server/models/*`、`engine/*` 运行期代码;
- 前端 `web/` 任何运行时与事件结构;
- 不重启服务、不触发模型调用、不触网。

## 3. 技术栈(为避开 Windows 原生编译坑选型)

| 用途 | 选型 | 理由 |
|------|------|------|
| 2D canvas 渲染 | `@napi-rs/canvas` | Rust 预编译(win/mac/linux 均有预构建二进制),API 与 node-canvas 兼容(`createCanvas`/`getContext('2d')` 全套);`GlobalFonts.registerFromPath` 注册系统中文真字体 |
| GIF 编码 | `gifenc`(纯 JS) | 无原生依赖;流式写帧、内存友好;`quantize`/`applyPalette` 支持**固定调色板**(本项目用固定色板避免逐帧量化闪烁与耗时) |

**不选 `node-canvas` + `gifencoder`**:两者均为 C++ 原生依赖(node-gyp/giflib),Windows 常踩编译、ABI 不匹配、VS Build Tools 缺失等坑;本项目为自包含 TS 工具,应尽量零编译依赖。

### 中文字体

- 棋子用楷体、字幕用黑体:Windows 默认探测 `C:/Windows/Fonts/simkai.ttf`(楷体)→ 次级 `simhei.ttf`(黑体);
- `--font <path>` 可显式指定任意字体文件(ttf/otf),跨平台可移植;
- 探测不到字体 → 打印明确指引并以 **exit 2** 退出,**绝不**发出缺字/方块字的半成品 GIF。

## 4. 数据流与复用(单一真相源)

```
logs/<gameId>.jsonl
   │  readAllEvents()(server/game-log.ts,已有)
   ▼
GameEvent[]
   │  web/src/lib/replay.ts 纯函数(已有,实时与回放共用):
   │    boardAt(events, seq)  ─ 每步合法落子后的局面 UidPiece[]
   │    movesAt(events, seq)  ─ 合法走子序列(seq/from/to/notation)
   │    modelsAt / resultAt   ─ 模型名 / 终局(winner, reason)
   ▼
帧描述序列(scripts/gif/frames.ts,新增纯函数)
   ▼
scripts/gif/render.ts(@napi-rs/canvas)逐帧渲成 RGBA
   ▼
scripts/gif/encode.ts(gifenc)固定色板 → files/<gameId>.gif
```

- `web/src/lib/replay.ts` 及其依赖(`engine/`、`server/game-log.ts` 类型、`web/src/lib/board.ts`)全部为**平台无关纯 TS**,后端脚本可直接 `import`,无 web 运行时;
- 棋子字集复刻 `engine/render.ts` 的 `PIECE_CHARS`(紅車馬相仕帥砲兵 / 黑車馬象士將砲卒),保持「单一字源」。

## 5. 画布与渲染规格

- **默认画布 900×1040**:上方 900×900 棋盘 + 底部 140px 记谱字幕条;
- 可调 `--width`(允许 720 / 900 / 1080),画布高度随之等比(棋盘平方 + 固定字幕带);
- **棋盘**(传统木色):
  - 底色木色渐变、网格线深棕、将帅位九宫斜线、河界中央「楚 河 漢 界」;
  - 行列坐标细字(红底一侧行号 1 起、黑顶一侧 10 起,列标 `a..i` 上下对称,不镜像——与 engine 坐标一致);
  - 棋子:圆形,径向渐变 + 外环;红方白底红字红环,黑方深底白字浅环;楷体字居圆内;
  - 高亮:本步起点格淡黄填充、终点格亮黄圆点;上一步终点保留淡标记。
- **字幕条**:
  - 左:回合徽标「第 N 回合」+ 当前步中文记谱(`move.notation`,如「炮二平五」);
  - 右:红/黑模型名小字(公众号场景不显示 gameId);
  - 打回留痕时(该半回合出现过 `illegal-attempt`)徽标旁附小字「⚠ 被裁判打回×n」。
- **结果横幅**:终帧叠加在棋盘上部,半透明暗底 + 大字胜负 + 小字原因;文案与 `web/src/lib/format.ts` 对齐:
  - `絕殺` / `困毙` / `打回超过上限判负` / `网络超时判负` / `对局异常终止` / `强制中止` / `重复局面 · 和棋` / `双方无进攻子力 · 和棋` / `步数上限 · 和棋` / `成本上限 · 和棋` / `网络异常 · 对局中止(不作胜负)`;
  - **未完成局**(无 `finish` 事件)→ 横幅「对局进行中」,照常出图到当前最终局面。

## 6. 帧序列与时间轴

以 `movesAt` 的合法步序列 + 初始局面为轴。对第 i 步(from→to):

| 段 | 帧数 | 帧时长 | 内容 |
|----|------|--------|------|
| 开局定格 | 1 | 1500ms | 初始局面 + 「第 1 回合」字幕 |
| 每步·驻足 | 1 | 1000ms | 走子前局面,观众辨认行棋方(可读字幕预演) |
| 每步·滑行 | 4 | 100ms×4 | from 子线性补间至 to;若有吃子,目标子随移动淡出 |
| 每步·落定 | 1 | 1000ms | 落子后局面 + 高亮 + 字幕更新 |
| 终局定格 | 1 | 2000ms | 结果横幅 |
| 循环衔接 | — | — | GIF 自动循环;末帧与首帧相同初始局面,衔接无跳变 |

- 步数 N ⇒ 总帧数 ≈ `1 + N×6 + 1`;40 步局 ≈ 242 帧,纯色块压缩后通常 **< 2M**;
- 超长局/体积超限:提供 `--speed <1|2>`(帧delay 减半)与 `--width 720` 兜底,不静默降质——体积超 `--max-kb`(默认 2048KB)时打印警告并建议参数,仍照常输出。

## 7. CLI 设计(scripts/gif-export.ts)

```
npm run gif -- <gameId> [--out PATH] [--font PATH] [--width 720|900|1080] [--speed 1|2] [--max-kb 2048]
npm run gif -- --all [同上次要参数]
```

- `--all`:遍历 `logs/*.jsonl` 全部对局(含进行中局,以最后局面为终局横幅「对局进行中」),逐局出图;
- `--speed` 默认 1(帧 delay 不变),`2` 表示全部帧时长减半;
- 默认 `--out` = `files/<gameId>.gif`(输出目录不存在时自动创建);
- 输入日志缺失 / 事件为空 → 报错 exit 1;字体缺失 → 指引 + exit 2;
- 成功打印摘要:`gameId → files/xxx.gif · 帧数 · 尺寸 · 字节大小`。

## 8. 产物与忽略

- 产物目录 `games/xiangqi/files/`,在 `.gitignore` 追加 `files/`(与 `logs/` 同类,不入库);
- 复用模块不产出中间文件;错误一律控制台、不写半文件(先写 `*.gif.tmp` 再改名,失败时清理)。

## 9. 错误处理

- **字体缺失**:可判定 → exit 2,带指引;
- **日志损坏**(坏 JSON 行):抛错描述文件名与行号,exit 1;
- **canvas/编码异常**:捕获并打印栈,清理 `*.tmp`,exit 1;
- 单局失败不中断 `--all` 批量:记录该局失败原因到总结,继续下一局(末尾汇总失败清单)。

## 10. 测试策略(全部不触网、不开服务)

- `scripts/gif/frames.test.ts`(纯函数):
  - 合成事件数组(初始局 + K 步合法 move + finish)→ 断言帧数 `≈ 1+K×6+1`、逐段 delay、字幕回合数/记谱、终帧横幅文案;
  - 未完成局 → 横幅「对局进行中」;
  - 该半回合含 `illegal-attempt` → 字幕附「打回」徽标;
  - 终局 reason 映射覆盖 format.ts 文案全集对齐测试。
- `scripts/gif/render.test.ts`(真渲染冒烟):
  - 若系统存在中文字体,渲染「走子 / 吃子 / 终局横幅」三类一帧不抛异常,输出 RGBA 尺寸正确;
  - 经 gifenc 编码后产物以 `GIF89a` 头(字节 0..5);
  - 若本机无字体,该组用例 skip 并提示(不 fail)。
- vitest 默认 include `scripts/**/*.test.ts`,随 `npm test` 一并跑,不离线、不影响运行中 PK。

## 11. 文档

- `CLAUDE.md`:
  - 常用命令新增 `npm run gif` 一行;
  - 「动图导出」一节:定位(离线批处理/复用回放纯函数/固定色板 + gifenc)、字体约定、产物与忽略;
- 本 spec 及其关联 plan 归档于 `docs/superpowers/`。

## 12. 关联与后续(本期外)

- 远期可选:Web 观战页「导出 GIF」按钮(走同一 render 管线的 HTTP 端点)——本期按用户拍板只做**后端 CLI 路线**;
- 动图自动推公众号(API 上传素材)需要公众号后台授权,属另一期。