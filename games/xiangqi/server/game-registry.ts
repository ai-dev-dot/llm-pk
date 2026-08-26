import { randomUUID } from 'node:crypto';
import { Arena, type ArenaConfig } from './arena';

/**
 * `GameRegistry` —— 多局并存的管理器(spec §9 评审批准:Map<gameId, Arena>)。
 *
 * WS/REST 按 `gameId` 路由到对应实例(T17 接线点);每局独立状态机,互不污染。
 * - `create` 分配唯一 gameId(显式传入则校验唯一),注册并返回 Arena;
 * - `get/has` 按 id 读取;
 * - `dispose` 移除注册;若对局仍在运行会先 `abort()`(判和收尾 + 广播 finish),
 *   避免悬挂的事件循环与退避计时器泄漏。
 */

export type GameRegistryCreateInput = Omit<ArenaConfig, 'gameId'> & { gameId?: string };

export class GameRegistry {
  private readonly games = new Map<string, Arena>();

  /** 创建并注册一局;gameId 缺省由 crypto.randomUUID() 生成。 */
  create(input: GameRegistryCreateInput): Arena {
    const gameId = input.gameId ?? randomUUID();
    if (this.games.has(gameId)) throw new Error(`gameId 已存在: ${gameId}`);
    const arena = new Arena({ ...input, gameId });
    this.games.set(gameId, arena);
    return arena;
  }

  has(gameId: string): boolean {
    return this.games.has(gameId);
  }

  get(gameId: string): Arena | undefined {
    return this.games.get(gameId);
  }

  /** 移除注册;运行中的对局先 abort(判和收尾)。返回是否确有该局。 */
  dispose(gameId: string): boolean {
    const arena = this.games.get(gameId);
    if (!arena) return false;
    arena.abort('draw-aborted');
    this.games.delete(gameId);
    return true;
  }

  get size(): number {
    return this.games.size;
  }
}