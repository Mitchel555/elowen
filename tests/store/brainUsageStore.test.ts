import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb, type Db } from '../../src/store/db.js';
import { BrainUsageStore } from '../../src/store/brainUsageStore.js';

// The /usage/by-model and /usage/by-day views each run two full scans of brain_messages behind a
// UNION ALL — the dashboard polls them every 30 s/60 s. The TTL cache (with its sentinel freshness
// probe) is what keeps those polls from re-paying the scan for an unchanged answer.
describe('BrainUsageStore view cache', () => {
  let db: Db;
  let now: number;
  let store: BrainUsageStore;

  const addSession = (id: string, userId = 1, model = 'm'): void => {
    db.prepare("INSERT INTO brain_sessions (id, user_id, model) VALUES (?, ?, ?)").run(id, userId, model);
  };
  const addUsage = (sessionId: string, id: string, totalTokens: number, tsMs: number): void => {
    db.prepare('INSERT INTO brain_messages (id, session_id, parent_id, role, content) VALUES (?, ?, NULL, ?, ?)')
      .run(id, sessionId, 'assistant', JSON.stringify({
        role: 'assistant', model: 'm', timestamp: tsMs,
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens },
      }));
  };
  /** Count the expensive aggregate passes (every USAGE_ROWS CTE scan), not the cheap sentinel probes. */
  const scans = (spy: ReturnType<typeof vi.spyOn<Db, 'prepare'>>): number =>
    spy.mock.calls.filter((call) => call[0].includes('usage_rows')).length;

  beforeEach(() => {
    db = openDb(':memory:');
    now = Date.parse('2026-07-29T12:00:00Z');
    store = new BrainUsageStore(db, () => now);
    addSession('s1');
    addUsage('s1', 'a', 100, now - 1000);
  });

  it('runs ONE table scan for repeated reads within the TTL, and re-scans once the TTL lapses', () => {
    const spy = vi.spyOn(db, 'prepare');
    expect(store.usageByModel(1).map((r) => r.usage.total)).toEqual([100]);
    store.usageByModel(1);
    store.usageByModel(1);
    expect(scans(spy)).toBe(1);

    now += 61_000;
    store.usageByModel(1);
    expect(scans(spy)).toBe(2);
  });

  it('sees a newly appended message immediately, without waiting for the TTL', () => {
    expect(store.usageByModel(1).map((r) => r.usage.total)).toEqual([100]);
    addUsage('s1', 'b', 50, now - 500); // the same instant — the TTL alone would keep the stale answer
    expect(store.usageByModel(1).map((r) => r.usage.total)).toEqual([150]);
  });

  it('sees a task_usage snapshot immediately (the session leaves the brain aggregate mid-TTL)', () => {
    addSession('brain-task-9');
    addUsage('brain-task-9', 't1', 999, now - 500);
    expect(store.usageByModel(1).map((r) => r.usage.total)).toEqual([1099]);
    // The worker settles and BrainWorkerService records its snapshot — from that moment the session's
    // spend is merged from task_usage instead, so the brain view must drop it at once, not in 60 s.
    db.prepare("INSERT INTO task_usage (task_id, project_id, exec, total) VALUES ('9', 1, 'elowen:m', 999)").run();
    expect(store.usageByModel(1).map((r) => r.usage.total)).toEqual([100]);
  });

  it('shares one cache entry for two ISO spellings of the same window instant', () => {
    const spy = vi.spyOn(db, 'prepare');
    store.usageByModel(1, { fromIso: '2026-07-01T00:00:00.000Z' });
    store.usageByModel(1, { fromIso: '2026-07-01T00:00:00Z' });
    expect(scans(spy)).toBe(1);
  });

  it('caches usageByDay the same way', () => {
    const spy = vi.spyOn(db, 'prepare');
    store.usageByDay(1, 7);
    store.usageByDay(1, 7);
    expect(scans(spy)).toBe(1);
    addUsage('s1', 'b', 50, now - 500);
    store.usageByDay(1, 7);
    expect(scans(spy)).toBe(2);
  });
});
