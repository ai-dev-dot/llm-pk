//
// 局面 → ASCII 文本棋盘(唯一传给 LLM 的视野,原则 A)。
//
// 纯函数、零 IO;只依赖 board 与静态字集,不 import moves/judge 以避免循环依赖。
// 版面精确复刻 spec §4 样例:
//   - 列标 a..i 在顶;行号 1..10 在两侧(红底行 1 在下、黑顶行 10 在上);
//   - 空位 `.`,棋子 `[字]`(方括号),每格 4 显示列对齐;
//   - label 5 行在 rank4 全空时显示「楚 河 漢 界」虚线;rank4 有子时渲染真实棋子,
//     保证 90 格一律可渲染(河界只让位不吞格)。
// 红黑统一坐标同图,不镜像(toPerspective 恒等)。
//

import { sqToIdx, type Board, type Side } from './board';

const FILES = 'abcdefghi';

// 列标行:4 前导空格 + 9 个 4 宽格(字母 + 3 空格),与棋子/空位格的起点对齐。
const COL_HEADER = ' '.repeat(4) + FILES.split('').map((f) => f.padEnd(4)).join('').trimEnd();

// 字集:红車馬相仕帥 + 炮统一「砲」(spec §4 样例红黑均 [砲]);兵/卒、相/象、仕/士、帥/將 分色。
const PIECE_CHARS: Record<string, string> = {
  'red:rook': '車', 'red:horse': '馬', 'red:elephant': '相', 'red:advisor': '仕',
  'red:general': '帥', 'red:cannon': '砲', 'red:pawn': '兵',
  'black:rook': '車', 'black:horse': '馬', 'black:elephant': '象', 'black:advisor': '士',
  'black:general': '將', 'black:cannon': '砲', 'black:pawn': '卒',
};

// 河界行(spec §4):左侧 15 个 ─、右侧 13 个 ─。
const RIVER_LINE = ' 5  ' + '─'.repeat(15) + ' 楚 河 漢 界 ' + '─'.repeat(13);

/** rank 全空?用于决定该行是否显示河界虚线。 */
function rankRowEmpty(board: Board, rank: number): boolean {
  for (let f = 0; f < 9; f++) {
    if (board[sqToIdx(f, rank)] !== null) return false;
  }
  return true;
}

/** 单行:行号 + 2 空格 + 9 个 4 宽格(棋子/空位)。 */
function rankLine(board: Board, rank: number): string {
  const cells: string[] = [];
  for (let f = 0; f < 9; f++) {
    const p = board[sqToIdx(f, rank)];
    cells.push(p === null ? '.' : `[${PIECE_CHARS[`${p.side}:${p.type}`] ?? '?'}]`);
  }
  return String(rank + 1).padStart(2) + '  ' + cells.map((c) => c.padEnd(4)).join('').trimEnd();
}

/** 棋盘主体(不含列标行):rank9(顶)到 rank0(底),10 行。 */
function renderBody(board: Board): string {
  const lines: string[] = [];
  for (let rank = 9; rank >= 0; rank--) {
    const label = rank + 1;
    if (label === 5 && rankRowEmpty(board, 4)) {
      lines.push(RIVER_LINE);
      continue;
    }
    let line = rankLine(board, rank);
    if (rank === 9) line += '  黑(顶)';
    else if (rank === 0) line += '  红(底)';
    lines.push(line);
  }
  return lines.join('\n');
}

/** 标准文本棋盘:列标行 + 10 行主体。 */
export function renderAscii(board: Board): string {
  return COL_HEADER + '\n' + renderBody(board);
}

/**
 * 给「无列标的主体文本」两侧(top 与 bottom)补上列标 a..i。
 * 接受棋盘主体字符串(如手动拼装的细长版棋盘),返回带上下双列标的整块文本。
 */
export function withColumnLabels(body: string): string {
  const trimmed = body.replace(/\s+$/, '');
  return `${COL_HEADER}\n${trimmed}\n${COL_HEADER}`;
}

/**
 * 红/黑统一坐标:两侧看到完全同一张图,不镜像(原则 B 公证性)。
 * 返回与 renderAscii 相同;side 参数保留以示「该方视角」契约——红黑同图。
 */
export function toPerspective(board: Board, _side: Side): string {
  return renderAscii(board);
}