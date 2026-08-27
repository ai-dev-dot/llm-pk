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

  const left = (i: number) => `${models?.red ?? '? 红'} vs ${models?.black ?? '? 黑'}`;
  const speed = opts.speed === 2 ? 0.5 : 1;

  const frames: Frame[] = [];
  const rejectionUpTo = (seq: number) => {
    let n = 0;
    for (const e of events) { if (e.seq > seq) break; if (e.type === 'illegal-attempt') n++; }
    return n;
  };

  const captionAt = (i: number, mover: Side | null, rejection: number): GalleryCaption => {
    const m = i >= 1 ? moves[i - 1]! : null;
    return {
      round: halfMoveToRound(i),
      notation: m?.notation ?? '',
      cur: i,
      total,
      mover,
      rejection,
      left: '',
      right: left(i),
    };
  };

  // open 帧(初始局面)
  frames.push({
    mode: 'open',
    board: boardAt(events, 0),
    caption: captionAt(0, 'red', rejectionUpTo(0)),
    banner: null,
    delayMs: Math.round(1500 * speed),
  });

  for (let i = 1; i <= total; i++) {
    const m = moves[i - 1]!;
    const from: Sq = m.from;
    const to: Sq = m.to;
    const reject = rejectionUpTo(m.seq);
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
    caption: captionAt(total, null, rejectionUpTo(Number.MAX_SAFE_INTEGER)),
    banner,
    delayMs: Math.round(2000 * speed),
  });
  return frames;
}