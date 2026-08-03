import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MEMORY_RETENTION,
  PIN_IMPORTANCE,
  type VitalityMemory,
  isEvictable,
  vitality,
} from '../../src/brain/memoryVitality.js';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-08-03T04:00:00Z');

function daysAgo(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString();
}

function memory(overrides: Partial<VitalityMemory> = {}): VitalityMemory {
  return {
    importance: 1,
    use_count: 0,
    last_used_at: null,
    created_at: daysAgo(0),
    ...overrides,
  };
}

describe('vitality', () => {
  it('increases with use count', () => {
    const unused = vitality(memory({ created_at: daysAgo(30) }), DEFAULT_MEMORY_RETENTION, NOW);
    const used = vitality(memory({ created_at: daysAgo(30), use_count: 10 }), DEFAULT_MEMORY_RETENTION, NOW);

    expect(used).toBeGreaterThan(unused);
  });

  it('decreases as time since last use increases', () => {
    const recent = vitality(memory({ last_used_at: daysAgo(1) }), DEFAULT_MEMORY_RETENTION, NOW);
    const old = vitality(memory({ last_used_at: daysAgo(120) }), DEFAULT_MEMORY_RETENTION, NOW);

    expect(old).toBeLessThan(recent);
  });

  it('does not decay pinned memories', () => {
    const fresh = vitality(memory({ importance: PIN_IMPORTANCE, use_count: 3 }), DEFAULT_MEMORY_RETENTION, NOW);
    const ancient = vitality(memory({
      importance: PIN_IMPORTANCE,
      use_count: 3,
      created_at: daysAgo(10_000),
    }), DEFAULT_MEMORY_RETENTION, NOW);

    expect(ancient).toBe(fresh);
  });

  it('does not decay a memory with a zero half-life', () => {
    const retention = {
      ...DEFAULT_MEMORY_RETENTION,
      halfLifeByImportance: { ...DEFAULT_MEMORY_RETENTION.halfLifeByImportance, 1: 0 },
    };

    expect(vitality(memory({ created_at: daysAgo(10_000) }), retention, NOW)).toBe(50);
  });

  it('gives a fresh unused memory a high starting score', () => {
    expect(vitality(memory(), DEFAULT_MEMORY_RETENTION, NOW)).toBe(50);
  });

  it('reduces an old low-importance memory to near zero', () => {
    const score = vitality(memory({ created_at: daysAgo(365) }), DEFAULT_MEMORY_RETENTION, NOW);

    expect(score).toBeLessThan(0.1);
  });
});

describe('isEvictable', () => {
  const aggressiveRetention = {
    ...DEFAULT_MEMORY_RETENTION,
    halfLifeByImportance: { ...DEFAULT_MEMORY_RETENTION.halfLifeByImportance, 1: 1 },
  };

  it('requires enabled retention, expiry after grace, a non-pinned memory, and score below the floor', () => {
    const oldMemory = memory({ created_at: daysAgo(20) });

    expect(isEvictable(oldMemory, aggressiveRetention, NOW)).toBe(true);
    expect(isEvictable(memory({ created_at: daysAgo(14) }), aggressiveRetention, NOW)).toBe(false);
    expect(isEvictable(memory({ importance: PIN_IMPORTANCE, created_at: daysAgo(20) }), aggressiveRetention, NOW)).toBe(false);
    expect(isEvictable(oldMemory, { ...aggressiveRetention, enabled: false }, NOW)).toBe(false);
    expect(isEvictable(oldMemory, { ...aggressiveRetention, vitalityFloor: 0 }, NOW)).toBe(false);
  });
});
