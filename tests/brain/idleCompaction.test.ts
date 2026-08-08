import { describe, expect, it } from 'vitest';
import {
  IDLE_COMPACTION_MIN_SAVINGS_TOKENS,
  IdleCompactionLatch,
  assessIdleCompaction,
  idleCompactionWorthwhile,
  lastActivityMs,
} from '../../src/brain/session/idleCompaction.js';

describe('idleCompactionWorthwhile', () => {
  it('accepts a context that removes the savings floor AND dwarfs its own post-compaction floor', () => {
    // 100k context over a 30k floor: 70k removable ≥ 30k, and 100k ≥ 2×30k.
    expect(idleCompactionWorthwhile(100_000, 30_000)).toBe(true);
  });

  it('refuses when the removable part stays under the savings floor', () => {
    // 10k floor, 39k context: 29k removable — one token short of the 30k floor. The summarization
    // would bill the whole context at full input price to save cents.
    expect(idleCompactionWorthwhile(39_999, 10_000)).toBe(false);
    expect(idleCompactionWorthwhile(10_000 + IDLE_COMPACTION_MIN_SAVINGS_TOKENS, 10_000)).toBe(true);
  });

  it('refuses a context dominated by its own floor even when the removable part clears the savings bar', () => {
    // 100k context over a 55k floor: 45k removable (≥ 30k) but the context is not twice its floor —
    // the request bills 100k to shrink by less than half.
    expect(idleCompactionWorthwhile(100_000, 55_000)).toBe(false);
    expect(idleCompactionWorthwhile(110_000, 55_000)).toBe(true);
  });
});

describe('assessIdleCompaction', () => {
  const inputs = (over: Partial<Parameters<typeof assessIdleCompaction>[0]> = {}) => ({
    proactive: () => true,
    breakerBlocks: () => false,
    contextTokens: () => 200_000,
    floorTokens: () => 40_000,
    ...over,
  });

  it('is eligible with the estimates attached when every gate passes', () => {
    expect(assessIdleCompaction(inputs())).toEqual({ eligible: true, contextTokens: 200_000, floorTokens: 40_000 });
  });

  it('respects the user’s auto-compact toggle — an idle compaction is still an automatic one', () => {
    expect(assessIdleCompaction(inputs({ proactive: () => false })))
      .toEqual({ eligible: false, reason: 'auto-compact-off' });
  });

  it('never sneaks past a circuit breaker that refuses automatic compaction', () => {
    expect(assessIdleCompaction(inputs({ breakerBlocks: () => true })))
      .toEqual({ eligible: false, reason: 'breaker' });
  });

  it('refuses a conversation with too little to squeeze', () => {
    expect(assessIdleCompaction(inputs({ contextTokens: () => 50_000 })))
      .toEqual({ eligible: false, reason: 'too-small' });
  });
});

describe('lastActivityMs', () => {
  const now = Date.UTC(2026, 7, 8, 12, 0, 0);
  const sqliteTs = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

  it('takes the newer of the stored message and the explicit interaction', () => {
    const messageAt = now - 90 * 60_000;
    expect(lastActivityMs(sqliteTs(messageAt), undefined)).toBe(messageAt);
    expect(lastActivityMs(sqliteTs(messageAt), now - 60_000)).toBe(now - 60_000);
  });

  it('returns 0 for a session with no recorded activity (never idle-compacted)', () => {
    expect(lastActivityMs(undefined, undefined)).toBe(0);
    expect(lastActivityMs('not-a-date', undefined)).toBe(0);
  });
});

describe('IdleCompactionLatch', () => {
  it('latches one decision per idle epoch and re-arms only on new activity', () => {
    const latch = new IdleCompactionLatch();
    expect(latch.decidedAlready('s1', 1000)).toBe(false);
    latch.markDecided('s1', 1000);
    // Same epoch: the gate stays open (a compaction does not advance lastMessageAt) but the latch holds.
    expect(latch.decidedAlready('s1', 1000)).toBe(true);
    // A new turn moves the stamp — the latch releases.
    expect(latch.decidedAlready('s1', 2000)).toBe(false);
  });

  it('forgets sessions no longer live so the map cannot grow unbounded', () => {
    const latch = new IdleCompactionLatch();
    latch.markDecided('gone', 1000);
    latch.markDecided('kept', 1000);
    latch.sweep(new Set(['kept']));
    expect(latch.decidedAlready('kept', 1000)).toBe(true);
    // The dead entry was dropped: a session id reused later starts unlatched.
    expect(latch.decidedAlready('gone', 1000)).toBe(false);
  });
});
