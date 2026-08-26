import { describe, expect, it } from 'vitest';
import { SideSession, type ChatMessage } from './session';

/* ---------- 窗口裁旧(brief 片段) ---------- */

describe('SideSession 回显窗口(自我分析)', () => {
  it('carrySelfAnalysisN 窗口:只保留最近 N 条己方 analysis,旧思考丢弃', () => {
    const sa = new SideSession('red', { carrySelfAnalysisN: 2 });
    sa.pushMoveResult({ move: 'h3-e3', notation: '炮二平五', analysis: 'a1' });
    sa.pushMoveResult({ move: 'h2-e2', notation: '炮八平五', analysis: 'a2' });
    sa.pushMoveResult({ move: 'b1-c3', notation: '马8进7', analysis: 'a3' });
    expect(sa.selfThoughts().map((t) => t.analysis)).toEqual(['a2', 'a3']);
  });

  it('窗口裁剪同步移除 messages 中对应的旧 analysis 消息', () => {
    const sa = new SideSession('red', { carrySelfAnalysisN: 2 });
    sa.pushMoveResult({ move: 'h3-e3', analysis: 'a1' });
    sa.pushMoveResult({ move: 'h2-e2', analysis: 'a2' });
    sa.pushMoveResult({ move: 'b1-c3', analysis: 'a3' });
    const analyses = sa.messages.filter((m) => m.kind === 'analysis');
    expect(analyses.map((m) => m.analysis)).toEqual(['a2', 'a3']);
    expect(JSON.stringify(sa.messages)).not.toContain('a1');
  });

  it('pushMoveResult 与 pushTurnResult 为同一功能的两个名(controller 契约)', () => {
    const sa = new SideSession('red', { carrySelfAnalysisN: 2 });
    sa.pushMoveResult({ move: 'h3-e3', analysis: 'a1' });
    sa.pushTurnResult({ move: 'h2-e2', analysis: 'a2' });
    sa.pushTurnResult({ move: 'b1-c3', analysis: 'a3' });
    expect(sa.selfThoughts().map((t) => t.analysis)).toEqual(['a2', 'a3']);
  });

  it('carrySelfAnalysisN=0 时 analysis 不入会话(对照实验:窗口设 0)', () => {
    const sa = new SideSession('red', { carrySelfAnalysisN: 0 });
    sa.pushMoveResult({ move: 'h3-e3', analysis: 'a1' });
    expect(sa.selfThoughts()).toEqual([]);
    expect(sa.messages.filter((m) => m.kind === 'analysis')).toHaveLength(0);
  });

  it('pushTurnResult 记录公共历史(compact 记谱)与己方 analysis', () => {
    const sa = new SideSession('red', { carrySelfAnalysisN: 6 });
    sa.pushTurnResult({ move: 'h3-e3', notation: '炮二平五', analysis: '瞄准中路' });
    const history = sa.messages.filter((m) => m.kind === 'history');
    expect(history.map((m) => m.content)).toEqual(['炮二平五']);
    expect(sa.selfThoughts()).toEqual([
      { move: 'h3-e3', notation: '炮二平五', analysis: '瞄准中路' },
    ]);
  });
});

/* ---------- rejection 覆盖(brief 片段) ---------- */

describe('SideSession rejection 同回合覆盖', () => {
  it('setRejection 同回合内覆盖为新 reason,不追加多条', () => {
    const sa = new SideSession('red', { carrySelfAnalysisN: 2 });
    sa.setRejection({ reason: '马被蹩腿' });
    sa.setRejection({ reason: '走后照面' });
    const rejects = sa.messages.filter((m) => m.role === 'rejection');
    expect(rejects.length).toBe(1);
    expect(rejects[0].content).toBe('走后照面');
  });

  it('replaceRejection 为同一语义的别名(brief 接口名)', () => {
    const sa = new SideSession('red', { carrySelfAnalysisN: 2 });
    sa.replaceRejection({ reason: 'r1' });
    sa.replaceRejection({ reason: 'r2' });
    const rejects = sa.messages.filter((m) => m.role === 'rejection');
    expect(rejects.length).toBe(1);
    expect(rejects[0].content).toBe('r2');
  });

  it('setBoard 开启新回合:更新当前棋盘并清掉上回合 rejection', () => {
    const sa = new SideSession('red', { carrySelfAnalysisN: 2 });
    sa.setBoard('ascii-round-1');
    sa.setRejection({ reason: '马被蹩腿' });
    expect(sa.messages.filter((m) => m.role === 'rejection')).toHaveLength(1);

    sa.setBoard('ascii-round-2');
    const boards = sa.messages.filter((m) => m.kind === 'board');
    expect(boards).toHaveLength(1);
    expect(boards[0].content).toBe('ascii-round-2');
    expect(sa.messages.filter((m) => m.role === 'rejection')).toHaveLength(0);
  });
});

/* ---------- 隔离(结构层 + spy 断言) ---------- */

describe('SideSession 隔离(assertNoLeak)', () => {
  const redThought = '红方思考:架中炮瞄准中路';
  const blackThought = '黑方思考:跳防马护中兵';

  it('红黑互查不抛:assertNoLeak 双方对称', () => {
    const sa = new SideSession('red', { carrySelfAnalysisN: 6 });
    const sb = new SideSession('black', { carrySelfAnalysisN: 6 });
    sa.setSystemPrompt('你执红。公共规则:……');
    sb.setSystemPrompt('你执黑。公共规则:……');
    sa.pushTurnResult({ move: 'h3-e3', notation: '炮二平五', analysis: redThought });
    sb.pushTurnResult({ move: 'h9-g7', notation: '马8进7', analysis: blackThought });

    expect(() => sa.assertNoLeak(sb)).not.toThrow();
    expect(() => sb.assertNoLeak(sa)).not.toThrow();
  });

  it('spy 断言:本方 messages 序列化含己方 analysis、绝不含对方 analysis', () => {
    const sa = new SideSession('red', { carrySelfAnalysisN: 6 });
    const sb = new SideSession('black', { carrySelfAnalysisN: 6 });
    sa.pushTurnResult({ move: 'h3-e3', notation: '炮二平五', analysis: redThought });
    sb.pushTurnResult({ move: 'h9-g7', notation: '马8进7', analysis: blackThought });

    expect(JSON.stringify(sa.messages)).toContain(redThought);
    expect(JSON.stringify(sa.messages)).not.toContain(blackThought);
    expect(JSON.stringify(sb.messages)).toContain(blackThought);
    expect(JSON.stringify(sb.messages)).not.toContain(redThought);
  });

  it('结构层失效时(误写成对方 analysis)assertNoLeak 抛错告警', () => {
    const sa = new SideSession('red', { carrySelfAnalysisN: 2 });
    const sb = new SideSession('black', { carrySelfAnalysisN: 2 });
    sb.pushTurnResult({ move: 'b1-c3', analysis: 'secret-black-thought' });
    // 模拟结构层被破坏:有人把对方思考写进本方历史
    sa.push({
      role: 'user',
      kind: 'history',
      content: '黑方曾流露 secret-black-thought',
    } satisfies ChatMessage);
    expect(() => sa.assertNoLeak(sb)).toThrow();
  });

  it('公共历史可对称出现(记谱非机密),不触发泄漏', () => {
    const sa = new SideSession('red', { carrySelfAnalysisN: 6 });
    const sb = new SideSession('black', { carrySelfAnalysisN: 6 });
    // 双方都记录同一手公共记谱
    sa.pushTurnResult({ move: 'h3-e3', notation: '炮二平五', analysis: redThought });
    sb.pushTurnResult({ move: 'h9-g7', notation: '马8进7', analysis: blackThought });
    // 黑方历史同样包含公共记谱(非 analysis,不泄漏)
    sa.push({ role: 'user', kind: 'history', content: '马8进7(对方行棋)' });
    expect(() => sa.assertNoLeak(sb)).not.toThrow();
    expect(JSON.stringify(sa.messages)).not.toContain(blackThought);
  });
});

/* ---------- 软护栏(contextBudgetTokens) ---------- */

describe('SideSession 软护栏(校准前不硬裁剪)', () => {
  it('超预算仅记录 warning,budget() 返回估算,消息不被硬裁剪', () => {
    const sa = new SideSession('red', { carrySelfAnalysisN: 6, contextBudgetTokens: 50 });
    sa.pushTurnResult({ move: 'h3-e3', notation: '炮二平五', analysis: 'x'.repeat(400) });

    expect(sa.budget()).toBeGreaterThan(50);
    expect(sa.warnings.length).toBeGreaterThan(0);
    expect(sa.warnings.some((w) => w.includes('soft-guard'))).toBe(true);
    // 软护栏:仅观测不硬裁剪 —— analysis 消息仍在
    expect(sa.messages.filter((m) => m.kind === 'analysis')).toHaveLength(1);
  });

  it('contextBudgetTokens 未超出时无告警,预算随内容增长', () => {
    const sa = new SideSession('red', { carrySelfAnalysisN: 6, contextBudgetTokens: 100000 });
    sa.pushTurnResult({ move: 'h3-e3', analysis: 'short' });
    expect(sa.warnings).toEqual([]);
    expect(sa.budget()).toBeGreaterThan(0);

    sa.pushTurnResult({ move: 'h2-e2', analysis: 'x'.repeat(400) });
    expect(sa.budget()).toBeGreaterThan(30);
    expect(sa.warnings).toEqual([]);
  });

  it('缺省 contextBudgetTokens 取 spec 默认 32000', () => {
    const sa = new SideSession('red', { carrySelfAnalysisN: 6 });
    expect(sa.budget()).toBeLessThan(32000);
    expect(sa.warnings).toEqual([]);
  });
});

/* ---------- 通用 push 与 system ---------- */

describe('SideSession 通用消息', () => {
  it('setSystemPrompt 置首并更新(幂等);非 system 消息起始在 system 之后', () => {
    const sa = new SideSession('red', { carrySelfAnalysisN: 2 });
    sa.push({ role: 'user', kind: 'history', content: 'record-1' });
    sa.setSystemPrompt('你执红。规则:……');
    expect(sa.messages[0].role).toBe('system');
    expect(sa.messages[0].content).toContain('你执红');
    expect(sa.messages.map((m) => m.content)).toContain('record-1');

    sa.setSystemPrompt('你执红。规则:……(更新版)');
    expect(sa.messages.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(sa.messages[0].content).toContain('更新版');
  });
});