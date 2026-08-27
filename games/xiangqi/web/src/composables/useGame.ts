import { reactive } from 'vue';
import { codeToSq, type Side, type Sq } from '../../../engine/types';
import type { GameEvent, Usage, ReviewEvent } from '../../../server/game-log';
// 回放/实时共用同一条走子重放代码路径(与 Replay 的 boardAt 同源)。
import { applyMoveToPieces, initialPiecesWithUid, isOnBoard, type UidPiece } from '../lib/replay';

//
// useGame —— 单局实时数据源(Task 19)。
//
// 契约(控制器):
// - `createGame(config) → { id }`:POST /api/games(新局表单提交);
// - `useGame(id)` 返回 `{ events, board, phase, lastMove, controls, costSummary, ... }`:
//   WS 订阅 `/ws/games/:id?since=lastSeq`,断线自动重连续传,补发/实时严格同源;
// - 事件 → 状态机:
//   * `begin` → phase=running + 红黑 model 元数据;
//   * `move`  → 重放棋盘(事件 move.from/to 应用到当前 board,棋子带**显式 uid**——走子同 key、吃子移除);
//   * `finish`→ phase=finished + 结果横幅数据;
//   * `illegal-attempt` → UI「裁判打回」计数与原因留档;
//   * `usage`:move → 按方累计 + 总计;review → 复盘无行棋方,只入总计(T20);
//   * `player-message(thought)` → 累积流式思考文本。
// - 按键 pause/resume/step 发 REST;`controls.destroy()` 于组件卸载时断开。
//
// 测试注入:opts.wsFactory(节点测试用 fake WebSocket)、opts.fetcher、opts.reconnectDelayMs。
//

/* ---------- 公开类型 ---------- */

export type GamePhase = 'connecting' | 'running' | 'paused' | 'finished' | 'error';
export type WsStatus = 'connecting' | 'open' | 'closed';

export type { UidPiece } from '../lib/replay';

export interface MoveRecord {
  seq: number;
  turn: Side;
  from: Sq;
  to: Sq;
  moveCode: string; // 如 'h3-e3'
  notation?: string;
  analysis?: string;
  elapsedMs?: number;
  usage?: Usage;
}

export interface RejectionRecord {
  seq: number;
  side: Side;
  round: number;
  reason: string;
}

/** 单方思考条目(ThoughtPanel 历史渲染):一回合一条,含回合号/文本/耗时/token。成本暂不展示(算不清)。 */
export interface ThoughtEntry {
  round: number;
  text: string;
  elapsedMs?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export interface SideViolations {
  pre: number;
  post: number;
  total: number;
}

export interface ResultInfo {
  winner: Side | 'draw';
  reason: string;
  ruleViolations: { red: SideViolations; black: SideViolations };
}

export interface SideCost {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  elapsedMs: number;
}

export interface CostSummary {
  red: SideCost;
  black: SideCost;
  total: SideCost;
}

export interface SideConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface NewGameConfig {
  red: SideConfig;
  black: SideConfig;
  config?: {
    illegalAttemptsLimit?: number;
    maxTotalMoves?: number;
    maxCostPerGame?: number;
    /** 本局思考模式(原则 E):'off' 关闭思考 | 'high' 适中思考 | 'max' 最大思考(三选一)。 */
    thinkingMode?: 'off' | 'high' | 'max';
  };
}

/* ---------- WS 抽象(测试可注入 fake) ---------- */

export interface WsLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
}
export type WsFactory = (url: string) => WsLike;

export interface UseGameOptions {
  wsFactory?: WsFactory;
  fetcher?: typeof fetch;
  /** 重连退避(ms);测试置 0/1 加速。 */
  reconnectDelayMs?: (attempt: number) => number;
  /** WS 基址(缺省基于当前 host)。测试一般不关心,url 由 factory 侧校验。 */
  wsBase?: string;
}

export interface GameControls {
  pause: () => Promise<unknown>;
  resume: () => Promise<unknown>;
  step: () => Promise<unknown>;
  destroy: () => void;
}

/* ---------- 小工具 ---------- */

const zeroCost = (): SideCost => ({ promptTokens: 0, completionTokens: 0, costUsd: 0, elapsedMs: 0 });

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

async function readError(res: Response): Promise<string> {
  try {
    const b = (await res.json()) as { error?: { hint?: string; message?: string } };
    return b?.error?.hint ?? b?.error?.message ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/* ---------- createGame ---------- */

export async function createGame(config: NewGameConfig, fetcher: typeof fetch = fetch): Promise<{ id: string }> {
  let res: Response;
  try {
    res = await fetcher('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
  } catch {
    throw new Error('无法连接服务器,请确认后端已启动');
  }
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as { id: string };
}

/* ---------- useGame ---------- */

export function useGame(gameId: string, opts: UseGameOptions = {}): UseGameState {
  const fetcher = opts.fetcher ?? fetch;
  const factory: WsFactory = opts.wsFactory ?? ((url) => new WebSocket(url) as unknown as WsLike);
  const delay = opts.reconnectDelayMs ?? ((a: number) => Math.min(500 * 2 ** (a - 1), 5000));
  const wsBase =
    opts.wsBase ??
    (typeof location !== 'undefined'
      ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
      : 'ws://localhost');

  const state = reactive({
    gameId,
    events: [] as GameEvent[],
    board: initialPiecesWithUid(),
    lastMove: null as { from: Sq; to: Sq } | null,
    lastSeq: 0,
    moves: [] as MoveRecord[],
    rejections: [] as RejectionRecord[],
    rejectCount: { red: 0, black: 0 } as Record<Side, number>,
    liveThoughts: { red: '', black: '' } as Record<Side, string>,
    phase: 'connecting' as GamePhase,
    wsStatus: 'connecting' as WsStatus,
    turn: 'red' as Side,
    thinking: { red: false, black: false } as Record<Side, boolean>,
    models: { red: undefined as string | undefined, black: undefined as string | undefined },
    first: 'red' as Side, // 先手方(取自 begin.first;旧日志缺省红先)
    thinkingMode: 'off' as 'off' | 'high' | 'max' | undefined, // 本局思考模式(begin.rules.thinkingMode;历史缺省 off)
    checkSeq: 0,
    checkSide: null as Side | null,
    result: null as ResultInfo | null,
    review: null as ReviewEvent | null,
    error: null as string | null,
    costSummary: { red: zeroCost(), black: zeroCost(), total: zeroCost() } as CostSummary,
  });

  let ws: WsLike | null = null;
  let destroyed = false;
  let fatal = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  /* ---------- 事件 → 棋盘/UI 状态机 ---------- */

  function applyMove(from: Sq, to: Sq): void {
    // 与回放 boardAt 共用同一实现(见 lib/replay.ts),实时/回放零重演偏差。
    state.board = applyMoveToPieces(state.board, from, to, state.lastSeq, state.turn);
  }

  function refreshThinking(): void {
    const on = state.phase === 'running';
    state.thinking.red = on && state.turn === 'red';
    state.thinking.black = on && state.turn === 'black';
  }

  function addUsage(side: Side, usage: Usage, elapsedMs?: number): void {
    const targets: SideCost[] = [state.costSummary[side], state.costSummary.total];
    for (const sc of targets) {
      sc.promptTokens += num(usage.promptTokens);
      sc.completionTokens += num(usage.completionTokens);
      sc.costUsd += num(usage.costUsd);
      if (typeof elapsedMs === 'number' && Number.isFinite(elapsedMs)) sc.elapsedMs += elapsedMs;
    }
  }

  function applyEvent(e: GameEvent): void {
    switch (e.type) {
      case 'begin': {
        state.phase = 'running';
        state.first = e.first ?? 'red';
        state.thinkingMode = e.rules?.thinkingMode ?? 'off';
        state.models.red = e.red?.model;
        state.models.black = e.black?.model;
        refreshThinking();
        break;
      }
      case 'move': {
        if (e.legal === false) break; // 非法留痕不入盘
        const from = codeToSq(e.move.from);
        const to = codeToSq(e.move.to);
        if (!isOnBoard(from) || !isOnBoard(to)) break;
        applyMove(from, to);
        state.lastMove = { from, to };
        state.moves.push({
          seq: e.seq,
          turn: e.turn,
          from,
          to,
          moveCode: `${e.move.from}-${e.move.to}`,
          notation: e.move.notation,
          analysis: e.analysis,
          elapsedMs: e.elapsedMs,
          usage: e.usage,
        });
        if (e.usage) addUsage(e.turn, e.usage, e.elapsedMs);
        if (e.analysis) state.liveThoughts[e.turn] = e.analysis;
        state.turn = e.turn === 'red' ? 'black' : 'red';
        refreshThinking();
        break;
      }
      case 'illegal-attempt': {
        state.rejections.push({ seq: e.seq, side: e.side, round: e.round, reason: e.reason });
        state.rejectCount[e.side] += 1;
        break;
      }
      case 'player-message': {
        if (e.phase === 'thought' && e.content) state.liveThoughts[e.side] += e.content;
        break;
      }
      case 'check': {
        state.checkSide = e.side;
        state.checkSeq += 1;
        break;
      }
      case 'captured':
      case 'retry':
      case 'timeout':
      case 'draw':
        break; // 板面已由 move 更新;其余为信息性事件
      case 'review': {
        // 赛后复盘摘要(T20):入 state.review;usage 无行棋方,只归 total 成本账。
        state.review = e;
        if (e.usage) {
          const total = state.costSummary.total;
          total.promptTokens += num(e.usage.promptTokens);
          total.completionTokens += num(e.usage.completionTokens);
          total.costUsd += num(e.usage.costUsd);
          if (typeof e.elapsedMs === 'number' && Number.isFinite(e.elapsedMs)) total.elapsedMs += e.elapsedMs;
        }
        break;
      }
      case 'finish': {
        const rv = e.ruleViolations;
        state.phase = 'finished';
        state.result = {
          winner: e.winner,
          reason: e.reason,
          ruleViolations: {
            red: { pre: num(rv.red.pre), post: num(rv.red.post), total: num(rv.red.pre) + num(rv.red.post) },
            black: { pre: num(rv.black.pre), post: num(rv.black.post), total: num(rv.black.pre) + num(rv.black.post) },
          },
        };
        refreshThinking();
        break;
      }
      case 'error': {
        state.phase = 'error';
        state.error = e.message ?? e.code;
        fatal = true; // 对局不存在类错误:不再重连
        break;
      }
    }
  }

  /* ---------- 连接/断线续传 ---------- */

  function scheduleReconnect(): void {
    if (destroyed || fatal) return;
    clearTimeout(reconnectTimer);
    const ms = delay(reconnectAttempt++);
    reconnectTimer = setTimeout(() => {
      if (destroyed || fatal) return;
      connect();
    }, ms);
  }

  function connect(): void {
    if (destroyed || fatal) return;
    const url = `${wsBase}/ws/games/${gameId}?since=${state.lastSeq}`;
    state.wsStatus = 'connecting';
    let socket: WsLike;
    try {
      socket = factory(url);
    } catch {
      scheduleReconnect();
      return;
    }
    ws = socket;
    socket.onopen = () => {
      state.wsStatus = 'open';
      reconnectAttempt = 0; // 连上即归零退避计数(T20 forward [Info-3])
    };
    socket.onmessage = (ev) => {
      if (ev == null || ev.data == null) return;
      let frame: { seq?: number; event?: GameEvent };
      try {
        frame = JSON.parse(String(ev.data)) as { seq?: number; event?: GameEvent };
      } catch {
        return;
      }
      const seq = frame.seq;
      // G3 流式思考:server 以 seq:0 帧实时推 player-message(player-message 不落日志,
      // 不占日志 seq)。在 seq 过滤之前特判:累积 liveThoughts,不推进 lastSeq/不重复。
      if (frame.event?.type === 'player-message') {
        applyEvent(frame.event);
        return;
      }
      if (frame.event?.type === 'error' && seq === 0) {
        applyEvent(frame.event);
        return;
      }
      if (typeof seq !== 'number' || Number.isNaN(seq)) return;
      if (seq <= state.lastSeq) return; // 断线补发区间过滤:重连后服务器只发 > since,<= 视为重复
      applyEvent(frame.event as GameEvent);
      state.lastSeq = seq;
      state.events.push(frame.event as GameEvent);
    };
    socket.onclose = () => {
      if (destroyed || fatal) {
        state.wsStatus = 'closed';
        return;
      }
      state.wsStatus = 'closed';
      scheduleReconnect();
    };
    socket.onerror = () => {
      /* 由 onclose 兜底重连 */
    };
  }

  /* ---------- 控制(REST) ---------- */

  function postControl(action: 'pause' | 'resume' | 'step'): Promise<unknown> {
    return fetcher(`/api/games/${gameId}/${action}`, { method: 'POST' })
      .then(async (res) => {
        if (!res.ok) throw new Error(await readError(res));
        if (action === 'pause') state.phase = 'paused';
        if (action === 'resume') state.phase = 'running';
        refreshThinking();
        return res.json();
      });
  }

  function destroy(): void {
    destroyed = true;
    clearTimeout(reconnectTimer);
    ws?.close();
    ws = null;
  }

  connect();

  const controls: GameControls = {
    pause: () => postControl('pause'),
    resume: () => postControl('resume'),
    step: () => postControl('step'),
    destroy,
  };
  // 直接在 reactive 上挂 controls(不 spread,否则丢失响应性),返回同一代理对象。
  return Object.assign(state, { controls }) as unknown as UseGameState;
}

/** 对外只读视图:含数据 + 控制;为测试与模板提供稳定形状。 */
export interface UseGameState {
  gameId: string;
  events: GameEvent[];
  board: UidPiece[];
  lastMove: { from: Sq; to: Sq } | null;
  lastSeq: number;
  moves: MoveRecord[];
  rejections: RejectionRecord[];
  rejectCount: Record<Side, number>;
  liveThoughts: Record<Side, string>;
  phase: GamePhase;
  wsStatus: WsStatus;
  turn: Side;
  thinking: Record<Side, boolean>;
  models: { red: string | undefined; black: string | undefined };
  first: Side;
  thinkingMode: 'off' | 'high' | 'max' | undefined;
  checkSeq: number;
  checkSide: Side | null;
  result: ResultInfo | null;
  review: ReviewEvent | null;
  error: string | null;
  costSummary: CostSummary;
  controls: GameControls;
}