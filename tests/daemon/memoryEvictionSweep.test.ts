import { beforeEach, describe, expect, it } from 'vitest';
import { runMemoryEvictionSweep } from '../../src/daemon/bootstrap.js';
import { DEFAULT_MEMORY_RETENTION, type MemoryRetentionConfig } from '../../src/brain/memoryVitality.js';
import { MemoryStore } from '../../src/store/memoryStore.js';
import { openDb } from '../../src/store/db.js';

const NOW = Date.UTC(2026, 7, 3, 18, 0, 0);

function retention(overrides: Partial<MemoryRetentionConfig> = {}): MemoryRetentionConfig {
  return {
    ...DEFAULT_MEMORY_RETENTION,
    ...overrides,
    halfLifeByImportance: {
      ...DEFAULT_MEMORY_RETENTION.halfLifeByImportance,
      ...overrides.halfLifeByImportance,
    },
  };
}

function timestampDaysAgo(days: number): string {
  return new Date(NOW - days * 86_400_000).toISOString();
}

describe('runMemoryEvictionSweep', () => {
  let store: MemoryStore;
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    db = openDb(':memory:');
    store = new MemoryStore(db);
  });

  function addMemory(importance: number, ageDays: number): number {
    const memory = store.add(1, { body: `memory ${importance}-${ageDays}`, importance }, 'agent', 'test');
    db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(timestampDaysAgo(ageDays), memory.id);
    return memory.id;
  }

  function sweep(config = retention()): number {
    return runMemoryEvictionSweep({
      memories: store,
      users: { list: () => [{ id: 1 }] },
      retention: () => config,
      now: () => NOW,
    });
  }

  it('soft-deletes an old low-vitality non-pinned memory and audits the reason', () => {
    const memoryId = addMemory(1, 100);

    expect(sweep()).toBe(1);
    expect(store.get(1, memoryId)?.status).toBe('deleted');
    expect(store.listEvents(1)[0]).toMatchObject({
      memory_id: memoryId,
      action: 'delete',
      actor: 'daemon',
      reason: expect.stringMatching(/^auto-evict: vitality \d+\.\d{2} < 10$/),
    });
  });

  it('skips pinned memories and memories still inside the grace period', () => {
    const pinnedId = addMemory(5, 100);
    const graceId = addMemory(1, 7);

    expect(sweep(retention({ vitalityFloor: 90 }))).toBe(0);
    expect(store.get(1, pinnedId)?.status).toBe('active');
    expect(store.get(1, graceId)?.status).toBe('active');
  });

  it('does nothing when retention is disabled', () => {
    const memoryId = addMemory(1, 100);

    expect(sweep(retention({ enabled: false }))).toBe(0);
    expect(store.get(1, memoryId)?.status).toBe('active');
    expect(store.listEvents(1).map((event) => event.action)).toEqual(['add']);
  });
});
