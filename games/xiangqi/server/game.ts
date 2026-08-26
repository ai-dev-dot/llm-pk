//
// Game 泛型对弈协议(spec §3 平台化第一步)—— arena 与棋类规则之间的唯一接口。
//
// 目的:让 `server/arena.ts` 不再 import 任何 engine 具体函数,第二次接入新游戏时
// 只新增一个 `Game<S,M>` 实现文件,调度/日志/回放骨架零改动。
//
// 设计要点:
// - `State`(S)与 `Move`(M)为游戏自定义类型;arena 只在这两个类型参数之上调度;
// - 模型侧永不见 `Move` 类型:棋手自由文本 → `resolve` 一次产出裁决(打回自带中文讲评,
//   绝不枚举合法走法,原则 D);缓存/送将特判均收敛在 game 内部;
// - `render` 是原则 A:棋盘 → 文本,唯一传给 LLM 的视野;
// - `moveId`/`moveKey` 提供日志侧字符串(坐标/记谱),`squareId` 提供格子坐标编码;
// - `classify` 收敛胜负/和棋判定(将死/困毙/重复局面/无胜子力/步数上限),arena 无需感知棋种;
// - `clearCache` 每局开始清裁决缓存。
//
// 本文件零 engine 依赖(只 import `Side`/`Sq` 类型),实现见 `games/xiangqi-game.ts`。
//

import type { Side, Sq } from '../engine/types';

/** 吃子/棋子最小描述(日志用)。`type` 字符串化,不绑定具体棋种的枚举。 */
export interface PieceInfo {
  side: Side;
  type: string;
}

/** classify 结果(含胜负与和棋 reason 稳定码)。 */
export interface ClassifyOutcome {
  type: 'ongoing' | 'check' | 'checkmate' | 'stalemate' | 'draw';
  reason?: 'draw-repeat' | 'draw-no-mating-material' | 'draw-max-moves';
}

/** classify 上下文(调度器置数;半回合数/总步数/局面快照历史)。 */
export interface ClassifyContext {
  halfMoves: number;
  moveCount: number;
  /** 各行棋方行动前的局面快照键(见实现 `snapshotKey`),供重复局面判和。 */
  history: string[];
  maxTotalMoves?: number;
  drawRepeat?: number;
}

/** 裁决要么通过(带 Move),要么失败(带稳定 reason 码 + 中文讲评)。 */
export type ResolveOutcome<M> =
  | { ok: true; code: 'OK'; move: M }
  | {
      ok: false;
      code: 'PARSER_INVALID' | 'PARSER_AMBIGUOUS' | 'ILLEGAL_MOVE' | 'SUICIDE';
      /** 打回中文讲评(绝不枚举合法走法,原则 D)。 */
      reasonText: string;
      /** 若文本结构可解析,携带尝试的走法(供 reasonText 给具体起因)。 */
      move?: M;
    };

/**
 * 泛型对弈协议。
 *
 * @typeParam S 局面 State
 * @typeParam M 走法 Move
 */
export interface Game<S, M> {
  readonly meta: { name: string; sides: Side[]; drawRule: string };
  initialState(): S;
  /** 原则 A:局面 → 文本棋盘(唯一传给 LLM 的视野)。 */
  render(s: S): string;
  /** 严格应用(from 无子抛错);返回新局面。 */
  apply(s: S, m: M): S;
  /** 取某格棋子(吃子判定;越界/空格返回 null)。 */
  pieceAt(s: S, sq: Sq): PieceInfo | null;
  /** 对手甄别。 */
  opposite(side: Side): Side;
  /** 局面快照键(棋盘 + 当前行棋方),供重复局面判和。 */
  snapshotKey(s: S, turn: Side): string;
  /** 格子坐标编码(如 'h3'),日志/事件用。 */
  squareId(sq: Sq): string;
  /** 走法目标格(吃子判定/ captured.at 用);返回 null 表示解析不到。 */
  destination(m: M): Sq | null;
  /** 走法 → 日志 move 事件形态(统一坐标 + 可选中文记谱旁注;board 为走前局面,记谱生成用)。 */
  moveId(m: M, board: S): { from: string; to: string; notation?: string };
  /** 走法 → 历史编码(如 'h3-e3')。 */
  moveKey(m: M): string;
  /**
   * 自由文本走法 → 裁决。解析(坐标/记谱/歧义)+ 合法性 + 送将特判 + 回合级缓存
   * 全部收敛于此;失败时 `reasonText` 只讲原因、绝不枚举合法走法。
   * `cacheKey` 由调度器以 (gameId, halfMove, round) 唯一标识一次「待裁决时刻」。
   */
  resolve(text: string, s: S, side: Side, cacheKey?: string): ResolveOutcome<M>;
  /** 综合判定(将死/困毙/和棋三态/ongoing/check)。 */
  classify(s: S, turn: Side, ctx: ClassifyContext): ClassifyOutcome;
  /** 每局开始清裁决缓存。 */
  clearCache(): void;
}