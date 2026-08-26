//
// Task 17 —— WebSocket 增量推流(ws.ts)。
//
// 契约(brief + controller):
// - 端点 `/ws/games/:id`,query `since=<lastSeq>`:连接即按 seq 补发已发生事件(断线重连不丢步),
//   随后 arena.onEvent 桥接到该连接实时推 `{ seq, event }`;
// - 帧格式恒定 `{ seq, event }`:`seq` 与日志单调一致(seq 1 起),`event` 为 sanitize 后的干净副本;
// - 补发与实时同源:先后挂实时监听、再同步遍历内存事件镜像补发(无 await 间隙 ⇒ 无重复/无丢失);
// - 对局不存在:推一帧 `{ seq:0, event:{ type:'error', code:'GAME_NOT_FOUND' } }` 后关闭。
//
// 用 `noServer` 模式接管 upgrade,按 pathname 把 `/ws/games/<id>` 路由到具体对局的 arena。
//

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import type { GameRecord } from './http';
import type { GameEvent } from './game-log';

type GameStore = Map<string, GameRecord>;

const GAME_PATH = /^\/ws\/games\/([^/]+)\/?$/;

function parseSince(req: IncomingMessage): number {
  try {
    const raw = new URL(req.url ?? '', 'http://localhost').searchParams.get('since');
    const n = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** 安全解码路径段:畸形百分号编码(如 `%ZZ`)抛 URIError,此处统一返回 null。 */
function safeDecodePath(seg: string): string | null {
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
}

function serialize(evt: GameEvent): string {
  return JSON.stringify({ seq: evt.seq, event: evt });
}

/** 拦截 HTTP upgrade,把 `/ws/games/:id` 路由到 arena;返回被挂载的 WebSocketServer。 */
export function attachWsServer(server: HttpServer, store: GameStore): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      // 畸形/不可解析的请求目标:直接销毁,绝不允许异常逃逸到事件层崩溃进程
      socket.destroy();
      return;
    }
    const match = GAME_PATH.exec(pathname);
    if (!match) {
      socket.destroy();
      return;
    }
    const gameId = safeDecodePath(match[1]!);
    if (gameId === null) {
      // 非法百分号编码(如 /ws/games/%ZZ):销毁连接,不抛 URIError
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, gameId);
    });
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage, gameId: string) => {
    const since = parseSince(req);
    const sendFrame = (frame: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(frame);
      } else if (ws.readyState === WebSocket.CONNECTING) {
        // 握手完成前投递的帧会丢失 —— 等 open 后补发,保证首个帧不丢
        ws.once('open', () => {
          if (ws.readyState === WebSocket.OPEN) ws.send(frame);
        });
      }
    };

    const rec = store.get(gameId);
    if (!rec) {
      sendFrame(
        JSON.stringify({
          seq: 0,
          event: { type: 'error', code: 'GAME_NOT_FOUND', message: `对局不存在: ${gameId}` },
        }),
      );
      ws.close();
      return;
    }

    // 1) 先挂实时监听(arena 每事件同步回调,与日志同源);
    const listener = (evt: GameEvent) => sendFrame(serialize(evt));
    rec.arena.onEvent.on('event', listener);

    // 2) 再同步补发 since 之后的历史(单线程内无 await 间隙 ⇒ 不会与实时重复/错位);
    for (const evt of rec.events) {
      if (evt.seq > since) sendFrame(serialize(evt));
    }

    ws.on('close', () => {
      rec.arena.onEvent.off('event', listener);
    });
    ws.on('error', () => {
      /* 连接被对端重置等,清理由 close 兜底 */
    });
  });

  return wss;
}