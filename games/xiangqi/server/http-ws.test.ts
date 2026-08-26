//
// Task 17 —— REST/WS 服务集成测试(严格 TDD)。
//
// 覆盖(brief + controller 契约):
// - POST /api/games → 201 {id};缺参(baseUrl/apiKey/model)→ 400;
// - GET /api/games 列表、GET /api/games/:id 详情(含当前 phase)、GET /api/games/:id/replay(读日志事件数组);
// - POST /api/games/:id/pause|resume|step 状态码;非法状态 409、不存在 404;
// - WS /ws/games/:id:since=0 建连收到 begin→push 后 seq 递增;断线重连 since=lastSeq 补发不丢步;
// - 密钥隔离:apiKey 绝不出现于任何 REST 响应与 WS 帧。
//
// 起服务用 supertest + http.Server listen(0);WS 客户端用 ws 库连真实端口。
// 玩家注入构建器,全部为脚本化/闸门 Player,绝不触网。
//

import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import request from 'supertest';
import { createXiangqiServer, type GameRecord } from './http';
import type { Player, MoveChoice } from './arena';
import type { Side } from '../engine/types';

/* ---------- 工具 ---------- */

const SECRET = 'sk-test-secret-1234';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 轮询直到条件成立(测试确定性补足)。 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时(${timeoutMs}ms)`);
    await sleep(5);
  }
}

/** 脚本化 Player:pickMove 立即返回 script[i % len],循环消费(i 自增)。 */
function scriptPlayer(side: Side, script: string[]): Player {
  let i = 0;
  return {
    side,
    model: `fake-${side}`,
    async pickMove(): Promise<MoveChoice> {
      i += 1;
      return { analysis: `分析-${side}-${i}`, move: script[(i - 1) % script.length] };
    },
  };
}

/**
 * 闸门 Player:pickMove 挂起直到 releaseNext() 放行一扇,用于确定性地推进对局。
 * release 与 pickMove 时序无关:调用先于 pickMove 则暂存、先于 release 则注册等待者,
 * 两者恒一一配对 —— 消除「HTTP 请求在途未注册 pickMove 时 release 落空」的竞态。
 */
function gatePlayer(side: Side, script: string[]) {
  const releaseQueue: Array<() => void> = [];
  const waiters: Array<(choice: MoveChoice) => void> = [];
  let i = 0;
  const nextChoice = (): MoveChoice => {
    i += 1;
    return { analysis: `分析-${side}-${i}`, move: script[(i - 1) % script.length] };
  };
  const player: Player = {
    side,
    model: `fake-${side}`,
    async pickMove(): Promise<MoveChoice> {
      const release = releaseQueue.shift();
      if (release) {
        release();
        return nextChoice();
      }
      return new Promise<MoveChoice>((resolve) => waiters.push(resolve));
    },
  };
  const releaseNext = () => {
    const waiter = waiters.shift();
    if (waiter) waiter(nextChoice());
    else releaseQueue.push(() => {});
  };
  return { player, releaseNext };
}

interface TestServer {
  server: http.Server;
  port: number;
  registry: import('./game-registry').GameRegistry;
  store: Map<string, GameRecord>;
  dispose: () => Promise<void>;
}

/** 起一个真实可用的 http 服务(port 0),WS 与 REST 共用。 */
async function startServer(
  buildPlayer?: (side: Side) => Player,
): Promise<TestServer> {
  const logDir = await mkdtemp(join(tmpdir(), 'xiangqi-http-ws-'));
  const srv = createXiangqiServer({
    logDir,
    buildPlayer: buildPlayer ? (side) => buildPlayer(side) : undefined,
  });
  srv.server.listen(0);
  await new Promise<void>((res) => srv.server.once('listening', () => res()));
  const port = (srv.server.address() as AddressInfo).port;
  const dispose = async () => {
    // 先显式中止全部对局(判和收尾),再等一拍让被唤醒的 drive 微任务落盘,最后清理目录
    for (const r of srv.store.values()) srv.registry.dispose(r.id);
    await new Promise<void>((r) => setImmediate(() => r()));
    for (const ws of srv.wss.clients) ws.close();
    await new Promise<void>((res) => srv.wss.close(() => res()));
    await new Promise<void>((res) => srv.server.close(() => res()));
    await rm(logDir, { recursive: true, force: true });
  };
  return { server: srv.server, port, registry: srv.registry, store: srv.store, dispose };
}

/** 基础建局请求体:红黑各 baseUrl/apiKey/model(必填)。 */
function baseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    red: { baseUrl: 'http://localhost:1', apiKey: SECRET, model: 'm-red' },
    black: { baseUrl: 'http://localhost:1', apiKey: SECRET, model: 'm-black' },
    ...overrides,
  };
}

async function createGame(server: http.Server, body: Record<string, unknown>): Promise<{ id: string }> {
  const res = await request(server).post('/api/games').send(body);
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

function wsUrl(port: number, gid: string, since = 0): string {
  return `ws://127.0.0.1:${port}/ws/games/${gid}?since=${since}`;
}

type WsFrame = { seq: number; event: { type: string; turn?: string } };

interface WsSink<T = WsFrame> {
  ws: WebSocket;
  /** 从连接建立起即缓存所有帧,按序取下一个(与实时同步,无监听竞态)。 */
  next<R = T>(timeoutMs?: number): Promise<R>;
  all(): T[];
  opened: Promise<void>;
  closed: Promise<void>;
}

/** 建连即开始缓存帧;`await sink.opened` 后才断言,绝不丢早到帧。 */
function openWs<T = WsFrame>(port: number, gid: string, since = 0): WsSink<T> {
  const ws = new WebSocket(wsUrl(port, gid, since));
  const queue: T[] = [];
  const history: T[] = [];
  const waiters: Array<(v: T) => void> = [];
  ws.on('message', (data: WebSocket.RawData) => {
    const parsed = JSON.parse(data.toString()) as T;
    history.push(parsed);
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else queue.push(parsed);
  });
  const next = <R = T>(timeoutMs = 2000): Promise<R> => {
    const queued = queue.shift() as R | undefined;
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS 消息超时')), timeoutMs);
      waiters.push((v) => {
        clearTimeout(timer);
        resolve(v as unknown as R);
      });
    });
  };
  const opened = new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));
  return { ws, next, all: () => history, opened, closed };
}

/**
 * 发一个原始(裸 TCP)HTTP/1.1 WebSocket upgrade 请求。
 * 服务端无论握手成功还是直接 destroy,本函数在连接关闭/出错时即返回。
 */
function rawUpgrade(port: number, target: string): Promise<void> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.on('error', () => resolve()); // 服务端 destroy → 连接重置
    sock.on('close', () => resolve());
    sock.write(
      `GET ${target} HTTP/1.1\r\n` +
        'Host: 127.0.0.1\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n' +
        '\r\n',
    );
  });
}

/* ---------- 用例 1:REST 建局/列表/详情/400 ---------- */

describe('REST 建局与查询', () => {
  it('POST /api/games 201 返回 {id};缺 model/baseUrl/apiKey → 400', async () => {
    const srv = await startServer();
    try {
      const { id } = await createGame(srv.server, baseBody());
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
      // 不能二次出现密钥
      expect(JSON.stringify({ id })).not.toContain(SECRET);

      // 缺 red → 400
      const noRed = await request(srv.server).post('/api/games').send({ black: baseBody().black });
      expect(noRed.status).toBe(400);

      // 缺 model → 400
      const noModel = await request(srv.server).post('/api/games').send({
        red: { baseUrl: 'http://x', apiKey: 'k' },
        black: { baseUrl: 'http://x', apiKey: 'k' },
      });
      expect(noModel.status).toBe(400);

      // 缺 apiKey → 400
      const noKey = await request(srv.server).post('/api/games').send({
        red: { baseUrl: 'http://x', model: 'm' },
        black: { baseUrl: 'http://x', model: 'm' },
      });
      expect(noKey.status).toBe(400);

      // 缺 baseUrl → 400
      const noUrl = await request(srv.server).post('/api/games').send({
        red: { apiKey: 'k', model: 'm' },
        black: { apiKey: 'k', model: 'm' },
      });
      expect(noUrl.status).toBe(400);
    } finally {
      await srv.dispose();
    }
  });

  it('GET /api/games 列表与 GET /api/games/:id 详情(含当前 phase)', async () => {
    const srv = await startServer();
    try {
      await createGame(srv.server, baseBody({ config: { maxTotalMoves: 4 } }));
      const list = await request(srv.server).get('/api/games');
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).not.toContain(SECRET);
      const games = list.body.games as Array<Record<string, unknown>>;
      expect(games.length).toBeGreaterThan(0);
      const g = games[0]!;
      expect(g).toMatchObject({ status: 'running', red: { model: 'm-red' }, black: { model: 'm-black' } });
      expect(typeof g.id).toBe('string');
      expect(typeof g.moveCount).toBe('number');

      const detail = await request(srv.server).get(`/api/games/${g.id}`);
      expect(detail.status).toBe(200);
      expect(JSON.stringify(detail.body)).not.toContain(SECRET);
      expect(detail.body).toMatchObject({
        id: g.id,
        status: 'running',
        phase: 'running',
        turn: 'red',
        red: { model: 'm-red' },
        black: { model: 'm-black' },
        winner: null,
      });
      // 不存在 → 404
      const notFound = await request(srv.server).get('/api/games/ghost');
      expect(notFound.status).toBe(404);
    } finally {
      await srv.dispose();
    }
  });
});

/* ---------- 用例 2:控制端点状态码 ---------- */

describe('REST 控制端点', () => {
  it('pause/resume/step:合法 200,非法状态 409,不存在 404', async () => {
    const gatedRed = gatePlayer('red', ['a4-a5', 'c4-c5']);
    const gatedBlack = gatePlayer('black', ['i7-i6', 'g7-g6']);
    const srv = await startServer((side) => (side === 'red' ? gatedRed.player : gatedBlack.player));
    try {
      const { id } = await createGame(srv.server, baseBody({ config: { maxTotalMoves: 4 } }));
      const arena = srv.registry.get(id);
      expect(arena).toBeDefined();
      await waitFor(() => arena!.moveCount === 0);

      // running:step → 409;pause → 200
      expect((await request(srv.server).post(`/api/games/${id}/step`)).status).toBe(409);
      expect((await request(srv.server).post(`/api/games/${id}/pause`)).status).toBe(200);
      expect(arena!.state).toBe('paused');

      // pause 幂等 → 200
      expect((await request(srv.server).post(`/api/games/${id}/pause`)).status).toBe(200);

      // 放行红方第 1 步(回合边界暂停)
      gatedRed.releaseNext();
      await waitFor(() => arena!.moveCount === 1);
      expect(arena!.state).toBe('paused');

      // paused:step → 200(黑方走第 2 步),完成后仍 paused
      const stepReq = request(srv.server).post(`/api/games/${id}/step`).then((r) => r.status);
      gatedBlack.releaseNext();
      expect(await stepReq).toBe(200);
      await waitFor(() => arena!.moveCount === 2);
      expect(arena!.state).toBe('paused');

      // resume → 200;running 后:step → 409,resume 幂等 → 200
      expect((await request(srv.server).post(`/api/games/${id}/resume`)).status).toBe(200);
      expect(arena!.state).toBe('running');
      expect((await request(srv.server).post(`/api/games/${id}/step`)).status).toBe(409);
      expect((await request(srv.server).post(`/api/games/${id}/resume`)).status).toBe(200);

      // 放行剩余步至终局(红第3步/黑第4步 → draw-max-moves)
      gatedRed.releaseNext();
      await waitFor(() => arena!.moveCount === 3);
      gatedBlack.releaseNext();
      await waitFor(() => arena!.state === 'finished');
      expect(arena!.moveCount).toBe(4);

      // finished:pause/resume/step → 409
      expect((await request(srv.server).post(`/api/games/${id}/pause`)).status).toBe(409);
      expect((await request(srv.server).post(`/api/games/${id}/resume`)).status).toBe(409);
      expect((await request(srv.server).post(`/api/games/${id}/step`)).status).toBe(409);

      // 不存在 id → 404
      expect((await request(srv.server).post('/api/games/ghost/pause')).status).toBe(404);
      expect((await request(srv.server).post('/api/games/ghost/step')).status).toBe(404);
    } finally {
      await srv.dispose();
    }
  });
});

/* ---------- 用例 3:回放读日志 ---------- */

describe('GET /api/games/:id/replay', () => {
  it('finish 后回放返回完整事件数组(seq 连续、类型齐备)', async () => {
    const srv = await startServer((side) => {
      const p = side === 'red' ? scriptPlayer('red', ['a4-a5', 'c4-c5']) : scriptPlayer('black', ['i7-i6', 'g7-g6']);
      return p;
    });
    try {
      const { id } = await createGame(srv.server, baseBody({ config: { maxTotalMoves: 2 } }));
      const arena = srv.registry.get(id)!;
      await waitFor(() => arena.state === 'finished');

      const rep = await request(srv.server).get(`/api/games/${id}/replay`);
      expect(rep.status).toBe(200);
      expect(JSON.stringify(rep.body)).not.toContain(SECRET);
      const events = rep.body.events as Array<{ seq: number; type: string; turn?: string }>;
      expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
      const types = events.map((e) => e.type);
      expect(types[0]).toBe('begin');
      expect(types).toContain('move');
      expect(types).toContain('draw');
      expect(types).toContain('finish');
      const moves = events.filter((e) => e.type === 'move');
      expect(moves).toHaveLength(2);
      expect(moves[0]).toMatchObject({ turn: 'red' });
      expect(moves[1]).toMatchObject({ turn: 'black' });
      const fin = events[events.length - 1]!;
      expect(fin).toMatchObject({ type: 'finish', winner: 'draw', reason: 'draw-max-moves' });
    } finally {
      await srv.dispose();
    }
  });
});

/* ---------- 用例 4:WS 建连 / 断线重连 ---------- */

describe('WS 实时流与断线重连', () => {
  it('since=0 收到 begin→seq 递增;断线后 since=lastSeq 补发不丢步;密钥不入 WS 帧', async () => {
    const gatedRed = gatePlayer('red', ['a4-a5', 'c4-c5']);
    const gatedBlack = gatePlayer('black', ['i7-i6', 'g7-g6']);
    const srv = await startServer((side) => (side === 'red' ? gatedRed.player : gatedBlack.player));
    try {
      const { id } = await createGame(srv.server, baseBody({ config: { maxTotalMoves: 6 } }));
      const arena = srv.registry.get(id)!;
      await waitFor(() => arena.moveCount === 0);

      // 建连 since=0 → 第一帧必为 begin(seq 1);sink 自建连起缓存,不丢早到帧
      const sink = openWs(srv.port, id, 0);
      await sink.opened;
      const begin = await sink.next<{ seq: number; event: { type: string } }>();
      expect(begin).toMatchObject({ seq: 1, event: { type: 'begin' } });

      // 放行红(seq2)、黑(seq3),帧序递增
      gatedRed.releaseNext();
      await waitFor(() => arena.moveCount === 1);
      const m2 = await sink.next<WsFrame>();
      expect(m2).toMatchObject({ seq: 2, event: { type: 'move', turn: 'red' } });

      gatedBlack.releaseNext();
      await waitFor(() => arena.moveCount === 2);
      const m3 = await sink.next<WsFrame>();
      expect(m3).toMatchObject({ seq: 3, event: { type: 'move', turn: 'black' } });

      // 断线:本地模拟(不再收帧)
      sink.ws.close();
      await sink.closed;

      // 离线期间再推进 2 步(seq4 红、seq5 黑)——这些只会进日志,客户端收不到
      gatedRed.releaseNext();
      await waitFor(() => arena.moveCount === 3);
      gatedBlack.releaseNext();
      await waitFor(() => arena.moveCount === 4);

      // 断线重连 since=lastSeq(3)→ 补发 seq4、seq5,不丢步
      const sink2 = openWs(srv.port, id, 3);
      await sink2.opened;
      const r4 = await sink2.next<WsFrame>();
      const r5 = await sink2.next<WsFrame>();
      expect(r4).toMatchObject({ seq: 4, event: { type: 'move', turn: 'red' } });
      expect(r5).toMatchObject({ seq: 5, event: { type: 'move', turn: 'black' } });
      sink2.ws.close();

      // 全量回放核对:seq 严格 1..N 连续,密钥不在任何 WS 帧
      const allText = JSON.stringify([...sink.all(), ...sink2.all()]);
      expect(allText).not.toContain(SECRET);
      const rep = await request(srv.server).get(`/api/games/${id}/replay`);
      const allEvents = rep.body.events as Array<{ seq: number; type: string }>;
      expect(allEvents.map((e) => e.seq)).toEqual(Array.from({ length: allEvents.length }, (_, i) => i + 1));
      expect(allEvents[3]).toMatchObject({ seq: 4 });
      expect(allEvents[4]).toMatchObject({ seq: 5 });

      // 密钥也不应出现在列表/详情响应
      for (const path of [`/api/games`, `/api/games/${id}`]) {
        const r = await request(srv.server).get(path);
        expect(JSON.stringify(r.body)).not.toContain(SECRET);
      }
    } finally {
      await srv.dispose();
    }
  });

  it('WS 连到不存在对局 → 收到 GAME_NOT_FOUND 并关闭', async () => {
    const srv = await startServer();
    try {
      const sink = openWs(srv.port, 'ghost', 0);
      await sink.opened;
      const msg = await sink.next<{ seq: number; event: { type: string; code?: string } }>();
      expect(msg.event.type).toBe('error');
      expect(msg.event.code).toBe('GAME_NOT_FOUND');
      await sink.closed;
    } finally {
      await srv.dispose();
    }
  });
});

/* ---------- 用例 5:容错(复审 round 1) ---------- */

describe('容错:畸形输入不崩溃', () => {
  it('畸形 % 编码 upgrade(如 /ws/games/%ZZ)→ 连接被销毁,进程存活,后续 REST 仍 200', async () => {
    const srv = await startServer();
    try {
      // 发送畸形 upgrade:path 段含非法百分号序列 %ZZ(裸 TCP,绕开 ws 客户端)
      await rawUpgrade(srv.port, '/ws/games/%ZZ?since=0');
      // 修复前:decodeURIComponent 抛 URIError → uncaughtException 崩溃进程;此处探测服务仍存活
      const probe = await request(srv.server).get('/api/games');
      expect(probe.status).toBe(200);
      expect(probe.body.games).toEqual([]);
      // 再发一次正规 upgrade,仍能正常握手(file 订阅仍在)
      const sink = openWs(srv.port, 'ghost', 0);
      await sink.opened;
      const msg = await sink.next<{ seq: number; event: { type: string; code?: string } }>();
      expect(msg.event.type).toBe('error');
      await sink.closed;
    } finally {
      await srv.dispose();
    }
  });

  it('超大 body → 413(不误落 500);错误体是统一 { error } 结构', async () => {
    const srv = await startServer();
    try {
      const res = await request(srv.server)
        .post('/api/games')
        .send({ red: { baseUrl: 'http://x', apiKey: 'k', model: 'm', padding: 'x'.repeat(300_000) } });
      expect(res.status).toBe(413);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBeDefined();
    } finally {
      await srv.dispose();
    }
  });
});

