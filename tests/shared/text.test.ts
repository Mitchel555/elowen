import { describe, it, expect } from 'vitest';
import { collapseWhitespace, escapeRegExp, containsWholeToken } from '../../src/shared/text.js';

describe('collapseWhitespace', () => {
  it('folds every run of whitespace into single spaces and trims', () => {
    expect(collapseWhitespace('  a\n\n b\t\tc  ')).toBe('a b c');
    expect(collapseWhitespace('')).toBe('');
    expect(collapseWhitespace('   ')).toBe('');
  });

  it('leaves already-clean text alone', () => {
    expect(collapseWhitespace('git status')).toBe('git status');
  });
});

describe('escapeRegExp', () => {
  it('makes a metacharacter-laden string match literally', () => {
    const term = 'c++ (x?)';
    expect(new RegExp(escapeRegExp(term)).test(term)).toBe(true);
  });

  it('does not throw on a term that would be invalid regex source', () => {
    expect(() => new RegExp(escapeRegExp('a[b'))).not.toThrow();
  });
});

// The reason this helper exists rather than a `\W` boundary inline: `\W` is ASCII-only without the `u`
// flag, so every accented letter reads as a boundary. With Czech category names that produced silent
// mismatches — and the category a memory lands in decides whether it is ever recalled.
describe('containsWholeToken', () => {
  it('matches a standalone token', () => {
    expect(containsWholeToken('kategorie je práce dnes', 'práce')).toBe(true);
    expect(containsWholeToken('práce', 'práce')).toBe(true);
  });

  it('does not match inside a longer word, accents included', () => {
    expect(containsWholeToken('autobus', 'auto')).toBe(false);
    // Both of these matched before: the accented letter counted as a word boundary.
    expect(containsWholeToken('mépráce', 'práce')).toBe(false);
    expect(containsWholeToken('néauto', 'auto')).toBe(false);
  });

  it('treats punctuation and quotes as boundaries', () => {
    expect(containsWholeToken('"práce"', 'práce')).toBe(true);
    expect(containsWholeToken('práce, elowen', 'práce')).toBe(true);
  });

  it('never matches an empty needle', () => {
    expect(containsWholeToken('cokoli', '')).toBe(false);
  });

  it('takes the needle literally', () => {
    expect(containsWholeToken('a+b je tady', 'a+b')).toBe(true);
    expect(containsWholeToken('aab', 'a+')).toBe(false);
  });
});
