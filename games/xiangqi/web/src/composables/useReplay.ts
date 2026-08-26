//
// useReplay —— 单局回放数据源(Task 20)。
// 契约:读 `GET /api/games/:id/replay`(事件数组),时间轴以事件 `seq` 为轴;
// 棋盘/履历/成本/结果全部由纯函数从事件重建(**绝不触 arena 运行时**,无 WS、无控制端点)。
// 控制:play/pause/toggle/step/back/seekTo(拖动)/setSpeed,组件卸载 destroy。
//
// 测试注入:opts.fetcher、opts.baseStepMs(播放步进间隔)。
//
import { reactive } from 'vue';
import type { GameEvent } from '../../../server/game-log';
import type { Sq } from '../../../engine/types';
import {
  boardAt,
  costAt,
  initialPiecesWithUid,
  modelsAt,
  movesAt,
  nextSeq,
  prevSeq,
  rejectCountAt,
  resultAt,
  reviewOf,
  seqPointsOf,
  type CostSnapshot,
  type ResultSnapshot,
  type ReplayMoveRecord,
  type ReviewSnapshot,
  type UidPiece,
} from '../lib/replay';

/* ---------- 公开类型 ---------- */

export type ReplayPhase = 'loading' | 'ready' | 'error';

export interface ReplayControls {
  play: () => void;
  pause: () => void;
  toggle: () => void;
  step: () => void;
  back: () => void;
  seekTo: (seq: number) => void;
  setSpeed: (n: number) => void;
  destroy: () => void;
}

export interface UseReplayOptions {
  fetcher?: typeof fetch;
  /** 每步间隔(ms,速度因子在组内乘除);缺省 800。 */
  baseStepMs?: number;
}

export interface UseReplayState {
  gameId: string;
  events: GameEvent[];
  phase: ReplayPhase;
  error: string | null;
  /** 当前时间轴位置(seq)。 */
  cur: number;
  playing: boolean;
  speed: number;
  /** 时间轴锚点(seq):0 + 合法 move + finish。 */
  steps: number[];
  finishSeq: number | null;
  board: UidPiece[];
  lastMove: { from: Sq; to: Sq } | null;
  moves: ReplayMoveRecord[];
  rejectCount: { red: number; black: number };
  models: { red: string | undefined; black: string | undefined };
  result: ResultSnapshot | null;
  review: ReviewSnapshot | null;
  costs: CostSnapshot;
  controls: ReplayControls;
}

/* ---------- 小工具 ---------- */

async function readError(res: Response): Promise<string> {
  try {
    const b = (await res.json()) as { error?: { hint?: string; message?: string } };
    return b?.error?.hint ?? b?.error?.message ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/* ---------- useReplay ---------- */

export function useReplay(gameId: string, opts: UseReplayOptions = {}): UseReplayState {
  const fetcher = opts.fetcher ?? fetch;
  const baseStepMs = opts.baseStepMs ?? 800;

  const state = reactive({
    gameId,
    events: [] as GameEvent[],
    phase: 'loading' as ReplayPhase,
    error: null as string | null,
    cur: 0,
    playing: false,
    speed: 1,
    steps: [] as number[],
    finishSeq: null as number | null,
    board: initialPiecesWithUid() as UidPiece[],
    lastMove: null as { from: Sq; to: Sq } | null,
    moves: [] as ReplayMoveRecord[],
    rejectCount: { red: 0, black: 0 } as { red: number; black: number },
    models: { red: undefined as string | undefined, black: undefined as string | undefined },
    result: null as ResultSnapshot | null,
    review: null as ReviewSnapshot | null,
    costs: costAt([], 0) as CostSnapshot,
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  let destroyed = false;

  const maxStep = (): number => {
    const last = state.steps[state.steps.length - 1];
    return typeof last === 'number' ? last : 0;
  };

  /** 由当前 cur 重算整组派生数据(纯函数)。 */
  function refresh(): void {
    const seq = state.cur;
    state.board = boardAt(state.events, seq);
    const moves = movesAt(state.events, seq);
    state.moves = moves;
    state.lastMove = moves.length > 0 ? { from: moves[moves.length - 1]!.from, to: moves[moves.length - 1]!.to } : null;
    state.rejectCount = rejectCountAt(state.events, seq);
    state.costs = costAt(state.events, seq);
    state.result = resultAt(state.events, seq);
    const models = modelsAt(state.events, seq);
    state.models.red = models?.red;
    state.models.black = models?.black;
    state.review = reviewOf(state.events);
  }

  function startTimer(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (!state.playing || state.events.length === 0) return;
    const ms = Math.max(1, baseStepMs / state.speed);
    timer = setInterval(() => {
      if (destroyed) return;
      const nx = nextSeq(state.steps, state.cur);
      if (nx === state.cur) {
        pause();
        return;
      }
      state.cur = nx;
      refresh();
    }, ms);
  }

  function pause(): void {
    state.playing = false;
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  function play(): void {
    if (state.events.length === 0 || state.steps.length <= 1) return;
    if (state.cur >= maxStep()) state.cur = 0; // 播放到结尾后重播回起点
    state.playing = true;
    refresh();
    startTimer();
  }

  function toggle(): void {
    if (state.playing) pause();
    else play();
  }

  function step(): void {
    const nx = nextSeq(state.steps, state.cur);
    if (nx === state.cur) return;
    pause();
    state.cur = nx;
    refresh();
  }

  function back(): void {
    const pv = prevSeq(state.steps, state.cur);
    if (pv === state.cur) return;
    pause();
    state.cur = pv;
    refresh();
  }

  function seekTo(seq: number): void {
    const clamped = Math.max(0, Math.min(seq, maxStep()));
    pause();
    state.cur = clamped;
    refresh();
  }

  function setSpeed(n: number): void {
    state.speed = n;
    if (state.playing) startTimer();
  }

  function destroy(): void {
    destroyed = true;
    pause();
  }

  async function load(): Promise<void> {
    try {
      const res = await fetcher(`/api/games/${gameId}/replay`);
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as { id?: string; events?: GameEvent[] };
      state.events = Array.isArray(data.events) ? data.events : [];
      const sp = seqPointsOf(state.events);
      state.steps = sp.steps;
      state.finishSeq = sp.finishSeq;
      state.phase = 'ready';
      refresh();
    } catch (err) {
      state.phase = 'error';
      state.error = err instanceof Error ? err.message : String(err);
    }
  }
  void load();

  const controls: ReplayControls = { play, pause, toggle, step, back, seekTo, setSpeed, destroy };
  // 直接在 reactive 上挂 controls(同 useGame 约定:不 spread,保响应性)。
  return Object.assign(state, { controls }) as unknown as UseReplayState;
}