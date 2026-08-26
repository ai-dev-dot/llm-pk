import { EventEmitter } from 'node:events';
import { cloneBoard, initialBoard, opposite, pieceAt, sqToCode, type Board } from '../engine/board';
import { moveToKey, requireApply } from '../engine/attack';
import { classifyAll, snapshotKey } from '../engine/judge';
import { parseMoveRaw } from '../engine/notation';
import { clearResolveCache, engineReason, parseResolve } from '../engine/resolver';
import { renderAscii } from '../engine/render';
import type { Side } from '../engine/types';
import {
  appendEvent,
  type GameEvent,
  type GameEventInput,
  type GameLogSink,
  type GameRulesSnapshot,
  type RuleViolations,
  type Usage,
} from './game-log';
import { DEFAULT_CONTEXT_BUDGET_TOKENS, SideSession } from './session';

/**
 * `Arena` —— 单局棋盘调度器(spec §9 回合数据流 + 打回循环 + 守卫)。
 *
 * 职责:
 * - 回合仲裁:行棋方 → 会话装配上下文 → `player.pickMove` → `parseResolve` → 拒则打回/判负,
 *   合法则落子并 `classifyAll` 判定结束/继续;
 * - 状态机:`idle → running ⇄(pause/resume/step)paused → finished`(pause/resume 幂等);
 * - 守卫:打回上限(`illegal-moves`)、网络重试超限(`timeout`)、步数上限(`draw-max-moves`)、
 *   成本上限(`draw-cost-limit`);重复局面由 `classifyAll`(history 快照)判 `draw-repeat`;
 * - 每局开始 `clearResolveCache()`,所有经 `appendEvent` 的事件即广播(EventEmitter + onEvent 回调)。
 *
 * 注入边界:Player 接口与解析(parseResolve/engineReason)均为依赖注入/模块依赖,便于 mock 测试;
 * 日志 sink 一局一流,终局 `end()`(WriteStream 时)。
 */

/* ---------- 外部契约(spec §6) ---------- */

export type ArenaState = 'idle' | 'running' | 'paused' | 'finished';

/** 单步棋子的公共历史记录(日志/上下文用统一坐标)。 */
export interface PlyInfo {
  move: string;      // 如 'h3-e3'
  notation?: string; // 如 '炮二平五'(可选,置空则仅坐标)
}

/** spec §6 `MoveChoice`:走法自由文本 + 己方思考 + 可选成本/耗时。 */
export interface MoveChoice {
  analysis: string;
  move: string;
  usage?: Usage;
  elapsedMs?: number;
}

/** spec §6 `Player`:一方模型适配器。side 标识执子方(model 供 begin 事件元数据)。 */
export interface Player {
  readonly side: Side;
  readonly model?: string;
  pickMove(ctx: MoveContext): Promise<MoveChoice>;
}

/** spec §6 `MoveContext`:传给棋手的本回合输入。 */
export interface MoveContext {
  side: Side;
  asciiBoard: string;
  history: PlyInfo[];
  selfThoughts: { move: string; analysis: string }[];
  rejection?: { round: number; reason: string };
}

/** 网络型错误:Player 应抛出以触发 arena 指数退避重试(超时/5xx/断网)。 */
export class NetworkError extends Error {
  constructor(message: string, readonly retryable = true) {
    super(message);
    this.name = 'NetworkError';
  }
}

export function isNetworkError(err: unknown): boolean {
  // F3:true 才重试——非 retryable(如 4xx 解析错误)不做指数退避,按内部错误收尾
  if (err instanceof NetworkError) return err.retryable;
  if (err instanceof Error && (err as { isNetwork?: boolean }).isNetwork === true) return true;
  if ((err as { cause?: unknown } | null)?.cause === 'network') return true;
  return false;
}

export interface ArenaPlayerConfig {
  player: Player;
  /** begin 事件元数据;缺省回落 player.model。 */
  model?: string;
  systemPrompt?: string;
}

export interface ArenaConfig {
  gameId: string;
  red: ArenaPlayerConfig;
  black: ArenaPlayerConfig;
  sink: GameLogSink;
  /** 规则参数(全可选):打回上限/网络重试/步数上限/超时/回显窗口/预算。 */
  rules?: Partial<GameRulesSnapshot>;
  /** 成本守卫(USD):累计 usage.costUsd 超限判和 draw-cost-limit。 */
  maxCostPerGame?: number;
  /** 网络重试退避基准(ms),测试可置 0。 */
  networkRetryBaseDelayMs?: number;
  /** 事件广播钩子:每事件写盘后回调(可同时喂 WS)。 */
  onEvent?: (evt: GameEvent) => void;
}

/* ---------- 默认值(spec §7/§8/§9) ---------- */

const DEFAULT_ILLEGAL_LIMIT = 3;
const DEFAULT_NETWORK_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_CARRY_SELF_ANALYSIS_N = 6;
const DEFAULT_MAX_TOTAL_MOVES = 200;
const DEFAULT_NETWORK_RETRY_BASE_MS = 200;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ---------- Arena ---------- */

export class Arena {
  /** 事件总线:每事件以 'event' 广播;终局额外以 'finish' 广播。 */
  public readonly onEvent = new EventEmitter();

  private state_: ArenaState = 'idle';
  private board!: Board;
  private turn_: Side = 'red';
  private moveCount_ = 0;
  private halfMoves_ = 0;
  /** 「行棋方行动前」的局面快照键(contract:classifyAll 判重复局面)。 */
  private readonly history: string[] = [];
  private readonly moveHistory: PlyInfo[] = [];
  private sessions_!: Record<Side, SideSession>;
  private readonly violations: Record<Side, RuleViolations> = {
    red: { pre: 0, post: 0 },
    black: { pre: 0, post: 0 },
  };
  private readonly sideRejectedEver: Record<Side, boolean> = { red: false, black: false };
  private totalCostUsd = 0;
  private finishRequested_ = false;

  // 打回循环(本回合内)
  private illegalAttempts = 0;
  private rejectionRound = 0;
  private currentRejection?: { round: number; reason: string };

  // 事件循环
  private drivePromise?: Promise<void>;
  private startResolve?: () => void;
  private waiters: (() => void)[] = [];
  private singleStep_ = false;
  private stepWaiter?: () => void;
  private stepPromise?: Promise<void>;
  private turnPromise?: Promise<void>;
  private sinkEnded = false;
  private aborted = false;

  constructor(private readonly cfg: ArenaConfig) {
    if (!cfg.gameId) throw new Error('Arena 需要 gameId');
    const rules = cfg.rules ?? {};
    if ((rules.illegalAttemptsLimit ?? DEFAULT_ILLEGAL_LIMIT) < 1) throw new RangeError('illegalAttemptsLimit 必须 ≥1');
    if ((rules.networkRetries ?? DEFAULT_NETWORK_RETRIES) < 0) throw new RangeError('networkRetries 必须 ≥0');
    if ((rules.maxTotalMoves ?? DEFAULT_MAX_TOTAL_MOVES) < 1) throw new RangeError('maxTotalMoves 必须 ≥1');
    this.sessions_ = { red: this.newSession('red'), black: this.newSession('black') };
  }

  /* ---------- 只读视图 ---------- */

  get state(): ArenaState {
    return this.state_;
  }

  get gameId(): string {
    return this.cfg.gameId;
  }

  get moveCount(): number {
    return this.moveCount_;
  }

  get turn(): Side {
    return this.turn_;
  }

  get sessions(): Record<Side, SideSession> {
    return this.sessions_;
  }

  sessionOf(side: Side): SideSession {
    return this.sessions_[side];
  }

  get totalCost(): number {
    return this.totalCostUsd;
  }

  /** 当前行棋一步的上下文(测试/审计可回看;动作侧取 turn_)。 */
  currentMoveContext(side: Side): MoveContext {
    return {
      side,
      asciiBoard: renderAscii(this.board),
      history: this.moveHistory.map((p) => ({ ...p })),
      selfThoughts: this.sessionOf(side).selfThoughts().map((t) => ({ move: t.move, analysis: t.analysis })),
      rejection: this.currentRejection ? { ...this.currentRejection } : undefined,
    };
  }

  /* ---------- 状态机 ---------- */

  async start(): Promise<void> {
    if (this.state_ !== 'idle') throw new Error(`start 只能在 idle 态调用(当前 ${this.state_})`);
    clearResolveCache();
    this.reset();
    this.state_ = 'running';
    this.emitBegin();
    const startP = new Promise<void>((res) => {
      this.startResolve = res;
    });
    this.drivePromise = this.drive();
    return startP;
  }

  /** 幂等暂停:仅 running→paused;步内请求发出后于回合边界生效。 */
  pause(): void {
    if (this.state_ === 'running') this.state_ = 'paused';
  }

  /** 幂等恢复:paused→running 并唤醒事件循环。 */
  resume(): void {
    if (this.state_ === 'paused') {
      this.state_ = 'running';
      this.kick();
    }
  }

  /** 暂停态下推进恰好一个半回合,结束后返回并保持 paused。 */
  step(): Promise<void> {
    if (this.state_ !== 'paused') throw new Error(`step 仅可在暂停态调用(当前 ${this.state_})`);
    if (this.finishRequested_) return Promise.resolve();
    // 幂等:已有一个单步在途则共享同一 promise,避免覆盖 waiter
    if (this.singleStep_) return this.stepPromise ?? Promise.resolve();
    this.singleStep_ = true;
    const waiter = new Promise<void>((res) => {
      this.stepWaiter = res;
    });
    this.stepPromise = waiter;
    this.kick();
    return waiter;
  }

  /** 强制中止(registry dispose 用):判和收尾并释放事件循环。 */
  abort(reason = 'draw-aborted'): void {
    if (this.finishRequested_) return;
    this.aborted = true;
    this.finishGame({ winner: 'draw', reason });
    this.kick();
  }

  /* ---------- 回合仲裁 ---------- */

  /** 单半回合:重复局面快照 → 打回循环 → 落子/分类 → 事件与换方。 */
  private async playTurn(): Promise<void> {
    const side = this.turn_;
    // contract:每回合行棋方行动前记录局面快照(供 classifyAll 判 draw-repeat)
    this.history.push(snapshotKey(this.board, side));
    this.sessionOf(side).setBoard(renderAscii(this.board));
    this.illegalAttempts = 0;
    this.rejectionRound = 0;
    this.currentRejection = undefined;

    for (;;) {
      if (this.finishRequested_) return;
      const choice = await this.pickMoveWithRetry(side);
      if (this.finishRequested_) return;

      const cacheKey = `${this.cfg.gameId}|${this.halfMoves_}|${this.rejectionRound}`;
      const outcome = parseResolve(choice.move, this.board, side, cacheKey);

      if (!outcome.ok) {
        this.illegalAttempts++;
        this.rejectionRound++;
        const v = this.bumpViolation(side);
        this.sideRejectedEver[side] = true;
        // 精确打回文案:对文本再解析取「尝试的走法」供 engineReason 给出具体起因
        const parsed = parseMoveRaw(choice.move, this.board, side);
        const reasonText = engineReason(outcome.code, parsed.ok ? parsed.move : undefined, this.board, side);
        this.emit({
          type: 'illegal-attempt',
          side,
          round: this.rejectionRound,
          reason: reasonText,
          violations: { ...v },
          attempt: { text: choice.move },
        });
        if (this.illegalAttempts >= (this.cfg.rules?.illegalAttemptsLimit ?? DEFAULT_ILLEGAL_LIMIT)) {
          this.finishGame({ winner: opposite(side), reason: 'illegal-moves' });
          return;
        }
        // 教学:同回合覆盖 rejection,并携带原因重试
        this.sessionOf(side).setRejection({ reason: reasonText });
        this.currentRejection = { round: this.rejectionRound, reason: reasonText };
        continue;
      }

      // 合法:落子
      const mv = outcome.move;
      const captured = pieceAt(this.board, mv.to);
      this.board = requireApply(this.board, mv);
      this.moveCount_++;
      this.halfMoves_++;
      const nextSide = opposite(side);
      const usage = choice.usage;
      if (usage?.costUsd) this.totalCostUsd += usage.costUsd;
      const moveKey = moveToKey(mv);
      this.moveHistory.push({ move: moveKey });
      this.sessionOf(side).pushTurnResult({ move: moveKey, analysis: choice.analysis, usage });
      this.emit({
        type: 'move',
        turn: side,
        move: { from: sqToCode(mv.from), to: sqToCode(mv.to) },
        analysis: choice.analysis,
        elapsedMs: choice.elapsedMs,
        usage,
        legal: true,
      });
      if (captured) this.emit({ type: 'captured', side, piece: captured, at: sqToCode(mv.to) });

      const verdict = classifyAll(
        { board: this.board, turn: nextSide, halfMoves: this.halfMoves_, moveCount: this.moveCount_, history: this.history },
        this.cfg.rules?.maxTotalMoves ?? DEFAULT_MAX_TOTAL_MOVES,
        this.cfg.rules?.drawRepeat ?? 3, // B3:drawRepeat 接线(与 begin.rules.drawRepeat 同源生效)
      );
      if (verdict.type === 'check') this.emit({ type: 'check', side: nextSide });

      if (verdict.type === 'checkmate' || verdict.type === 'stalemate') {
        this.finishGame({ winner: side, reason: verdict.type });
        return;
      }
      if (verdict.type === 'draw') {
        const dReason =
          verdict.reason === 'draw-repeat' ? 'repeat'
          : verdict.reason === 'draw-max-moves' ? 'max-moves'
          : 'no-fighting-material';
        this.emit({ type: 'draw', reason: dReason });
        this.finishGame({ winner: 'draw', reason: verdict.reason ?? 'draw' });
        return;
      }
      if (this.cfg.maxCostPerGame !== undefined && this.totalCostUsd > this.cfg.maxCostPerGame) {
        this.emit({ type: 'draw', reason: 'cost-limit' });
        this.finishGame({ winner: 'draw', reason: 'draw-cost-limit' });
        return;
      }
      this.turn_ = nextSide;
      return;
    }
  }

  /** 网络重试:指数退避 `retries` 次;超限判该方负 `reason: timeout`。 */
  private async pickMoveWithRetry(side: Side): Promise<MoveChoice> {
    const retries = this.cfg.rules?.networkRetries ?? DEFAULT_NETWORK_RETRIES;
    const baseMs = this.cfg.networkRetryBaseDelayMs ?? DEFAULT_NETWORK_RETRY_BASE_MS;
    let attempt = 0;
    for (;;) {
      try {
        return await this.cfg[side].player.pickMove(this.currentMoveContext(side));
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        if (attempt >= retries) {
          this.finishGame({ winner: opposite(side), reason: 'timeout' });
          return { analysis: '', move: '' };
        }
        attempt++;
        this.emit({ type: 'retry', side, attempt, cause: 'network' });
        const delay = Math.min(baseMs * 2 ** (attempt - 1), 30000);
        if (delay > 0 && !this.aborted) await sleep(delay);
        if (this.finishRequested_ || this.aborted) return { analysis: '', move: '' };
      }
    }
  }

  /* ---------- 事件循环(idle 起一跳一回合,幂等 pause/resume) ---------- */

  private async drive(): Promise<void> {
    try {
      for (;;) {
        while (this.state_ === 'paused' && !this.singleStep_) {
          await this.waitKick();
        }
        if (this.finishRequested_) break;
        const wasStep = this.state_ === 'paused' && this.singleStep_;
        if (wasStep) this.singleStep_ = false;
        const turn = this.playTurn();
        this.turnPromise = turn;
        await turn;
        this.resolveStep();
        if (this.finishRequested_) break;
        if (wasStep) {
          // 单步结束:除非步内被 resume(仍 running),回去维持暂停态
          if (this.state_ !== 'running') this.state_ = 'paused';
          continue;
        }
        // running:回到循环顶,若步内 pause() 过则在此停留
      }
    } catch (err) {
      this.abortWithError(err);
    } finally {
      this.startResolve?.();
      this.resolveStep();
    }
  }

  private waitKick(): Promise<void> {
    return new Promise<void>((res) => {
      this.waiters.push(res);
    });
  }

  private kick(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  private resolveStep(): void {
    const w = this.stepWaiter;
    this.stepWaiter = undefined;
    this.stepPromise = undefined;
    w?.();
  }

  private abortWithError(err: unknown): void {
    if (this.finishRequested_) return;
    const msg = err instanceof Error ? err.message : String(err);
    this.emit({ type: 'error', code: 'ARENA_INTERNAL', message: msg });
    this.finishGame({ winner: 'draw', reason: 'internal-error' });
  }

  /* ---------- 终局 ---------- */

  private finishGame(opts: { winner: Side | 'draw'; reason: string }): void {
    if (this.finishRequested_) return;
    this.finishRequested_ = true;
    this.state_ = 'finished';
    this.emit({
      type: 'finish',
      winner: opts.winner,
      reason: opts.reason,
      ruleViolations: {
        red: { ...this.violations.red },
        black: { ...this.violations.black },
      },
    });
    this.endSink();
  }

  private endSink(): void {
    if (this.sinkEnded) return;
    this.sinkEnded = true;
    const s = this.cfg.sink as (GameLogSink & { end?: () => void }) | undefined;
    if (typeof s?.end === 'function') s.end();
  }

  /* ---------- 会话与计数 ---------- */

  private newSession(side: Side): SideSession {
    return new SideSession(side, {
      carrySelfAnalysisN: this.cfg.rules?.carrySelfAnalysisN ?? DEFAULT_CARRY_SELF_ANALYSIS_N,
      contextBudgetTokens: this.cfg.rules?.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS,
    });
  }

  /** 每方违规计数,分阶段:教学前(pre,首次打回前)/ 教学后(post,被拒后重犯)。 */
  private bumpViolation(side: Side): RuleViolations {
    const v = this.violations[side];
    if (!this.sideRejectedEver[side]) v.pre++;
    else v.post++;
    return v;
  }

  private reset(): void {
    this.board = cloneBoard(initialBoard());
    this.turn_ = 'red';
    this.moveCount_ = 0;
    this.halfMoves_ = 0;
    this.history.length = 0;
    this.moveHistory.length = 0;
    this.sessions_ = { red: this.newSession('red'), black: this.newSession('black') };
    this.violations.red.pre = 0;
    this.violations.red.post = 0;
    this.violations.black.pre = 0;
    this.violations.black.post = 0;
    this.sideRejectedEver.red = false;
    this.sideRejectedEver.black = false;
    this.totalCostUsd = 0;
    this.finishRequested_ = false;
    this.singleStep_ = false;
    this.waiters = [];
    this.sinkEnded = false;
    this.aborted = false;
  }

  private emitBegin(): void {
    const rules: GameRulesSnapshot = {
      drawRepeat: this.cfg.rules?.drawRepeat ?? 3,
      illegalAttemptsLimit: this.cfg.rules?.illegalAttemptsLimit ?? DEFAULT_ILLEGAL_LIMIT,
      maxTotalMoves: this.cfg.rules?.maxTotalMoves ?? DEFAULT_MAX_TOTAL_MOVES,
      networkRetries: this.cfg.rules?.networkRetries ?? DEFAULT_NETWORK_RETRIES,
      timeoutMs: this.cfg.rules?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      carrySelfAnalysisN: this.cfg.rules?.carrySelfAnalysisN ?? DEFAULT_CARRY_SELF_ANALYSIS_N,
      contextBudgetTokens: this.cfg.rules?.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS,
    };
    this.emit({
      type: 'begin',
      gameId: this.cfg.gameId,
      red: { model: this.cfg.red.model ?? this.cfg.red.player.model ?? 'unknown' },
      black: { model: this.cfg.black.model ?? this.cfg.black.player.model ?? 'unknown' },
      rules,
    });
    if (this.cfg.red.systemPrompt) this.sessionOf('red').setSystemPrompt(this.cfg.red.systemPrompt);
    if (this.cfg.black.systemPrompt) this.sessionOf('black').setSystemPrompt(this.cfg.black.systemPrompt);
  }

  /** 写日志 + 广播(EventEmitter 'event' 与 cfg.onEvent 回调)。 */
  private emit(evt: GameEventInput): GameEvent {
    const recorded = appendEvent(this.cfg.sink, evt);
    this.cfg.onEvent?.(recorded);
    this.onEvent.emit('event', recorded);
    if (recorded.type === 'finish') this.onEvent.emit('finish', recorded);
    return recorded;
  }
}