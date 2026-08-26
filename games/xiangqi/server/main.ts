//
// Task 17 —— 服务入口(server/main.ts)。
//
// 职责:
// - 读 `games/xiangqi/config.json`(与 config.example.json 同目录?否,为上一级)作为服务器缺省;
//   文件缺失则打印示例提示并以非零退出;
// - 端口可配:`PORT` 环境变量 > config.json 的 `port` > 默认 3010;
// - 启动 Express(http)+ WebSocket(ws)共用服务,打印启动日志。
//

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createXiangqiServer, type ServerDefaults } from './http';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, '..', 'config.json');
const EXAMPLE_PATH = join(HERE, '..', 'config.example.json');

if (!existsSync(CONFIG_PATH)) {
  const example = existsSync(EXAMPLE_PATH) ? readFileSync(EXAMPLE_PATH, 'utf8') : '';
  // eslint-disable-next-line no-console
  console.error('[xiangqi-server] 缺少配置文件 games/xiangqi/config.json。');
  // eslint-disable-next-line no-console
  console.error('请在 games/xiangqi/ 下创建(参考示例):');
  if (example) console.error(example);
  process.exit(1);
}

const config: ServerDefaults = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as ServerDefaults;

const port = Number(process.env.PORT ?? config.port ?? 3010);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  // eslint-disable-next-line no-console
  console.error(`[xiangqi-server] 非法端口: ${process.env.PORT ?? config.port}(应为 1..65535)`);
  process.exit(1);
}

const srv = createXiangqiServer({ config });

srv.server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[xiangqi-server] 已启动: http://127.0.0.1:${port}`);
  // eslint-disable-next-line no-console
  console.log(`  REST:  POST/GET /api/games, GET /api/games/:id[/replay], POST /api/games/:id/{pause,resume,step}`);
  // eslint-disable-next-line no-console
  console.log(`  WS:    ws://127.0.0.1:${port}/ws/games/:id?since=0 (增量推 {seq,event})`);
});

const shutdown = () => {
  // eslint-disable-next-line no-console
  console.log('[xiangqi-server] 关闭中…');
  void srv.dispose().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);