import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { clipTail } = await import(resolve(repoRoot, 'plugins/subagent/lib/results.mjs')) as {
  clipTail(text: string, limit: number): string;
};

/** The shape of every delegated report: the finding is the LAST line, which is precisely what a head-first
 *  truncation threw away when a 12 894-char report reached its parent cut short. */
const OPENING = 'OPENING: scope, method and the files I read.';
const CONCLUSION = 'CONCLUSION: the retry backoff is the root cause — ship the fix.';
const report = (filler: number): string => `${OPENING}\n${'x'.repeat(filler)}\n${CONCLUSION}`;

/** The note, and the body it precedes. */
const NOTE = /^\[truncated: first (\d+) chars dropped, end kept — read it in full with DelegateRead\]\n/;
const bodyOf = (out: string): string => out.replace(NOTE, '');

describe('clipTail — an over-long delegated result keeps its end', () => {
  it('leaves a result that fits the limit completely untouched', () => {
    const text = report(100);
    expect(clipTail(text, 10_000)).toBe(text);
    expect(clipTail(text, text.length)).toBe(text); // exactly at the limit is not truncation
    expect(clipTail('', 10)).toBe('');
  });

  it('keeps the conclusion at the end and drops the beginning instead', () => {
    const text = report(5_000);
    const out = clipTail(text, 1_000);
    // The behaviour being bought: the END of the original survives verbatim.
    expect(out.endsWith(CONCLUSION)).toBe(true);
    expect(text.endsWith(bodyOf(out))).toBe(true);
    // And the head is what paid for it.
    expect(out).not.toContain(OPENING);
    expect(bodyOf(out).length).toBeGreaterThan(800);
  });

  it('states how much it dropped and names DelegateRead as the route to the whole text', () => {
    const text = report(5_000);
    const out = clipTail(text, 1_000);
    const match = NOTE.exec(out);
    expect(match).not.toBeNull();
    // The count is not decoration: dropped + kept has to account for the entire original.
    expect(Number(match![1]) + bodyOf(out).length).toBe(text.length);
  });

  it('never exceeds the limit it was given, so an outer bound has no tail left to shave off', () => {
    for (const limit of [100_000, 8_000, 1_000, 120]) {
      expect(clipTail(report(5_000), limit).length).toBeLessThanOrEqual(limit);
    }
  });

  it('still says it truncated when the limit is too small to hold both the note and any text', () => {
    // Degenerate, but the note is the part that must never be dropped: a parent handed a fragment with no
    // marker cannot tell it is reading one.
    const out = clipTail(report(5_000), 20);
    expect(bodyOf(out)).toBe('');
    expect(out).toMatch(NOTE);
  });
});
