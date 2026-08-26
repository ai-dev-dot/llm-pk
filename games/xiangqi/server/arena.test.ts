import { describe, expect, it } from 'vitest';
import { Arena, NetworkError, type ArenaConfig, type Player } from './arena';
import { GameRegistry } from './game-registry';
import type { FinishEvent, GameEvent, IllegalAttemptEvent, MoveEvent, RetryEvent } from './game-log';
import type { Side } from '../engine/types';

/* ---------- 工具 ---------- */

function memSink(): { lines: string[]; write(line: string): void } {
  return { lines: [], write(line: string | Uint8Array) { this.lines.push(String(line)); } };
}

function collect(arena: Arena): GameEvent[] {
  const arr: GameEvent[] = [];
  arena.onEvent.on('event', (e: GameEvent) => arr.push(e));
  return arr;
}

const lastFinish = (ev: GameEvent[]): FinishEvent | undefined =>
  [...ev].reverse().find((e): e is FinishEvent => e.type === 'finish');

const lastOfType = <T extends GameEvent>(ev: GameEvent[], t: T['type']): T | undefined =>
  [...ev].reverse().find((e): e is T => e.type === t);

const asMoves = (ev: GameEvent[]) => ev.filter((e): e is MoveEvent => e.type === 'move').map((e) => e.move);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 按侧脚本化走法 Player:string[] 循环消费(可供多步往复局面),或 (side)=>move 函数。 */
function scriptPlayer(side: Side, script: string[] | ((side: Side) => string)): Player {
  const calls = { red: 0, black: 0 } as Record<Side, number>;
  return {
    side,
    model: `fake-${side}`,
    async pickMove() {
      const i = calls[side]++;
      const mv = typeof script === 'function' ? script(side) : script[i % script.length];
      return { analysis: `分析-${side}-${i}`, move: mv };
    },
  };
}

/** 造一个默认配置的 Arena(红兵进、黑卒进两条直线,供 draw-max-moves 用小局)。 */
function baseArena(gameId = 'g-test', over: Partial<ArenaConfig> = {}) {
  const sink = memSink();
  const red = over.red ?? { player: scriptPlayer('red', ['a4-a5', 'a5-a6']) };
  const black = over.black ?? { player: scriptPlayer('black', ['i7-i6', 'i6-i5']) };
  const cfg: ArenaConfig = { gameId, sink, red, black, ...over };
  return new Arena(cfg);
}

/* ---------- 用例 1:连续非法打回 → 判负 ---------- */

describe('Arena 打回循环与判负', () => {
  it('同一回合连续 3 次非法 → finish reason illegal-moves,winner=对方,pre/post 分阶段', async () => {
    const arena = baseArena('g1', {
      red: { player: { side: 'red', pickMove: async () => ({ analysis: 'x', move: '这不合法' }) } },
      black: { player: { side: 'black', pickMove: async () => ({ analysis: 'x', move: '从不调用' }) } },
    });
    const events = collect(arena);

    await arena.start();

    expect(arena.state).toBe('finished');
    const fin = lastFinish(events)!;
    expect(fin.reason).toBe('illegal-moves');
    expect(fin.winner).toBe('black');
    expect(fin.ruleViolations.red).toEqual({ pre: 1, post: 2 });

    const illegal = events.filter((e): e is IllegalAttemptEvent => e.type === 'illegal-attempt');
    expect(illegal).toHaveLength(3);
    expect(illegal.map((e) => e.round)).toEqual([1, 2, 3]);
    expect(illegal[0]!.violations).toEqual({ pre: 1, post: 0 });
    expect(illegal[1]!.violations).toEqual({ pre: 1, post: 1 });
    expect(illegal[2]!.violations).toEqual({ pre: 1, post: 2 });
    // 打回文案不得泄露合法走法
    for (const e of illegal) expect(e.reason.length).toBeGreaterThan(0);
  });

  it('格式失败与非法共用同一打回计数器(混排 3 次同样判负)', async () => {
    const bad = ['这哪来的步', 'h9-h8', 'a1-z9']; // 解析失败 → 非法(起点无子) → 解析失败
    const arena = baseArena('g2', {
      red: { player: { side: 'red', pickMove: async () => ({ analysis: 'x', move: bad.shift() ?? '非法' }) } },
      black: { player: scriptPlayer('black', ['i7-i6']) },
    });
    const events = collect(arena);

    await arena.start();

    expect(arena.state).toBe('finished');
    const fin = lastFinish(events)!;
    expect(fin.reason).toBe('illegal-moves');
    expect(fin.ruleViolations.red).toEqual({ pre: 1, post: 2 });
  });
});

/* ---------- 用例 2 & 3:干净走法换 side / 暂停-单步-恢复 ---------- */

describe('Arena 回合流转与暂停/单步/恢复', () => {
  it('clean move 后 turn 更换,双方事件落盘,会话无泄漏', async () => {
    const arena = baseArena('g3', {
      rules: { maxTotalMoves: 2 },
      red: { player: scriptPlayer('red', ['a4-a5']) },
      black: { player: scriptPlayer('black', ['i7-i6']) },
    });
    const events = collect(arena);

    await arena.start();

    expect(arena.state).toBe('finished');
    expect(asMoves(events)).toEqual([
      { from: 'a4', to: 'a5' },
      { from: 'i7', to: 'i6' },
    ]);
    const moves = events.filter((e): e is MoveEvent => e.type === 'move');
    expect(moves[0]!.turn).toBe('red');
    expect(moves[1]!.turn).toBe('black');
    // 双方 analysis 各自只进本方会话,互不可见
    arena.sessionOf('red').assertNoLeak(arena.sessionOf('black'));
    arena.sessionOf('black').assertNoLeak(arena.sessionOf('red'));
    // 2 步达步数上限 → 判和
    expect(lastFinish(events)!.reason).toBe('draw-max-moves');
    expect(lastFinish(events)!.winner).toBe('draw');
    const draw = lastOfType<GameEvent>(events, 'draw');
    expect(draw!.type).toBe('draw');
  });

  it('暂停/单步/恢复:每步一回合,pause 幂等,resume 续跑至终局', async () => {
    const arena = baseArena('g4', { rules: { maxTotalMoves: 3 } });
    const events = collect(arena);
    const started = arena.start();

    // 第 1 步后暂停(按 move 计数,begin 占 seq 1,不能按 seq 判)
    const moved1 = new Promise<void>((res) => {
      let movesSeen = 0;
      const h = (e: GameEvent) => {
        if (e.type === 'move' && ++movesSeen === 1) {
          arena.onEvent.off('event', h);
          arena.pause();
          res();
        }
      };
      arena.onEvent.on('event', h);
    });
    await moved1;
    await sleep(0);
    expect(arena.state).toBe('paused');
    expect(arena.moveCount).toBe(1);

    // 幂等 pause
    arena.pause();
    expect(arena.state).toBe('paused');

    // 单步:黑方走第 2 步,终局不结束
    const single = arena.step();
    await single;
    expect(arena.moveCount).toBe(2);
    expect(arena.state).toBe('paused');

    // 恢复:红方走第 3 步 → draw-max-moves
    arena.resume();
    await started;
    expect(arena.state).toBe('finished');
    expect(lastFinish(events)!.reason).toBe('draw-max-moves');
  });
});

/* ---------- 用例 4:步数上限判和 ---------- */

describe('Arena 守卫', () => {
  it('moveCount 达 maxTotalMoves → draw-max-moves 判和', async () => {
    const arena = baseArena('g5', { rules: { maxTotalMoves: 4 } });
    const events = collect(arena);

    await arena.start();

    expect(arena.state).toBe('finished');
    expect(arena.moveCount).toBe(4);
    expect(lastFinish(events)!.winner).toBe('draw');
    expect(lastFinish(events)!.reason).toBe('draw-max-moves');
  });

  it('maxCostPerGame 超限 → draw-cost-limit 友好收尾', async () => {
    const arena = baseArena('g6', {
      maxCostPerGame: 0.02,
      red: {
        player: {
          side: 'red',
          async pickMove() {
            return { analysis: 'x', move: 'a4-a5', usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.015 } };
          },
        },
      },
      black: {
        player: {
          side: 'black',
          async pickMove() {
            return { analysis: 'x', move: 'i7-i6', usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.015 } };
          },
        },
      },
    });
    const events = collect(arena);

    await arena.start();

    expect(arena.state).toBe('finished');
    expect(arena.moveCount).toBe(2);
    const draw = lastOfType<GameEvent>(events, 'draw')!;
    expect(draw.type).toBe('draw');
    expect('reason' in draw && draw.reason).toBe('cost-limit');
    expect(lastFinish(events)!.reason).toBe('draw-cost-limit');
    expect(lastFinish(events)!.winner).toBe('draw');
  });

  it('重复局面:同 board+turn 快照计次≥3 → draw-repeat 判和', async () => {
    // 红车 a1↔a2、黑车 i10↔i9 往复 3 轮 → 初始局面(红先)出现第 3 次
    const arena = baseArena('g7', {
      red: { player: scriptPlayer('red', ['a1-a2', 'a2-a1']) },
      black: { player: scriptPlayer('black', ['i10-i9', 'i9-i10']) },
    });
    const events = collect(arena);

    await arena.start();

    expect(arena.state).toBe('finished');
    const draw = lastOfType<GameEvent>(events, 'draw')!;
    expect(draw.type).toBe('draw');
    expect('reason' in draw && draw.reason).toBe('repeat');
    expect(lastFinish(events)!.reason).toBe('draw-repeat');
    expect(lastFinish(events)!.winner).toBe('draw');
  });
});

/* ---------- 网络重试 ---------- */

describe('Arena 网络重试', () => {
  it('首个网络错误 → retry 事件并指数退避,随后成功续走', async () => {
    let calls = 0;
    const arena = baseArena('g8', {
      rules: { maxTotalMoves: 2 },
      networkRetryBaseDelayMs: 0,
      red: {
        player: {
          side: 'red',
          async pickMove() {
            calls++;
            if (calls === 1) throw new NetworkError('网络抖动');
            return { analysis: 'x', move: 'a4-a5' };
          },
        },
      },
      black: { player: scriptPlayer('black', ['i7-i6']) },
    });
    const events = collect(arena);

    await arena.start();

    expect(calls).toBe(2);
    const retries = events.filter((e): e is RetryEvent => e.type === 'retry');
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ side: 'red', attempt: 1, cause: 'network' });
    expect(arena.state).toBe('finished');
    expect(lastFinish(events)!.reason).toBe('draw-max-moves');
  });

  it('NetworkError(retryable=false) 不重试,按内部错误收尾(T15 F3)', async () => {
    let calls = 0;
    const arena = baseArena('g-f3', {
      networkRetryBaseDelayMs: 0,
      red: {
        player: {
          side: 'red',
          async pickMove() {
            calls++;
            throw new NetworkError('key 无效(400)', false);
          },
        },
      },
      black: { player: scriptPlayer('black', ['i7-i6']) },
    });
    const events = collect(arena);

    await arena.start();

    expect(calls).toBe(1); // 绝不重试
    expect(events.filter((e): e is RetryEvent => e.type === 'retry')).toHaveLength(0);
    const fin = lastFinish(events)!;
    expect(fin.reason).toBe('internal-error');
    expect(fin.winner).toBe('draw');
    const errs = events.filter((e) => e.type === 'error');
    expect(errs).toHaveLength(1);
  });

  it('网络重试超限 → 判该方负 reason timeout(默认 3 次退避)', async () => {
    const retryCauses: string[] = [];
    const arena = baseArena('g9', {
      networkRetryBaseDelayMs: 0,
      red: {
        player: {
          side: 'red',
          async pickMove() {
            retryCauses.push('attempt');
            throw new NetworkError('持续不可用');
          },
        },
      },
      black: { player: scriptPlayer('black', ['i7-i6']) },
    });
    const events = collect(arena);

    await arena.start();

    expect(arena.state).toBe('finished');
    expect(retryCauses).toHaveLength(4); // 原调用 + 3 次重试
    const retries = events.filter((e): e is RetryEvent => e.type === 'retry');
    expect(retries.map((e) => e.attempt)).toEqual([1, 2, 3]);
    expect(lastFinish(events)!.reason).toBe('timeout');
    expect(lastFinish(events)!.winner).toBe('black');
  });
});

/* ---------- GameRegistry ---------- */

describe('GameRegistry', () => {
  it('create/get/dispose:按 gameId 路由,重复 create 报错,dispose 后消失', () => {
    const reg = new GameRegistry();
    const sink = memSink();
    const a = reg.create({
      red: { player: scriptPlayer('red', ['a4-a5']) },
      black: { player: scriptPlayer('black', ['i7-i6']) },
      sink,
    });
    expect(reg.has(a.gameId)).toBe(true);
    expect(reg.get(a.gameId)).toBe(a);
    expect(() =>
      reg.create({
        gameId: a.gameId,
        red: { player: scriptPlayer('red', ['a4-a5']) },
        black: { player: scriptPlayer('black', ['i7-i6']) },
        sink: memSink(),
      }),
    ).toThrow(/gameId/);
    expect(reg.dispose(a.gameId)).toBe(true);
    expect(reg.get(a.gameId)).toBeUndefined();
    expect(reg.dispose(a.gameId)).toBe(false);
  });

  it('dispose 运行中的 arena 会中止并广播 finish', async () => {
    const reg = new GameRegistry();
    // 首个 pickMove 永不返回 → 对局保持 running(悬挂状态供 dispose 中止)
    const hang = async () => new Promise<never>(() => {});
    const a = reg.create({
      red: { player: { side: 'red', pickMove: hang } },
      black: { player: { side: 'black', pickMove: hang } },
      sink: memSink(),
    });
    const events = collect(a);
    a.start();
    await sleep(0);
    expect(a.state).toBe('running');

    reg.dispose(a.gameId);
    expect(a.state).toBe('finished');
    expect(lastFinish(events)!.winner).toBe('draw');
  });
});