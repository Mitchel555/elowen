import { describe, it, expect } from 'vitest';
import { isGitSha } from '../../src/shared/gitSha.js';

describe('isGitSha', () => {
  it('accepts short and full-length lowercase hex ids', () => {
    expect(isGitSha('abcd')).toBe(true);
    expect(isGitSha('c0ffee')).toBe(true);
    expect(isGitSha('a'.repeat(40))).toBe(true);
  });

  it('accepts uppercase hex', () => {
    expect(isGitSha('ABCDEF1234')).toBe(true);
    expect(isGitSha('aBcDeF')).toBe(true);
  });

  it('rejects ids shorter than 4 or longer than 40 chars', () => {
    expect(isGitSha('')).toBe(false);
    expect(isGitSha('abc')).toBe(false);
    expect(isGitSha('a'.repeat(41))).toBe(false);
  });

  it('rejects anything that is not plain hex — a git flag must never pass', () => {
    expect(isGitSha('--all')).toBe(false);
    expect(isGitSha('-c')).toBe(false);
    expect(isGitSha('abcg')).toBe(false);
    expect(isGitSha('abcd ')).toBe(false);
    expect(isGitSha('ab cd')).toBe(false);
    expect(isGitSha('abcd!')).toBe(false);
  });
});
