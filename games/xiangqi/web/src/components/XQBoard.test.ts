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
});