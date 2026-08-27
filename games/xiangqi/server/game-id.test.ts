//
// T19 归档友好 id:命名纯函数单测(不触网、不读盘——existing/inFlight 全部注入)。
//
import { describe, expect, it } from 'vitest';
import { pickNextSeq, sameDayBase, slugifySideLabel, yyyymmdd } from './game-id';

const fresh = () => new Map<string, number>();

describe('yyyymmdd 本地时区日期', () => {
  it('2026-08-27 → 20260827(月/日补零)', () => {
    expect(yyyymmdd(new Date(2026, 7, 27))).toBe('20260827');
    expect(yyyymmdd(new Date(2026, 0, 3))).toBe('20260103');
  });
});

describe('slugifySideLabel 清洗', () => {
  it('保留字母数字与连字符:llm-1-name 原样', () => {
    expect(slugifySideLabel('llm-1-name')).toBe('llm-1-name');
  });

  it('点号/下划线等折叠为连字符:GLM-5.3-Flash → GLM-5-3-Flash', () => {
    expect(slugifySideLabel('GLM-5.3-Flash')).toBe('GLM-5-3-Flash');
    expect(slugifySideLabel('a b_c.d')).toBe('a-b-c-d');
  });

  it('首尾分隔符剪掉;纯非 ASCII(中文)→ 空回落 na', () => {
    expect(slugifySideLabel('-foo-')).toBe('foo');
    expect(slugifySideLabel('智能模型')).toBe('na');
    expect(slugifySideLabel('')).toBe('na');
  });

  it('超长截断 24 字符,且尾部不残留连字符', () => {
    const s = slugifySideLabel('a'.padEnd(40, 'b'));
    expect(s.length).toBeLessThanOrEqual(24);
    expect(s.endsWith('-')).toBe(false);
  });
});

describe('sameDayBase 前缀拼接', () => {
  it('date-red-pk-black', () => {
    expect(sameDayBase('20260827', 'A', 'B')).toBe('20260827-A-pk-B');
  });
});

describe('pickNextSeq 当日同对阵递增', () => {
  it('空目录首局 → seq1,id 形如 <date>-<red>-pk-<black>-01', () => {
    const r = pickNextSeq([], '20260827', 'GLM-5-3-Flash', 'deepseek-v4-flash', fresh());
    expect(r).toEqual({
      seq: 1,
      id: '20260827-GLM-5-3-Flash-pk-deepseek-v4-flash-01',
    });
  });

  it('已有 -01/-02 → 03;同 inFlight 再来 → 04(防并发撞号)', () => {
    const m = fresh();
    const existing = ['20260827-A-pk-B-01.jsonl', '20260827-A-pk-B-02.jsonl'];
    const r1 = pickNextSeq(existing, '20260827', 'A', 'B', m);
    expect(r1.seq).toBe(3);
    const r2 = pickNextSeq(existing, '20260827', 'A', 'B', m);
    expect(r2.seq).toBe(4); // 磁盘没变,但 inFlight 记住已签发 3
    expect(r2.id).toBe('20260827-A-pk-B-04');
  });

  it('同一天不同对阵各自从 01 起', () => {
    const a = pickNextSeq([], '20260827', 'A', 'B', fresh());
    const c = pickNextSeq([], '20260827', 'A', 'C', fresh());
    expect(a.seq).toBe(1);
    expect(c.seq).toBe(1);
  });

  it('忽略无关文件、短序号与非 .jsonl 后缀;两位序号以内稳定解析', () => {
    const existing = [
      '20260827-A-pk-B-03.jsonl.bak', // 非 .jsonl 结尾
      '20260827-A-pk-B-1.jsonl', // 一位序号(<2),不算
      '20260828-A-pk-B-99.jsonl', // 不同日期,不算
      'other.jsonl',
    ];
    const r = pickNextSeq(existing, '20260827', 'A', 'B', fresh());
    expect(r.seq).toBe(1);
  });

  it('三位序号也认(多局归档)', () => {
    const existing = ['20260827-A-pk-B-100.jsonl'];
    expect(pickNextSeq(existing, '20260827', 'A', 'B', fresh()).seq).toBe(101);
  });
});