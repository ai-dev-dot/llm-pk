import { describe, it, expect } from 'vitest';
import { codeToSq, sqToCode, sqKey } from './types';
describe('坐标体系', () => {
  it('红底线行1=rank0,列a..i=file0..8', () => {
    expect(sqToCode({ file: 7, rank: 0 })).toBe('h1');   // 仅验证换算:h=file7,行1=rank0(不必对应真实布阵)
    expect(codeToSq('h1')).toEqual({ file: 7, rank: 0 });
    expect(sqKey({ file: 7, rank: 0 })).toBe('7,0');
  });
});