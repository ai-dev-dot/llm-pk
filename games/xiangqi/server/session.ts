import type { Usage } from './game-log';
import type { Side } from '../engine/types';

/**
 * 会话管理(spec §8 原则 C 的结构层实现)。
 *
 * 约定:
 * - 红黑各一个 `SideSession` 实例,**互不引用对方实例的 messages**;对方 analysis 在结构上不可能被写入本方数组。
 * - 消息形态:`[ system(角色+规则), ...历史(compact 记谱), 当前回合(棋盘 + [打回原因]) ]`,外加己方 `selfThoughts`(assistant analysis,按 `carrySelfAnalysisN` 窗口从旧丢弃)。
 * - `rejection` 同回合**覆盖**(替换而非追加)(spec §9 评审批准);
 * - `contextBudgetTokens` 校准前为**软护栏**:只把超预算观测记入 `warnings[]`,不做硬裁剪(评审采纳,spec §8、§9)。
 * - 作用域为 server/arena 的会话记忆;`ChatMessage` 是内部表示,T16 player 组装器负责翻译成 API 消息。
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'rejection';

/** 消息语义分类:窗口裁剪、打回覆盖、回合切换均按 kind 定位,不靠文本猜测。 */
export type ChatKind = 'system' | 'history' | 'board' | 'analysis' | 'rejection';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  kind?: ChatKind;
  /** 走法编码如 h3-e3(历史/analysis 消息可有)。 */
  move?: string;
  /** 中文记谱如 炮二平五(compact 公共历史)。 */
  notation?: string;
  /** 己方思考文本(仅本方;kind='analysis')。 */
  analysis?: string;
  /** 打回原因(仅 role='rejection' 消息)。 */
  reason?: string;
  usage?: Usage;
}

export interface SideSessionOptions {
  /** 回显窗口:只回传最近 N 条己方 analysis(0 = 不回显,对照实验用)。 */
  carrySelfAnalysisN: number;
  /** 软护栏预算(spec 默认 32000;校准前只记录不裁剪)。 */
  contextBudgetTokens?: number;
}

export interface TurnResult {
  /** 走法编码,如 h3-e3。 */
  move: string;
  /** 中文记谱,如 炮二平五(compact 公共历史用)。 */
  notation?: string;
  /** 己方思考(仅本方可见;可空——空则该步不进回显窗口)。 */
  analysis?: string;
  usage?: Usage;
}

export interface SelfThought {
  move: string;
  notation?: string;
  analysis: string;
}

export interface RejectionInput {
  reason: string;
}

/** spec §8 默认预算(tokens);模型窗口必须大于它。 */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 32000;

/** token 估算近似:总字符数 / 4(粗估计,仅用于软护栏观测)。 */
const CHARS_PER_TOKEN = 4;

export class SideSession {
  /** 本方完整消息数组(只读对外;窗口裁旧/打回覆盖/回合切换由内部维护)。 */
  public readonly messages: ChatMessage[] = [];
  /** 软护栏告警:校准前只记录观测,不做硬裁剪。 */
  public readonly warnings: string[] = [];
  private readonly carrySelfAnalysisN: number;
  private readonly contextBudgetTokens: number;
  /** 己方 analysis 窗口(旧→新),与 messages 中 kind='analysis' 一一对应。 */
  private readonly selfThoughts_: SelfThought[] = [];

  constructor(
    public readonly side: Side,
    opts: SideSessionOptions,
  ) {
    if (!Number.isInteger(opts.carrySelfAnalysisN) || opts.carrySelfAnalysisN < 0) {
      throw new RangeError('carrySelfAnalysisN 必须为非负整数');
    }
    this.carrySelfAnalysisN = opts.carrySelfAnalysisN;
    this.contextBudgetTokens = opts.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
  }

  /* ---------- 通用构造 ---------- */

  /** 置/更新系统提示(角色 + 规则),恒居数组首位。 */
  setSystemPrompt(content: string): void {
    const idx = this.messages.findIndex((m) => m.role === 'system');
    if (idx >= 0) {
      this.messages[idx] = { ...this.messages[idx], content };
    } else {
      this.messages.unshift({ role: 'system', kind: 'system', content });
    }
  }

  /** 开启新回合:覆盖当前棋盘并清掉上一回合的 rejection(spec §8 会话形态)。 */
  setBoard(ascii: string): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const k = this.messages[i].kind;
      if (k === 'board' || k === 'rejection') this.messages.splice(i, 1);
    }
    this.messages.push({ role: 'user', kind: 'board', content: ascii });
    this._checkBudget();
  }

  /** 通用追加;若带 analysis(或 kind='analysis'),同步进入回显窗口并触发裁剪。 */
  push(m: ChatMessage): void {
    this.messages.push(m);
    if (m.kind === 'analysis' || m.analysis !== undefined) {
      this.selfThoughts_.push({
        move: m.move ?? '',
        notation: m.notation,
        analysis: m.analysis ?? m.content,
      });
      this._trimSelfThoughts();
    }
    this._checkBudget();
  }

  /* ---------- 行棋结果(brief + controller 契约) ---------- */

  /** 记录一步公共历史(compact 记谱)与己方思考(analysis 进窗口)。 */
  pushTurnResult(r: TurnResult): void {
    const content = r.notation ?? r.move;
    this.push({ role: 'user', kind: 'history', content, move: r.move, notation: r.notation });
    if (r.analysis !== undefined && r.analysis !== '') {
      this.push({
        role: 'assistant',
        kind: 'analysis',
        content: r.analysis,
        move: r.move,
        notation: r.notation,
        analysis: r.analysis,
        usage: r.usage,
      });
    }
  }

  /** brief 命名 `pushMoveResult`,与 pushTurnResult 同义。 */
  pushMoveResult(r: TurnResult): void {
    this.pushTurnResult(r);
  }

  /* ---------- rejection(spec §9:同回合覆盖) ---------- */

  /** 同回合内覆盖:先摘掉旧 rejection 再追加新一条(恒唯一)。 */
  setRejection(r: RejectionInput): void {
    this._dropRejections();
    this.messages.push({ role: 'rejection', kind: 'rejection', content: r.reason, reason: r.reason });
    this._checkBudget();
  }

  /** brief 命名 `replaceRejection`,与 setRejection 同义。 */
  replaceRejection(r: RejectionInput): void {
    this.setRejection(r);
  }

  /* ---------- 只读视图 ---------- */

  /** 己方最近 N 条 analysis(旧→新;仅本方可见)。 */
  selfThoughts(): SelfThought[] {
    return this.selfThoughts_.map((t) => ({ ...t }));
  }

  /** 当前估算 token(近似按字符数);同时刷新软护栏观测告警。 */
  budget(): number {
    this._checkBudget();
    return this._estimateTokens();
  }

  /**
   * 隔离 spy(测试/审计用,spec §12):断言本方 messages 不含对方案例的任何
   * analysis 文本;泄漏时立即抛错(快失败)。公共记谱为双方共有,不在此列。
   */
  assertNoLeak(peer: SideSession): void {
    const serialized = JSON.stringify(this.messages);
    for (const m of peer.messages) {
      if (m.analysis !== undefined && serialized.includes(m.analysis)) {
        throw new Error(
          `[session:${this.side}] 泄漏对方(${peer.side}) analysis:` +
            JSON.stringify(m.analysis.slice(0, 32)),
        );
      }
    }
  }

  /* ---------- 内部维护 ---------- */

  /** 窗口裁旧:超过 carrySelfAnalysisN 从最旧丢弃,并同步移除 messages 中对应消息。 */
  private _trimSelfThoughts(): void {
    while (this.selfThoughts_.length > this.carrySelfAnalysisN) {
      const dropped = this.selfThoughts_.shift();
      if (!dropped) break;
      const idx = this.messages.findIndex(
        (m) =>
          m.kind === 'analysis' &&
          m.analysis === dropped.analysis &&
          (m.move ?? '') === dropped.move,
      );
      if (idx >= 0) this.messages.splice(idx, 1);
    }
  }

  private _dropRejections(): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'rejection') this.messages.splice(i, 1);
    }
  }

  private _estimateTokens(): number {
    let chars = 0;
    for (const m of this.messages) chars += m.content.length;
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }

  /** 软护栏:超预算只记录观测(去重:与上一条告警相同则不重复刷)。 */
  private _checkBudget(): void {
    const est = this._estimateTokens();
    if (est > this.contextBudgetTokens) {
      const note =
        `soft-guard: ~${est} tokens > ${this.contextBudgetTokens}` +
        `(校准前软护栏,仅记录不裁剪)`;
      if (this.warnings[this.warnings.length - 1] !== note) this.warnings.push(note);
    }
  }
}