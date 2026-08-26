//
// Task 22 —— 端到端冒烟(无真实模型 key)。
//
// 覆盖(controller 交付要求):
// - 启动 server(注入脚本化 Player,走法序列固定,绝不触网);
// - POST /api/games 建局 → arena 自动跑至 finish;
// - 读日志文件(JSONL)→ GET /api/games/:id/replay 与日志事件**逐条对齐**;
// - 校验 finish(winner/reason/分阶段 ruleViolations);
// - 密钥隔离:断言日志文件/回放响应/对局响应不含 api_key(baseUrl/apiKey/密钥值)。
//
// 三种脚本化场景(确定性,无超时风险):
//   A) 红方连续非法(红必输 illegal-moves,red 违规分阶段 pre=1/post=2);
//   B) 红黑小局到步数上限(draw-max-moves,违规全 0);
//   C) 配齐 review 三要素但 client 抛错 → 复盘降级:无 review 事件、对局结论不变。
//
// 运行:cd games/xiangqi && npm run smoke
// 退出码:0=通过;1=断言失败 / 脚本错误。不读写 config.json,无网络调用。
//

import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createXiangqiServer, type PlayerFactory, type XiangqiServer } from '../server/http';
import type { Player, MoveChoice } from '../server/arena';
import type { ReviewClient } from '../server/review';
import { readAllEvents, type GameEvent } from '../server/game-log';
import type { Side } from '../engine/types';

/* ---------- 常量 ---------- */

const SECRET = 'sk-smoke-secret-0000';
/** 敏感键名(与 game-log.sanitizeForLog 黑名单相交);日志中一个都不该出现。 */
const SENSITIVE_RE = /api_key|apiKey|baseUrl|base_url|authorization|x-api-key|secret/i;

/* ---------- 微型断言与打印 ---------- */

let passed = 0;
function ok(msg: string): void {
  passed++;
  console.log(`  ✓ ${msg}`);
}
function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`断言失败: ${msg}`);
  ok(msg);
}

/* ---------- 注入:脚本化 Player ---------- */

/** 按固定脚本循环行棋(测试/冒烟专用,不触网)。 */
function scriptPlayer(side: Side, script: string[]): Player {
  let i = 0;
  return {
    side,
    model: `smoke-${side}`,
    async pickMove(): Promise<MoveChoice> {
      i += 1;
      return { analysis: `[smoke] ${side} 第${i}次思考`, move: script[(i - 1) % script.length] };
    },
  };
}

/** 复盘替身:任一调用直接抛错(验证降级路径)。 */
const throwingReviewClient: ReviewClient = {
  async generate() {
    throw new Error('smoke: review client 故意失败(应降级)');
  },
};

/* ---------- 本地 HTTP 客户端(Connection: close,避免 keep-alive 阻塞 server.close) ---------- */

function requestJson(
  port: number,
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        headers: {
          ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(payload !== undefined ? { 'content-length': Buffer.byteLength(payload) } : {}),
          connection: 'close',
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => {
          let body: unknown = null;
          if (data) {
            try {
              body = JSON.parse(data) as unknown;
            } catch {
              body = data;
            }
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function createGame(port: number, body: Record<string, unknown>): Promise<string> {
  const { status, body: resp } = await requestJson(port, '/api/games', { method: 'POST', body });
  if (status !== 201) throw new Error(`POST /api/games → ${status}: ${JSON.stringify(resp)}`);
  const id = (resp as { id?: unknown }).id;
  if (typeof id !== 'string' || id === '') throw new Error('POST /api/games 未返回 id');
  return id;
}

async function replayOf(port: number, id: string): Promise<GameEvent[]> {
  const { status, body } = await requestJson(port, `/api/games/${id}/replay`);
  if (status !== 200) throw new Error(`GET /replay → ${status}: ${JSON.stringify(body)}`);
  return (body as { events?: unknown }).events as GameEvent[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitForFinish(srv: XiangqiServer, id: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const arena = srv.registry.get(id);
    if (arena && arena.state === 'finished') return;
    if (Date.now() - start > timeoutMs) throw new Error(`waitForFinish 超时(${timeoutMs}ms): ${id}`);
    await sleep(5);
  }
}

/* ---------- 断言工具 ---------- */

/** 读 JSONL 文件 → 事件数组(冒烟自读日志,与 replay 端点同源)。 */
function readLogEvents(logPath: string): GameEvent[] {
  return readAllEvents(logPath);
}

const only = <T extends GameEvent['type']>(events: GameEvent[], t: T): Extract<GameEvent, { type: T }>[] =>
  events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === t);

function assertEventsMatch(log: GameEvent[], mirror: GameEvent[], replay: GameEvent[], id: string): void {
  check(log.length === replay.length, `[${id}] 日志事件数(${log.length}) == replay 事件数(${replay.length})`);
  check(log.length === mirror.length, `[${id}] 日志事件数(${log.length}) == 内存镜像事件数(${mirror.length})`);
  for (let i = 0; i < log.length; i++) {
    if (JSON.stringify(log[i]) !== JSON.stringify(replay[i])) {
      throw new Error(
        `[${id}] 第 ${i + 1} 条事件 日志/replay 不一致\n日志: ${JSON.stringify(log[i])}\nReplay: ${JSON.stringify(replay[i])}`,
      );
    }
    if (JSON.stringify(log[i]) !== JSON.stringify(mirror[i])) {
      throw new Error(
        `[${id}] 第 ${i + 1} 条事件 日志/内存镜像 不一致\n日志: ${JSON.stringify(log[i])}\n镜像: ${JSON.stringify(mirror[i])}`,
      );
    }
  }
  const seqs = log.map((e) => e.seq);
  check(
    seqs.every((s, i) => s === i + 1),
    `[${id}] seq 严格 1..${seqs.length} 连续`,
  );
}

function assertNoSecrets(text: string, label: string): void {
  check(!text.includes(SECRET), `${label} 不含密钥值`);
  check(!SENSITIVE_RE.test(text), `${label} 不含敏感键名(baseUrl/api_key/...)`);
}

/* ---------- 场景 A:红方连续非法 → 判负 ---------- */

async function scenarioA(port: number, srv: XiangqiServer, id: string): Promise<void> {
  const rec = srv.store.get(id)!;
  const logPath = rec.logPath;
  const raw = readFileSync(logPath, 'utf8');
  const log = readLogEvents(logPath);
  const mirror = rec.events;
  const replay = await replayOf(port, id);

  check(log.length === 5, `[A] 事件总数=5(begin + 3 打回 + finish),实际 ${log.length}`);
  const types = log.map((e) => e.type);
  check(types.join(',') === 'begin,illegal-attempt,illegal-attempt,illegal-attempt,finish', '[A] 事件类型序列正确');

  // 日志 == 内存镜像 == replay 逐条对齐 + seq 连续
  assertEventsMatch(log, mirror, replay, id);

  const [begin] = only(log, 'begin');
  check(begin.red.model === 'smoke-red' && begin.black.model === 'smoke-black', '[A] begin 携带红黑 model 元数据');
  check(begin.rules?.maxTotalMoves === 200, '[A] config.maxTotalMoves 透传进 begin.rules');

  const illegals = only(log, 'illegal-attempt');
  check(illegals.length === 3, '[A] illegal-attempt ×3');
  check(illegals.map((e) => e.round).join(',') === '1,2,3', '[A] 打回 round 1→2→3');
  check(illegals.every((e) => e.side === 'red'), '[A] 打回方恒为 red');
  check(
    illegals[0]!.violations.pre === 1 && illegals[0]!.violations.post === 0
    && illegals[1]!.violations.pre === 1 && illegals[1]!.violations.post === 1
    && illegals[2]!.violations.pre === 1 && illegals[2]!.violations.post === 2,
    '[A] 违规分阶段:第一次打回前 pre=1,此后重犯进 post',
  );

  const fin = only(log, 'finish')[0]!;
  check(fin.winner === 'black' && fin.reason === 'illegal-moves', '[A] finish:红连败 3 次 → black 胜,reason=illegal-moves');
  check(
    fin.ruleViolations.red.pre === 1 && fin.ruleViolations.red.post === 2,
    '[A] finish ruleViolations.red = { pre:1, post:2 }',
  );
  check(
    fin.ruleViolations.black.pre === 0 && fin.ruleViolations.black.post === 0,
    '[A] finish ruleViolations.black = { pre:0, post:0 }(黑未行棋)',
  );

  // 密钥隔离
  assertNoSecrets(raw, `[A] 原始日志文件 ${logPath}`);
  assertNoSecrets(JSON.stringify(replay), '[A] replay 响应体');
  const detail = await requestJson(port, `/api/games/${id}`);
  assertNoSecrets(JSON.stringify(detail.body), '[A] GET /:id 响应体');
}

/* ---------- 场景 B:红黑小局 → 步数上限和 ---------- */

async function scenarioB(port: number, srv: XiangqiServer, id: string): Promise<void> {
  const rec = srv.store.get(id)!;
  const raw = readFileSync(rec.logPath, 'utf8');
  const log = readLogEvents(rec.logPath);
  const mirror = rec.events;
  const replay = await replayOf(port, id);

  check(log.length === 5, `[B] 事件总数=5(begin + 2 move + draw + finish),实际 ${log.length}`);
  check(
    log.map((e) => e.type).join(',') === 'begin,move,move,draw,finish',
    '[B] 事件类型序列正确',
  );

  assertEventsMatch(log, mirror, replay, id);

  const moves = only(log, 'move');
  check(moves.length === 2, '[B] move ×2');
  check(moves[0]!.turn === 'red' && moves[0]!.move.from === 'a4' && moves[0]!.move.to === 'a5', '[B] 红 a4→a5');
  check(moves[1]!.turn === 'black' && moves[1]!.move.from === 'i7' && moves[1]!.move.to === 'i6', '[B] 黑 i7→i6');
  check(moves.every((m) => m.legal === true), '[B] 两步均 legal');

  const [draw] = only(log, 'draw');
  check(draw.reason === 'max-moves', '[B] draw 事件 reason=max-moves');

  const fin = only(log, 'finish')[0]!;
  check(fin.winner === 'draw' && fin.reason === 'draw-max-moves', '[B] finish:draw,reason=draw-max-moves');
  check(
    fin.ruleViolations.red.pre === 0 && fin.ruleViolations.red.post === 0
    && fin.ruleViolations.black.pre === 0 && fin.ruleViolations.black.post === 0,
    '[B] ruleViolations 全 0(无打回)',
  );

  assertNoSecrets(raw, `[B] 原始日志文件 ${rec.logPath}`);
  assertNoSecrets(JSON.stringify(replay), '[B] replay 响应体');
}

/* ---------- 场景 C:复盘配齐凭据但 client 抛错 → 降级 ---------- */

async function scenarioC(port: number, srv: XiangqiServer, id: string): Promise<void> {
  const rec = srv.store.get(id)!;
  const log = readLogEvents(rec.logPath);
  const replay = await replayOf(port, id);

  check(only(log, 'finish').length === 1, '[C] 对局正常终局');
  await sleep(50); // 等 review 异步(若误触发)落地窗口
  const reread = readLogEvents(rec.logPath);
  const finished = only(reread, 'finish')[0]!;
  check(finished.winner === 'draw' && finished.reason === 'draw-max-moves', '[C] finish 结论不受降级影响');
  check(!replay.some((e) => e.type === 'review'), '[C] replay 无 review 事件');
  check(!reread.some((e) => e.type === 'review'), '[C] 日志无 review 事件(降级静默)');
  ok('[C] 复盘降级:client 失败 → 无 review 落地,对局结论不变');
}

/* ---------- main ---------- */

async function main(): Promise<void> {
  const logDir = mkdtempSync(join(tmpdir(), 'xiangqi-e2e-smoke-'));
  console.log(`日志临时目录: ${logDir}`);

  // 每个场景一套固定走法(通过 mode 切换注入 Player)
  let mode: 'illegal-red' | 'draw' | 'draw-review' = 'draw';
  const buildPlayer: PlayerFactory = (side) => {
    if (mode === 'illegal-red') {
      return side === 'red'
        ? scriptPlayer('red', ['a4-a9', 'a4-a9', 'a4-a9'])
        : scriptPlayer('black', ['i7-i6']);
    }
    return side === 'red'
      ? scriptPlayer('red', ['a4-a5', 'c4-c5'])
      : scriptPlayer('black', ['i7-i6', 'g7-g6']);
  };

  const srv = createXiangqiServer({ logDir, buildPlayer, reviewClient: throwingReviewClient });
  srv.server.listen(0);
  await once(srv.server, 'listening');
  const port = (srv.server.address() as AddressInfo).port;
  console.log(`smoke server: http://127.0.0.1:${port}`);

  try {
    const baseBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      red: { baseUrl: 'http://smoke.invalid', apiKey: SECRET, model: 'smoke-red' },
      black: { baseUrl: 'http://smoke.invalid', apiKey: SECRET, model: 'smoke-black' },
      ...overrides,
    });

    console.log('\n[场景 A] 红方连续非法 → 判负');
    mode = 'illegal-red';
    const idA = await createGame(port, baseBody({ config: { maxTotalMoves: 200 } }));
    await waitForFinish(srv, idA);
    await scenarioA(port, srv, idA);

    console.log('\n[场景 B] 红黑小局 → 步数上限和');
    mode = 'draw';
    const idB = await createGame(port, baseBody({ config: { maxTotalMoves: 2 } }));
    await waitForFinish(srv, idB);
    await scenarioB(port, srv, idB);

    console.log('\n[场景 C] 复盘降级');
    mode = 'draw';
    const idC = await createGame(
      port,
      baseBody({
        config: { maxTotalMoves: 2 },
        review: { baseUrl: 'http://review.invalid', apiKey: 'sk-review-secret', model: 'cm-review' },
      }),
    );
    await waitForFinish(srv, idC);
    await scenarioC(port, srv, idC);

    // 全目录扫描:任何日志文件都不含敏感键名/密钥值(对应验收 9 的 grep 语义)
    console.log('\n[日志目录密钥扫描]');
    const files = readdirSync(logDir).filter((f) => f.endsWith('.jsonl'));
    check(files.length >= 3, `日志目录内有 ${files.length} 个对局日志文件`);
    for (const f of files) {
      const text = readFileSync(join(logDir, f), 'utf8');
      assertNoSecrets(text, `logs/${f}`);
    }

    console.log(`\n冒烟通过:${passed} 项断言,0 失败。`);
  } finally {
    await srv.dispose();
    rmSync(logDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('\nsmoke 失败:');
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});