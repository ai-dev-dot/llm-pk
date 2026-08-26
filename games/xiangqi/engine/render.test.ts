import { describe, it, expect } from 'vitest';
import { initialBoard, type Board } from './board';
import { sqToIdx } from './board';
import { renderAscii, withColumnLabels, toPerspective } from './render';

/**
 * spec §4 样例的逐字节复刻(初始局):
 * 红底行 1 在下、黑顶行 10 在上;列标 a..i 在顶;行号 1..10 在侧;
 * 空位 `.`,棋子 `[字]`,河界行 label 5 为虚线分隔。
 */
const EXPECTED_INITIAL = [
  '    a   b   c   d   e   f   g   h   i',
  '10  [車] [馬] [象] [士] [將] [士] [象] [馬] [車]  黑(顶)',
  ' 9  .   .   .   .   .   .   .   .   .',
  ' 8  .   [砲] .   .   .   .   .   [砲] .',
  ' 7  [卒] .   [卒] .   [卒] .   [卒] .   [卒]',
  ' 6  .   .   .   .   .   .   .   .   .',
  ' 5  ─────────────── 楚 河 漢 界 ─────────────',
  ' 4  [兵] .   [兵] .   [兵] .   [兵] .   [兵]',
  ' 3  .   [砲] .   .   .   .   .   [砲] .',
  ' 2  .   .   .   .   .   .   .   .   .',
  ' 1  [車] [馬] [相] [仕] [帥] [仕] [相] [馬] [車]  红(底)',
].join('\n');

describe('renderAscii(spec §4 样例)', () => {
  it('初始局逐字节等于 spec §4 样例', () => {
    expect(renderAscii(initialBoard())).toBe(EXPECTED_INITIAL);
  });

  it('含黑顶行关键片段与列标头', () => {
    const out = renderAscii(initialBoard());
    expect(out).toContain('[車] [馬] [象] [士] [將] [士] [象] [馬] [車]');
    expect(out).toContain('    a   b   c   d   e   f   g   h   i');
  });

  it('含红底行关键片段(仕/相/帥)与红黑钳炮字', () => {
    const out = renderAscii(initialBoard());
    expect(out).toContain('[車] [馬] [相] [仕] [帥] [仕] [相] [馬] [車]');
    expect(out).toContain('[砲]');   // 红黑统一用砲(spec §4 样例)
    expect(out).toContain('[卒]');
    expect(out).toContain('[兵]');
  });

  it('空位居中用 . 表示,河界字样存在', () => {
    const out = renderAscii(initialBoard());
    expect(out).toContain(' 9  .   .   .   .   .   .   .   .   .');
    expect(out).toContain('楚 河 漢 界');
  });

  it('行号 1..10 全部出现,红底 1 在下黑顶 10 在上', () => {
    const out = renderAscii(initialBoard());
    expect(out.startsWith('    a   b   c   d   e   f   g   h   i\n10  ')).toBe(true);
    expect(out).toContain('  红(底)');
    expect(out).toContain('  黑(顶)');
  });
});

describe('renderAscii(90 格布局对应)', () => {
  it('空棋盘:10 行点阵 + 河界行', () => {
    const b: Board = new Array(90).fill(null);
    const out = renderAscii(b);
    expect(out).toContain(' 5  ─────────────── 楚 河 漢 界 ─────────────');
    expect(out.split('\n')).toHaveLength(11);   // 列标头 + 10 行
  });

  it('河界行(rank4)上有子时渲染棋子而非虚线,保证 90 格可渲染', () => {
    const b: Board = new Array(90).fill(null);
    b[sqToIdx(0, 4)] = { side: 'red', type: 'general' };   // a5
    b[sqToIdx(4, 4)] = { side: 'black', type: 'pawn' };    // e5
    b[sqToIdx(8, 4)] = { side: 'red', type: 'cannon' };    // i5
    const out = renderAscii(b);
    expect(out).toContain(' 5  [帥] .   .   .   [卒] .   .   .   [砲]');
    expect(out).not.toContain('楚 河 漢 界');   // 本行被棋子占据,虚线让位
  });

  it('60 格布局对应:每格字符与索引一致文件散点', () => {
    const b: Board = new Array(90).fill(null);
    const RED_ROOK = { side: 'red' as const, type: 'rook' as const };
    b[sqToIdx(0, 0)] = RED_ROOK;              // a1
    b[sqToIdx(8, 9)] = { side: 'black', type: 'rook' };   // i10
    const out = renderAscii(b);
    expect(out).toContain(' 1  [車] .   .   .   .   .   .   .   .');
    expect(out).toContain('10  .   .   .   .   .   .   .   .   [車]  黑(顶)');
  });
});

describe('withColumnLabels(两侧列标)', () => {
  it('在无列标主体文本的顶部与底部各补一行列标', () => {
    const body = '10  [車] [馬]\n 1  [帥] [相]';
    const out = withColumnLabels(body);
    expect(out).toBe([
      '    a   b   c   d   e   f   g   h   i',
      '10  [車] [馬]',
      ' 1  [帥] [相]',
      '    a   b   c   d   e   f   g   h   i',
    ].join('\n'));
  });
});

describe('toPerspective(红/黑统一视角)', () => {
  it('红黑两侧看到完全同一张图,且等于 renderAscii', () => {
    const b = initialBoard();
    expect(toPerspective(b, 'red')).toBe(renderAscii(b));
    expect(toPerspective(b, 'black')).toBe(renderAscii(b));
    expect(toPerspective(b, 'red')).toBe(toPerspective(b, 'black'));
  });
});