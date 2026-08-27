//
// M0 解析 spike —— 提示词模板 + 临时文本棋盘渲染。
//
// 原则 B:红黑唯一文本差异是「角色名 / 执先执后」。
// 原则 D:只给规则与局面,绝不提供合法走法清单;打回时只讲原因、绝不枚举正确走法。
//
// 棋规文本不再硬编码于此:独立文件 `server/prompts/xiangqi-rules.md`(规则卡,红黑同文),
// 便于直接改文案/维护;本文件只负责组装 system。
//
// TODO(T11):renderAscii 将替换为 engine/render.ts 的官方 renderAscii(统一坐标);
//            届时本文件只保留 buildSystemPrompt / buildUserPrompt。
//

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// ---------- 棋规卡(独立文件,红黑同文;见 server/prompts/xiangqi-rules.md) ----------

const RULES_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'prompts', 'xiangqi-rules.md');

let rulesText: string | null = null;
/** 惰性同步读取一次并缓存;进程内同一份(含 spike 与 server 两侧调用)。 */
function loadRules(): string {
  if (rulesText === null) rulesText = readFileSync(RULES_PATH, 'utf8').trim();
  return rulesText;
}

// ---------- 系统提示词:同一份模板,仅身份差异 ----------
export function buildSystemPrompt(side: Side): string {
  const role = side === 'red' ? '红' : '黑';
  const order = side === 'red' ? '你是红方,先行。' : '你是黑方,后行。';
  return [
    `你是中国象棋棋手,执${role}方。`,
    order,
    '',
    loadRules(),
    '',
    '【棋盘与输出】',
    '- 走法可用中文记谱(如「炮二平五」「马八进七」)或坐标(如「h3-e3」);若不确定中文记谱规则(红方用中文数字列号、黑方用阿拉伯数字、进/退/平、同列同名子须加「前/后」),一律改用坐标格式--坐标绝不会因记谱写法被打回;',
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