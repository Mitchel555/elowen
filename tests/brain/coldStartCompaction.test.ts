import { describe, expect, it } from 'vitest';
import {
  assessColdCompaction,
  coldCompactionGateMs,
  coldCompactionWorthwhile,
  lastActivityMs,
} from '../../src/brain/session/coldStartCompaction.js';

/** The factory's summary allowance — the expected summary OUTPUT size the break-even charges for. */
const SUMMARY = 8_000;

describe('coldCompactionWorthwhile', () => {
  // Anthropic ratios: cacheWrite 1.25×, output 5× input. Break-even: C ≥ 5·F + 20·S.
  // With S = 8k the summary output alone costs 160k tokens' worth of the 0.25·C margin.

  it('accepts a context past the real break-even (500k → 50k floor saves money)', () => {
    // 5·50k + 20·8k = 410k; at 500k the compaction nets ≈ $0.11 on Opus for one cold return.
    expect(coldCompactionWorthwhile(500_000, 50_000, SUMMARY)).toBe(true);
  });

  it('refuses a four-fold reduction that still loses money (400k → 100k floor)', () => {
    // The retired 2×-floor rule accepted this; per one cold return it LOSES $0.125 + the summary output.
    expect(coldCompactionWorthwhile(400_000, 100_000, SUMMARY)).toBe(false);
  });

  it('refuses the five-fold point once the summary output is charged (200k → 40k floor)', () => {
    // 5F exactly covers the cache-write side; the summary output alone tips it into a loss.
    expect(coldCompactionWorthwhile(200_000, 40_000, SUMMARY)).toBe(false);
    // With a free summary the same point is exact break-even — allowed, not demanded.
    expect(coldCompactionWorthwhile(200_000, 40_000, 0)).toBe(true);
    expect(coldCompactionWorthwhile(199_999, 40_000, 0)).toBe(false);
  });

  it('sits exactly at C = 5·F + 20·S', () => {
    expect(coldCompactionWorthwhile(410_000, 50_000, SUMMARY)).toBe(true);
    expect(coldCompactionWorthwhile(409_999, 50_000, SUMMARY)).toBe(false);
  });
});

describe('coldCompactionGateMs', () => {
  it('derives the gate from the TTL of the LAST provider request plus the 1-minute buffer', () => {
    expect(coldCompactionGateMs(5 * 60_000)).toBe(6 * 60_000);
    expect(coldCompactionGateMs(60 * 60_000)).toBe(61 * 60_000);
  });

  it('falls back to the LONGEST TTL when the last request predates this process', () => {
    // A retention switch across a restart (long → short) must not open the gate over a still-warm
    // hour-long cache: with no stamp, the gate assumes the longest TTL pi-ai ever uses.
    expect(coldCompactionGateMs(undefined)).toBe(61 * 60_000);
  });
});

describe('assessColdCompaction', () => {
  const inputs = (over: Partial<Parameters<typeof assessColdCompaction>[0]> = {}) => ({
    proactive: () => true,
    breakerBlocks: () => false,
    contextTokens: () => 500_000,
    floorTokens: () => 40_000,
    summaryOutputTokens: () => SUMMARY,
    ...over,
  });

  it('is eligible with the estimates attached when every gate passes', () => {
    expect(assessColdCompaction(inputs())).toEqual({ eligible: true, contextTokens: 500_000, floorTokens: 40_000 });
  });

  it('respects the user’s auto-compact toggle — a cold-start compaction is still an automatic one', () => {
    expect(assessColdCompaction(inputs({ proactive: () => false })))
      .toEqual({ eligible: false, reason: 'auto-compact-off' });
  });

  it('never sneaks past a circuit breaker that refuses automatic compaction', () => {
    expect(assessColdCompaction(inputs({ breakerBlocks: () => true })))
      .toEqual({ eligible: false, reason: 'breaker' });
  });

  it('refuses a conversation below the break-even', () => {
    expect(assessColdCompaction(inputs({ contextTokens: () => 200_000 })))
      .toEqual({ eligible: false, reason: 'not-worthwhile' });
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

  it('returns 0 for a session with no recorded activity (never cold-compacted)', () => {
    expect(lastActivityMs(undefined, undefined)).toBe(0);
    expect(lastActivityMs('not-a-date', undefined)).toBe(0);
  });
});
