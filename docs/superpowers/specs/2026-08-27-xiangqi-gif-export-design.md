# 观战动图导出 · 设计文档(基于日志回放生成公众号 GIF)

日期:2026-08-27(含 /plan-ceo-review 修订)
状态:已批准(chat 共识后落盘;评审修订经 CEO 评审 + 独立复核裁决)
关联设计:[2026-08-26-xiangqi-llm-pk-design.md](./2026-08-26-xiangqi-llm-pk-design.md)

## 0. 范围决策记录(自评审锁定,不再重议)

| 来源 | 决策 | 状态 |
|---|---|---|
| 用户拍板 | 棋盘+记谱字幕+结果横幅 / 常规节奏 / 默认单局+`--all` 批量 | 已批准 |
| cherry-pick D3 | 封面 PNG 首帧输出 `files/<gameId>_cover.png` | ✅ 本期 |
| cherry-pick D3 | HTML 图集导读 / 观战页 HTTP 导出按钮 | → deferred(TODOS) |
| cherry-pick D3 | 字幕条「第 N 手/总 M 手」+ 行棋方红黑点 | ✅ 本期 |
| 评审 F1 | CLI `gameId` 走 `basename()` 净化,空/含路径拒绝 | ✅ 本期 |
| 复核 T1 | 体积超 `--max-kb` 自动**分片**为多个 GIF(`.part1.gif`…),支持分次上传公众号 | ✅ 本期 |
| 复核 T2 | **色板即绘制色**:大面积色全用 palette 纯色,取消渐变;文字 AA 边缘做最近邻量化 + 阈值断言 | ✅ 本期 |
| 复核 T3 | 容忍进行中日志的不完整尾行(视为半写),不误报损坏 | ✅ 本期 |
| 复核 M5 | GIF 末帧→首帧回环**接受硬切**(不加过渡帧) | ✅ 本期 |
| 复核 M1/M4/M6/L1-L4 | 字体链扩充、坏行带行号、palette 表来源、跨包约束、import.meta.url 定位、字形覆盖抽样、delay 倍率校验 | ✅ 本期 |

deferred 到 TODOS:HTML 图集导读、HTTP 导出按钮、(可选)测试捆绑开源中文字体。

## 1. 概述与目标

将一场 PK 对局基于**事件日志 + 回放纯函数**渲染成 GIF 动图(带记谱字幕/结果横幅),产物可直接上传微信公众号文章;未完成局照常出到当前步。离线批处理 CLI,不参与仲裁、不占观战资源、不阻塞进行中的 PK。

**成功标准**:
- `npm run gif -- <gameId>` 输出 `files/<gameId>.gif`(`GIF89a` 签名、循环播放),超预算自动分片多文件;
- 默认宽 900px;**体积策略**:单 GIF 超过 `--max-kb`(默认 2048KB)自动切成 `part1..N`,适配公众号不限张数、按图分次上传的实际用法(「<2M 是一张图的目标,超了拆多张」);
- 复用既有回放算法(`web/src/lib/replay.ts`),实时与动图零重演偏差(原则 B)。

## 2. 范围与不入侵(硬边界)

**改到**:
- 新增 `scripts/gif-export.ts`(CLI)+ `scripts/gif/`(frames/render/encode/palette/fonts + 测试);
- `package.json`(依赖 + `gif` script)、`.gitignore`(`files/`)、`CLAUDE.md`(命令与约束)。

**绝不改**:`server/arena.ts`、`server/http.ts`、`server/game-log.ts`、`server/ws.ts`、`server/models/*`、`engine/*` 运行期代码;前端 `web/` 任何运行时与事件结构;不重启服务、不触发模型调用、不触网。

## 3. 技术栈

| 用途 | 选型 | 理由 |
|------|------|------|
| 2D canvas | `@napi-rs/canvas` | Rust 预编译,API 同 node-canvas;`GlobalFonts.registerFromPath` 注册系统中文字体 |
| GIF 编码 | `gifenc`(纯 JS) | 无原生依赖、流式写帧;**固定调色板**避免逐帧量化闪烁 |

不选 `node-canvas`+`gifencoder`:双 C++ 原生依赖,Windows 编译/ABI 易踩坑,本项目应零编译依赖。

### 中文字体与字形

- 探测链(依次):`--font <path>` 显式指定 → 系统 `simkai.ttf`(楷体)→ `simhei.ttf`(黑体)→ `msyh.ttc`(雅黑)→ `simsun.ttc`(宋体)。`ttc` 若无法被 register 则跳过并提示用 `--font` 指定 ttf 兼容文件;
- **字形覆盖抽样**:渲染后对 `帥將車馬砲砲兵卒楚河漢界絕殺困毙`(传统字域)用 `measureText` 断言宽度 > 0,任一命中 0 → 报「字体缺字形」exit 2,绝不发缺字/豆腐块半成品;
- 路径解析用脚本自身 `import.meta.url` 定位包根(不依赖 cwd)。

## 4. 数据流与复用

```
logs/<gameId>.jsonl
   │  CLI 自带带行号解析(不用 readAllEvents 的裸抛;坏行报 file:行号)
   │  容忍最后一行不完整(无换行结尾且 JSON 解析失败 → 视为进行中半写,剥离)
   ▼
GameEvent[]
   │  web/src/lib/replay.ts 纯函数(boardAt/movesAt/modelsAt/resultAt)
   ▼
帧描述序列(scripts/gif/frames.ts)
   ▼
scripts/gif/render.ts(@napi-rs/canvas → RGBA,渲染只用 palette 色)
   ▼
scripts/gif/palette.ts(色板表,绘制常量唯一来源)
   ▼
scripts/gif/encode.ts(gifenc,固定 palette;超 --max-kb 分片)
   ▼
files/<gameId>.gif  [+ .part2..N.gif]  +  <gameId>_cover.png
```

**跨包约束(L1)**:`scripts/` 反依赖 `web/src/lib/replay.ts` 是唯一跨层点,`replay`/`board` 链路必须保持纯 TS、永不得引入 web 运行时(UI)依赖——写入 CLAUDE.md 文档化。

## 5. 画布与渲染规格

- 画布默认 900×1040(900×900 棋盘 + 140px 字幕条),`--width` 可调 720/900/1080,高度等比(棋盘平方 + 字幕带)。
- **色板即绘制色(T2/M6)**:`scripts/gif/palette.ts` 定义固定 ~48 色表(木底×3、网格、河界、九宫斜线、红黑棋子底/字/环×2、高亮 from/to、字幕底与文字、横幅暗底、进度点红黑…),**棋盘/棋子/字幕/横幅全部只取 palette 内颜色**,不作任何渐变/插值;棋子 = 纯色圆 + 纯色环线 + 纯色字(楷体)。
- 文字抗锯齿:`fillText` 在纯色底上的 AA 边缘像素属调和色,落到非 palette 色时做**最近邻量化**(字形局部,视觉稳定;仅滑行补间时该子字形边界有 1-2px 微抖,可接受,远小于整片梯度 banding)。
- **palette 越界断言(M6 落地)**:单测对代表性帧(初始/中盘/终局横幅)断言「非文字区像素全部 ∈ palette;文字 AA 像素与 palette 最近邻距离 ≤ 阈值(如 18/255)」。
- 棋盘:传统木色、网格线、九宫斜线、河界「楚 河 漢 界」、行列坐标细字;红底一侧行号 1、黑顶一侧 10,列标 `a..i` 上下对称(不镜像,与 engine 坐标一致)。
- 高亮:本步起点淡黄填充、终点亮黄圆点;上一步终点保留淡标记。
- **字幕条**:左「第 N 回合 + 记谱」(`move.notation`);右 红/黑 模型名小字 + **行棋方红黑圆点**(D3 接受);该半回合含 `illegal-attempt` 时附「⚠ 打回×n」。进度:`第 N 手 / 总共 M 手`(D3 接受)。
- 结果横幅:终帧叠加棋盘上部,半透明暗底 + 大字胜负 + 小字 reason;文案与 `web/src/lib/format.ts` 对齐(絕殺/困毙/打回超过上限判负/网络超时判负/对局异常终止/强制中止/重复局面·和棋/双方无进攻子力·和棋/步数上限·和棋/成本上限·和棋/网络异常·对局中止(不作胜负));未完成局横幅「对局进行中」,照常出图到当前局面。
- **封面 PNG**:首帧(初始局面 + 字幕「第 1 回合」)单独导出 `files/<gameId>_cover.png`,公众号题图常用静态图。

## 6. 帧序列与时间轴

对第 i 步(from→to):

| 段 | 帧数 | 帧时长 | 内容 |
|----|------|--------|------|
| 开局定格 | 1 | 1500ms | 初始局面 + 「第 1 回合」 |
| 每步·驻足 | 1 | 1000ms | 走子前局面(读字幕预演行棋方) |
| 每步·滑行 | 4 | 100ms×4 | from 子线性补间至 to;吃子时目标子随移动淡出(淡出全程只淡化 palette 内色阶) |
| 每步·落定 | 1 | 1000ms | 落子后 + 高亮 + 字幕/进度更新 |
| 终局定格 | 1 | 2000ms | 结果横幅/「对局进行中」 |

- 步数 N ⇒ 总帧数 ≈ `1 + N×6 + 1`。
- **循环衔接(M5)**:末帧(终局横幅)→ 首帧(初始局面)回环为**硬切**,明确接受,不加过渡帧。
- **分片(D3 复核 T1)**:编码前若预估/实测字节超 `--max-kb`(默认 2048KB),按**步序边界**切成 `part1..N`:前 N-1 段各以「未完·续」终帧,首段首帧为初始局面、后续段以其第一步走前局面起始,末段正常横幅。每张均可独立上传公众号并按编号顺序阅读。分片计数以「每段字节 ≤ max-kb」为目标拟合,字节越界时逐段回退一步重切(不作静默近似)。

## 7. CLI(scripts/gif-export.ts)

```
npm run gif -- <gameId> [--out PATH] [--font PATH] [--width 720|900|1080] [--speed 1|2] [--max-kb 2048]
npm run gif -- --all [同上]
```

- `--all` 遍历 `logs/*.jsonl`(含进行中局),逐局出图;单局失败记录原因、继续下一局,末尾汇总失败清单;
- `gameId` 入参 `basename()` 净化(去路径成分),空/无效 → 报错 exit 1;`--out` 省略时 `files/<gameId>.gif`(目录自动创建);
- `--speed 2` 全帧时长减半;delay 值是 GIF 厘秒(10ms)整数倍,参数校验兜底(L4 步骤);
- 成功摘要:`gameId → files/xxx.gif(+分片数/封面) · 帧数 · 每片字节 · 渲染耗时 ms`;
- 体积越限(未开分片仍超)打印建议(`--width 720` 或 `--max-kb` 调高),不静默降质。

## 8. 产物与忽略

- `games/xiangqi/files/`(`.gitignore` 追加 `files/`,与 `logs/` 同类不入库);
- 写文件用 `*.gif.tmp` → 完成后 rename;失败清理,绝不留半成品。

## 9. 错误处理

| 场景 | 行为 |
|---|---|
| 日志缺失 / 事件为空 | 报错 exit 1(描述原因) |
| 坏 JSON 行 | 报 `文件名:行号`(自写带行号解析)+ 行首 160 字符预览,exit 1 |
| 进行中日志半写尾行 | 剥离不完整尾行,照常出图(T3) |
| 字体文件缺失 | 探测链指引 + exit 2 |
| 字形覆盖不全(measure 命中 0) | 指引换字体 + exit 2 |
| canvas/编码异常 | catch + 清理 `.tmp` + 栈 + exit 1 |
| 批量单局失败 | 记录原因、继续;末尾汇总 |

## 10. 测试策略(不触网、不开服务)

- `frames` 纯函数:合成事件(含非法步/吃子/打回/finish)→ 帧数/逐段 delay/字幕/首末帧/分片边界;
- `palette` 越界断言(§5);
- `render` 真渲染冒烟(初始/走子/吃子/终局横幅;无字体 skip);字形抽样断言;
- 编码冒烟:固定 palette 编码 N 帧 → `GIF89a` 签名 + 字节 < max-kb;合成超限日志 → `part1..2` 分片存在且各段签名合法;
- 尾行容忍:以不含换行尾的完整 JSON + 半行结尾写 fixture → 正常解析出 later 帧;
- `--all` 失败续跑汇总。vitest 默认 include `scripts/**/*.test.ts` 随 `npm test` 跑。

## 11. 文档

- `CLAUDE.md`:新增 `npm run gif` 命令 + 「动图导出」一节(离线批处理/复用回放纯函数/色板即绘制色/分片策略/字体约定/跨包约束/产物忽略);
- 本 spec 关联 CEO plan 在 `~/.gstack/projects/llm_pk/ceo-plans/`。

## 12. deferred(入 TODOS.md)

- HTML 图集导读:`--all` 附 `files/index.html` 多局预览/复制公众号格式;
- 观战页「导出 GIF」HTTP 只读路由 + 按钮;
- 测试捆绑可再分发开源中文字体(规避版权),让无字体机器也能跑渲染用例。