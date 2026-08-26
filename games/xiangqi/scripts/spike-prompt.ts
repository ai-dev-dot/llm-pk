//
// M0 解析 spike —— 提示词模板 + 临时文本棋盘渲染。
//
// 原则 B:红黑唯一文本差异是「角色名 / 执先执后」。
// 原则 D:只给规则与局面,绝不提供合法走法清单;打回时只讲原因、绝不枚举正确走法。
//
// TODO(T11):renderAscii 将替换为 engine/render.ts 的官方 renderAscii(统一坐标);
//            届时本文件只保留 buildSystemPrompt / buildUserPrompt。
//

import type { Board, Side } from '../engine/board';
import { pieceAt } from '../engine/board';

// ---------- 临时自绘文本棋盘(坐标与 T11 统一:列 a..i,行 1..10) ----------
const PIECE_CHARS: Record<string, string> = {
  'r:rook': '車', 'r:horse': '馬', 'r:elephant': '相', 'r:advisor': '仕',
  'r:general': '帥', 'r:cannon': '炮', 'r:pawn': '兵',
  'b:rook': '車', 'b:horse': '馬', 'b:elephant': '象', 'b:advisor': '士',
  'b:general': '將', 'b:cannon': '砲', 'b:pawn': '卒',
};

/** 临时渲染:rank 9(黑底线)在顶,rank 0(红底线)在底;列 a(左)~i(右)。 */
export function renderAscii(board: Board): string {
  const FILES = 'abcdefghi'.split('');
  let out = '    ' + FILES.map((f) => ` ${f} `).join('') + '\n';
  for (let rank = 9; rank >= 0; rank--) {
    const label = String(rank + 1).padStart(2);
    out += `${label}  `;
    for (let file = 0; file < 9; file++) {
      const p = pieceAt(board, { file, rank });
      out += p === null ? ' . ' : `[${PIECE_CHARS[`${p.side}:${p.type}`] ?? '?'}]`;
    }
    out += '\n';
    if (rank === 6) out += '     ───────────────── 楚 河 漢 界 ─────────────────\n';
  }
  return out;
}

// ---------- 系统提示词:同一份模板,仅身份差异 ----------
export function buildSystemPrompt(side: Side): string {
  const role = side === 'red' ? '红' : '黑';
  const order = side === 'red' ? '你是红方,先行。' : '你是黑方,后行。';
  return [
    `你是中国象棋棋手,执${role}方。`,
    order,
    '',
    '【棋规(简)】',
    '- 车:直线(横/竖)行走,距离不限,路线上不得有棋子阻挡;',
    '- 马:走「日」字;若前进方向的紧邻格被占(蹩马腿)则不能跳;',
    '- 炮:直线行走,不吃子时不可越过棋子;吃子时须且仅须越过恰好一枚棋子(炮架);',
    '- 象/相:斜走两格(田字),象眼被占则不能走;不可过河;',
    '- 士/仕:九宫内斜走一格;',
    '- 将/帅:九宫内横或竖走一格(不可斜);双方将帅不得同列直接照面;',
    '- 兵/卒:只许前进、不可后退;过河(越过楚河汉界)后方可横走;',
    '- 禁止送将:走完后不得令己方将帅处于可被吃的位置;若已被将军,必须应将。',
    '',
    '【本局简化裁定】',
    '- 同一局面重复出现 3 次判和;步数达上限判和;不做长将长捉精细裁定。',
    '',
    '【棋盘与输出】',
    '- 列 a~i 从左到右;行 1~10 自红方底线向黑方递增(下方为红、上方为黑);',
    '- 走法可用中文记谱(如「炮二平五」「马八进七」)或坐标(如「h3-e3」);',
    '- 请用工具提交 { analysis, move }:先给思考 analysis,再给这一步的 move;',
    '- 只提交一步棋,不要答复多余内容。',
  ].join('\n');
}

// ---------- 用户提示词:棋盘 + 历史 + 将军/打回情形 ----------
export interface SpikePromptCtx {
  side: Side;
  board: Board;
  /** 已走出步法(统一坐标,如 "h3-e3"),最旧在前。 */
  history: string[];
  inCheck: boolean;
  rejection?: { count: number; reason: string; text?: string };
}

export function buildUserPrompt(ctx: SpikePromptCtx): string {
  const { side, board, history, inCheck, rejection } = ctx;
  const L: string[] = [];
  L.push(`当前局面(下方为红方、第 1 行;上方为黑方、第 10 行)。现在轮到${side === 'red' ? '红' : '黑'}方走棋:`);
  L.push('');
  L.push(renderAscii(board));
  L.push('');
  if (history.length > 0) {
    L.push('已走出步法(统一坐标):');
    L.push(history.map((m, i) => `  ${i + 1}. ${m}`).join('\n'));
    L.push('');
  }
  if (inCheck) L.push('【警告】你正被将军,必须走一步应将的棋。');
  if (rejection) {
    const k = rejection.count > 1 ? `(第 ${rejection.count} 次被拒)` : '';
    const quoted = rejection.text ? `「${rejection.text}」` : '上一步';
    L.push(`【裁判】你${quoted}无效${k},原因: ${rejection.reason}。请换一步,不要重复同一走法。`);
  }
  L.push('请用工具提交 { analysis, move }。');
  return L.join('\n');
}