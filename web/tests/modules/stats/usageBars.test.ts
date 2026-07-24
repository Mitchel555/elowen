import { describe, it, expect } from 'vitest';
import { buildUsageSummary } from '../../../modules/stats/usageBars';
import type { ModelUsage } from '../../../lib/types';

const mk = (exec: string, total: number, costUsd: number | null): ModelUsage => ({
  exec,
  usage: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total, costUsd },
});

describe('buildUsageSummary', () => {
  it('returns an empty summary for undefined or []', () => {
    for (const data of [undefined, [] as ModelUsage[]]) {
      const s = buildUsageSummary(data);
      expect(s.rows).toEqual([]);
      expect(s.hasAnyUsage).toBe(false);
      expect(s.totalTokens).toBe(0);
      expect(s.totalCost).toBeNull();
      expect(s.totalCostLabel).toBe('—');
      expect(s.totalCacheTokens).toBe(0);
      expect(s.modelsUsed).toBe(0);
    }
  });

  it('sums cache tokens (read + write) across models', () => {
    const s = buildUsageSummary([
      { exec: 'a', usage: { input: 1, output: 1, cacheRead: 10, cacheWrite: 5, total: 17, costUsd: null } },
      { exec: 'b', usage: { input: 1, output: 1, cacheRead: 20, cacheWrite: 0, total: 22, costUsd: null } },
    ]);
    expect(s.totalCacheTokens).toBe(35);
    expect(s.totalCacheLabel).toBe('35');
  });

  it('labels per-row speed and a duration-weighted average, dashing unmeasured rows', () => {
    const s = buildUsageSummary([
      // 100 out at 100 tok/s (1 s) + 50 out at 10 tok/s (5 s) → avg 150/6 = 25 tok/s; 'c' unmeasured.
      { exec: 'a', usage: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0, total: 100, costUsd: null, outputTps: 100 } },
      { exec: 'b', usage: { input: 0, output: 50, cacheRead: 0, cacheWrite: 0, total: 50, costUsd: null, outputTps: 10 } },
      { exec: 'c', usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, total: 10, costUsd: null } },
    ]);
    expect(s.rows.find((r) => r.exec === 'a')!.speedLabel).toBe('100 tok/s');
    expect(s.rows.find((r) => r.exec === 'c')!.speedLabel).toBe('—');
    expect(s.avgSpeedLabel).toBe('25 tok/s');
  });

  it('dashes the average speed when nothing measured one', () => {
    expect(buildUsageSummary([mk('a', 100, 1)]).avgSpeedLabel).toBe('—');
  });

  it('computes the cache hit rate per row, null when nothing was read', () => {
    const s = buildUsageSummary([
      { exec: 'a', usage: { input: 25, output: 0, cacheRead: 75, cacheWrite: 0, total: 100, costUsd: null } },
      { exec: 'b', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costUsd: 0.5 } },
    ]);
    expect(s.rows.find((r) => r.exec === 'a')!.cacheHitPct).toBeCloseTo(75);
    expect(s.rows.find((r) => r.exec === 'b')!.cacheHitPct).toBeNull();
  });

  it('sorts rows by tokens desc and max-normalizes the bar widths', () => {
    const s = buildUsageSummary([mk('a/small', 1000, 1), mk('b/big', 4000, 2)]);
    expect(s.rows.map((r) => r.exec)).toEqual(['b/big', 'a/small']);
    expect(s.rows[0].pct).toBe(100);          // largest = full bar
    expect(s.rows[1].pct).toBe(25);           // 1000 / 4000
    expect(s.modelsUsed).toBe(2);
    expect(s.totalTokens).toBe(5000);
    expect(s.hasAnyUsage).toBe(true);
  });

  it('handles a null cost (claude/codex) — dash for the row, summed only over real costs', () => {
    const s = buildUsageSummary([mk('claude/sonnet', 2000, null), mk('opencode/x', 1000, 3)]);
    const claude = s.rows.find((r) => r.exec === 'claude/sonnet')!;
    expect(claude.costLabel).toBe('—');
    expect(s.totalCost).toBe(3);              // only opencode contributes
    expect(s.totalCostLabel).toBe('$3.0000');
  });

  it('reports a null total cost when no executor records cost', () => {
    const s = buildUsageSummary([mk('claude/sonnet', 2000, null), mk('codex/o', 1000, null)]);
    expect(s.totalCost).toBeNull();
    expect(s.totalCostLabel).toBe('—');
    expect(s.totalTokens).toBe(3000);
    expect(s.hasAnyUsage).toBe(true);
  });

  it('keeps a provider-reported cost-only row visible when token detail is unavailable', () => {
    const s = buildUsageSummary([mk('provider/cost-only', 0, 0.75)]);
    expect(s.totalTokens).toBe(0);
    expect(s.totalCost).toBe(0.75);
    expect(s.hasAnyUsage).toBe(true);
    expect(s.rows).toHaveLength(1);
  });

  it('formats token figures compactly', () => {
    const s = buildUsageSummary([mk('a/x', 1_200_000, null)]);
    expect(s.rows[0].tokensLabel).toBe('1.2M');
    expect(s.totalTokensLabel).toBe('1.2M');
  });
});
