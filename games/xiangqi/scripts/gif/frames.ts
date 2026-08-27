//
// 事件 → 帧描述序列(纯逻辑,零 IO;spec §6)。
// 复用 web/src/lib/replay 同源派生(与实时观战共用 boardAt/movesAt/modelsAt/resultAt)。
//
import type { GameEvent } from '../../server/game-log';
import { boardAt, movesAt, modelsAt, resultAt, type UidPiece } from '../../web/src/lib/replay';
import type { Side, Sq } from '../../engine/types';

export type FrameMode = 'open' | 'hold' | 'slide' | 'land' | 'final';

export interface GalleryCaption {
  round: number;
  notation: string;
  cur: number;      // 已落第几手
  total: number;
  mover: Side | null;
  rejection: number;
  left: string;     // 左开始段(回合+记谱)
  right: string;    // 右段(模型名)
}

export interface Frame {
  mode: FrameMode;
  board: UidPiece[];
  from?: Sq;
  to?: Sq;
  slideT?: number;
  caption: GalleryCaption;
  banner: { title: string; sub: string } | null;
  delayMs: number;
}

export interface BuildOpts { speed: 1 | 2 }

/** reason → 中文(与 web/src/lib/format.ts 对齐;测试断言全集一致,勿单方改)。 */
export const REASON_TEXT: Record<string, string> = {
  checkmate: '絕殺',
  stalemate: '困毙',
  'illegal-moves': '打回超过上限判负',
  timeout: '网络超时判负',
  'internal-error': '对局异常终止',
  'draw-aborted': '强制中止',
  'draw-repeat': '重复局面 · 和棋',
  'draw-no-mating-material': '双方无进攻子力 · 和棋',
  'draw-max-moves': '步数上限 · 和棋',
  'draw-cost-limit': '成本上限 · 和棋',
  'draw-network': '网络异常 · 对局中止(不作胜负)',
};

const WINNER_TEXT: Record<Side, string> = { red: '红方勝', black: '黑方勝' };

export function bannerText(winner: Side | 'draw' | undefined, reason: string | undefined, hasFinish: boolean): { title: string; sub: string } | null {
  if (!hasFinish || winner === undefined) return { title: '对局进行中', sub: '' };
  const title = winner === 'draw' ? '和棋' : WINNER_TEXT[winner];
  const sub = reason ? (REASON_TEXT[reason] ?? reason) : '';
  return { title, sub };
}

const halfMoveToRound = (n: number) => Math.ceil(Math.max(n, 0) / 2);

export function buildFrames(events: GameEvent[], opts: BuildOpts): Frame[] {
  const moves = movesAt(events, Number.MAX_SAFE_INTEGER);
  const total = moves.length;
  const models = modelsAt(events, Number.MAX_SAFE_INTEGER);
  const res = resultAt(events, Number.MAX_SAFE_INTEGER);
  const hasFinish = res !== null;
  const banner = bannerText(res?.winner, res?.reason, hasFinish);

  const rightOf = () => `${models?.red ?? '? 红'} vs ${models?.black ?? '? 黑'}`;
  const speed = opts.speed === 2 ? 0.5 : 1;

  const frames: Frame[] = [];

  // 半回合打回计数(口径:spec §5「该半回合含 illegal-attempt 时附 ⚠ 打回×n」):
  // 某方合法 move 落定 → 该方计数清零(换方重新计);遇 illegal-attempt → 该方计数取其 round 字段。
  const countersAt = (seq: number): Record<Side, number> => {
    const c: Record<Side, number> = { red: 0, black: 0 };
    for (const e of events) {
      if (e.seq > seq) break;
      if (e.type === 'move' && e.legal !== false) c[e.turn] = 0;
      else if (e.type === 'illegal-attempt') c[e.side] = e.round;
    }
    return c;
  };

  const captionAt = (i: number, mover: Side | null, rejection: number): GalleryCaption => {
    const m = i >= 1 ? moves[i - 1]! : null;
    return {
      round: Math.max(1, halfMoveToRound(i)), // open 定格要求「第 1 回合」(spec §5/§6);i≥1 与逐回合一致
      notation: m?.notation ?? '',
      cur: i,
      total,
      mover,
      rejection,
      left: '',
      right: rightOf(),
    };
  };

  // open 帧(初始局面)
  frames.push({
    mode: 'open',
    board: boardAt(events, 0),
    caption: captionAt(0, 'red', countersAt(0)['red']),
    banner: null,
    delayMs: Math.round(1500 * speed),
  });

  for (let i = 1; i <= total; i++) {
    const m = moves[i - 1]!;
    const from: Sq = m.from;
    const to: Sq = m.to;
    const reject = countersAt(m.seq - 1)[m.turn]; // 本半回合落定前的打回数(seq 严格递增,seq-1 = 该步之前)
    const boardBefore = boardAt(events, i === 1 ? 0 : moves[i - 2]!.seq);
    const boardAfter = boardAt(events, m.seq);

    frames.push({ mode: 'hold', board: boardBefore, caption: captionAt(i - 1, m.turn, reject), banner: null, delayMs: Math.round(1000 * speed) });
    for (let k = 1; k <= 4; k++) {
      frames.push({ mode: 'slide', board: boardBefore, from, to, slideT: k / 4, caption: captionAt(i - 1, m.turn, reject), banner: null, delayMs: Math.round(100 * speed) });
    }
    frames.push({ mode: 'land', board: boardAfter, from, to, caption: captionAt(i, m.turn, reject), banner: null, delayMs: Math.round(1000 * speed) });
  }

  // final 帧(终局局面 + 横幅);未完成局以当前局面为终局
  frames.push({
    mode: 'final',
    board: boardAt(events, Number.MAX_SAFE_INTEGER),
    caption: captionAt(total, null, 0), // 终局无进行中的半回合,打回徽标归零
    banner,
    delayMs: Math.round(2000 * speed),
  });
  return frames;
}
