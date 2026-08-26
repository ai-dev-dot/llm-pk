//
// XQBoard 渲染测试(纯受控展示):初始 32 子、e1 = 帥、lastMove 高亮。
//
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import XQBoard from './XQBoard.vue';
import { initialBoard } from '../../../engine/board';
import { recordsFromBoard, type PieceRec } from '../lib/board';

describe('XQBoard', () => {
  it('初始局面渲染 16+16=32 子', () => {
    const board = initialBoard();
    const w = mount(XQBoard, { props: { pieces: board } });
    expect(w.findAll('.pc')).toHaveLength(32);
  });

  it('e1(file4/rank0)渲染「帥」', () => {
    const w = mount(XQBoard, {
      props: { pieces: [{ side: 'red', type: 'general', file: 4, rank: 0 }] },
    });
    const g = w.find('[data-file="4"][data-rank="0"]');
    expect(g.exists()).toBe(true);
    expect(g.text()).toContain('帥');
  });

  it('黑將在 e10(file4/rank9)渲染「將」', () => {
    const w = mount(XQBoard, {
      props: { pieces: [{ side: 'black', type: 'general', file: 4, rank: 9 }] },
    });
    const g = w.find('[data-file="4"][data-rank="9"]');
    expect(g.exists()).toBe(true);
    expect(g.text()).toContain('將');
  });

  it('lastMove 落在目标格:目标子带 .last-move、有 last-dot 与印章动画', () => {
    // 红兵 a? 兵四进一吃黑卒:把红兵(4,3)移到黑卒位(4,6)
    const recs = recordsFromBoard(initialBoard()).filter(
      (p) => !(p.file === 4 && (p.rank === 3 || p.rank === 6)),
    );
    recs.push({ side: 'red', type: 'pawn', file: 4, rank: 6 } satisfies PieceRec);
    const w = mount(XQBoard, {
      props: {
        pieces: recs,
        lastMove: { from: { file: 4, rank: 3 }, to: { file: 4, rank: 6 } },
      },
    });

    const target = w.find('.last-move');
    expect(target.exists()).toBe(true);
    expect(target.attributes('data-file')).toBe('4');
    expect(target.attributes('data-rank')).toBe('6');

    expect(w.find('.last-dot').exists()).toBe(true);
    expect(w.find('.stamp.anim').exists()).toBe(true);
  });

  it('九宫斜线(T18 minor 修正):红宫下、黑宫上,均居中 file3..5', () => {
    const PAD = 40;
    const CELL = 48;
    const w = mount(XQBoard, { props: { pieces: [] } });
    const lines = w.findAll('[data-palace]');
    expect(lines).toHaveLength(4);

    const xy = (l: typeof lines[number]) => ({
      xs: [Number(l.attributes('x1')), Number(l.attributes('x2'))],
      ys: [Number(l.attributes('y1')), Number(l.attributes('y2'))],
    });
    for (const l of lines) {
      const { xs, ys } = xy(l);
      // 两侧宫都横跨引擎 file3..5 两角(posX(3)=PAD+3C,posX(5)=PAD+5C)
      expect([...xs].sort((a, b) => a - b)).toEqual([PAD + 3 * CELL, PAD + 5 * CELL]);
      if (l.attributes('data-palace') === 'red') {
        // 红宫:下部 rank0..2 → posY(0)=PAD+9C,posY(2)=PAD+7C
        expect([...ys].sort((a, b) => a - b)).toEqual([PAD + 7 * CELL, PAD + 9 * CELL]);
      } else {
        // 黑宫:上部 rank7..9 → posY(7)=PAD+2C,posY(9)=PAD
        expect([...ys].sort((a, b) => a - b)).toEqual([PAD, PAD + 2 * CELL]);
      }
    }
  });

  it('显式 uid:同 key 跨帧复用同一 DOM 节点(走子补间断言)', async () => {
    const a: PieceRec = { side: 'red', type: 'cannon', file: 7, rank: 2, uid: 'red:cannon:0' };
    const b: PieceRec = { side: 'red', type: 'cannon', file: 1, rank: 2, uid: 'red:cannon:1' };
    const w = mount(XQBoard, { props: { pieces: [a, b] } });
    const node = w.find('[data-file="7"][data-rank="2"]').element;

    // 炮二平五:h3(7,2)→e3(4,2);uid 不变
    await w.setProps({ pieces: [b, { ...a, file: 4, rank: 2 }] });
    const moved = w.find('[data-file="4"][data-rank="2"]').element;
    expect(moved).toBe(node);
  });

  it('无显式 uid 的棋子仍走旧 diff 路径(兼容)', async () => {
    const p1: PieceRec = { side: 'red', type: 'rook', file: 0, rank: 0 };
    const w = mount(XQBoard, { props: { pieces: [p1] } });
    expect(w.findAll('.pc')).toHaveLength(1);
    await w.setProps({ pieces: [{ ...p1, file: 1, rank: 0 }] });
    expect(w.findAll('.pc')).toHaveLength(1);
  });
});