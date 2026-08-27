import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../../server/game-log';
import { buildFrames, bannerText } from './frames';
import { REASON_TEXT } from './frames';
import { codeToSq } from '../../engine/types';

const b = (mn: number): GameEvent => ({ seq: mn, ts: 't', type: 'begin', gameId: 'g', first: 'red', red: { model: 'R' }, black: { model: 'B' } });
const mv = (seq: number, from: string, to: string, turn: 'red' | 'black'): GameEvent => ({ seq, ts: 't', type: 'move', turn, move: { from, to }, legal: true });
const fin = (seq: number, winner: 'red' | 'black' | 'draw', reason: string): GameEvent => ({ seq, ts: 't', type: 'finish', winner, reason, ruleViolations: { red: { pre: 0, post: 0 }, black: { pre: 0, post: 0 } } });

describe('frames.buildFrames', () => {
  it('N 步=1+6N+1 帧;首 open 末 final;delay 符合常规档', () => {
    const evs = [b(1), mv(2, 'h3', 'e3', 'red'), mv(3, 'h8', 'e8', 'black'), mv(4, 'h2', 'e2', 'red'), fin(5, 'red', 'checkmate')];
    const fr = buildFrames(evs, { speed: 1 });
    expect(fr.length).toBe(1 + 6 * 3 + 1); // 20
    expect(fr[0]!.mode).toBe('open');
    expect(fr[0]!.delayMs).toBe(1500);
    expect(fr[0]!.caption.round).toBe(1); // 开局定格「第 1 回合」(spec §5/§6)
    expect(fr.at(-1)!.mode).toBe('final');
    expect(fr.at(-1)!.delayMs).toBe(2000);
    // 每步: hold(1s)+slide4(100ms)+land(1s)
    const step = fr.slice(1, 7);
    expect(step.map((f) => f.mode)).toEqual(['hold', 'slide', 'slide', 'slide', 'slide', 'land']);
    expect(step.map((f) => f.delayMs)).toEqual([1000, 100, 100, 100, 100, 1000]);
    expect(fr.at(-1)!.banner!.title).toBe('红方勝');
  });

  it('speed=2 全部减半', () => {
    const evs = [b(1), mv(2, 'h3', 'e3', 'red'), fin(3, 'black', 'stalemate')];
    const fr = buildFrames(evs, { speed: 2 });
    expect(fr[0]!.delayMs).toBe(750);
    const slideMs = fr.find((f) => f.mode === 'slide')!.delayMs;
    expect(slideMs).toBe(50);
  });

  it('slide 帧携带 from/to 与补间进度', () => {
    const evs = [b(1), mv(2, 'h3', 'e3', 'red'), fin(3, 'draw', 'draw-repeat')];
    const slides = buildFrames(evs, { speed: 1 }).filter((f) => f.mode === 'slide');
    expect(slides).toHaveLength(4);
    expect(slides[0]!.from).toEqual(codeToSq('h3'));
    expect(slides[0]!.to).toEqual(codeToSq('e3'));
    expect(slides.map((s) => s.slideT)).toEqual([0.25, 0.5, 0.75, 1]);
  });

  it('字幕回合/手数/行棋方更新;非法留痕不占挽面', () => {
    const evs = [b(1)] as GameEvent[];
    let seq = 1;
    const illegal: GameEvent = { seq: ++seq, ts: 't', type: 'illegal-attempt', side: 'red', round: 1, reason: '馬腿被絆', violations: { pre: 1, post: 0 } };
    const mv1: GameEvent = { seq: ++seq, ts: 't', type: 'move', turn: 'red', move: { from: 'h3', to: 'e3', notation: '炮二平五' }, legal: true };
    const bad: GameEvent = { seq: ++seq, ts: 't', type: 'move', turn: 'red', move: { from: 'xxx', to: 'yy' }, legal: false };
    const evs2 = [...evs, illegal, mv1, bad];
    const fr = buildFrames(evs2, { speed: 1 });
    const land = fr.find((f) => f.mode === 'land')!;
    expect(land.board.some((p) => p.file === 4 && p.rank === 2)).toBe(true); // 红炮 h3(7,2)→e3(4,2)
    // 记谱:第一步含非法 → 打回徽标计 1(半回合口径,本半回合内 red 第 1 次)
    expect(land.caption.rejection).toBe(1);
    expect(land.caption.cur).toBe(1);
    expect(land.caption.round).toBeGreaterThanOrEqual(1); // 走子后回合数 ≥1
    expect(land.caption.mover).toBe('red'); // 行棋方红
    expect(land.caption.right.length).toBeGreaterThan(0); // 右段模型名非空
  });

  it('未完成局 final 横幅为「对局进行中」', () => {
    const evs = [b(1), mv(2, 'h3', 'e3', 'red')];
    const fr = buildFrames(evs, { speed: 1 });
    expect(fr.at(-1)!.mode).toBe('final');
    expect(fr.at(-1)!.banner!.title).toBe('对局进行中');
  });

  it('reason 文案表与 web/src/lib/format.ts 全集对齐', async () => {
    const { fmtReason } = await import('../../web/src/lib/format');
    const reasons: string[] = ['checkmate', 'stalemate', 'illegal-moves', 'timeout', 'internal-error', 'draw-aborted', 'draw-repeat', 'draw-no-mating-material', 'draw-max-moves', 'draw-cost-limit', 'draw-network'];
    for (const r of reasons) expect(REASON_TEXT[r]).toBe(fmtReason(r));
  });
});

describe('frames.bannerText', () => {
  it('胜/和/未决三种横幅', () => {
    expect(bannerText('red', 'checkmate', true)!.title).toBe('红方勝');
    expect(bannerText('draw', 'draw-repeat', true)!.title).toBe('和棋');
    expect(bannerText(undefined, undefined, false)!.title).toBe('对局进行中');
  });
});
