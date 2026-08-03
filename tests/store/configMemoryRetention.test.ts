import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { DEFAULT_MEMORY_RETENTION } from '../../src/brain/memoryVitality.js';
import { makeTestApp } from '../helpers/testApp.js';

/** The memory-retention block is the runtime group's sibling: same contract as the runtime limits
 *  (defaults, per-field clamp, a partial patch never resetting a sibling), a different domain. Every
 *  default here must equal `DEFAULT_MEMORY_RETENTION` — the single source in brain/memoryVitality.ts —
 *  or the auto-retention sweep would behave differently from what the settings panel shows. */
describe('ConfigStore runtime.memoryRetention', () => {
  it('defaults to DEFAULT_MEMORY_RETENTION on a fresh store', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    expect(cs.get().runtime.memoryRetention).toEqual(DEFAULT_MEMORY_RETENTION);
  });

  it('round-trips a full block through update()', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    const block = {
      enabled: false,
      graceDays: 21,
      vitalityFloor: 25,
      halfLifeByImportance: { 1: 10, 2: 25, 3: 50, 4: 90, 5: 0 },
    };
    cs.update({ runtime: { memoryRetention: block } });
    expect(cs.get().runtime.memoryRetention).toEqual(block);
  });

  it('merges a partial patch per-field without resetting siblings', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ runtime: { memoryRetention: { graceDays: 30 } } });
    expect(cs.get().runtime.memoryRetention.graceDays).toBe(30);
    expect(cs.get().runtime.memoryRetention.vitalityFloor).toBe(DEFAULT_MEMORY_RETENTION.vitalityFloor); // sibling untouched
    expect(cs.get().runtime.memoryRetention.halfLifeByImportance).toEqual(DEFAULT_MEMORY_RETENTION.halfLifeByImportance);
    cs.update({ runtime: { memoryRetention: { halfLifeByImportance: { 2: 90 } } } });
    expect(cs.get().runtime.memoryRetention.halfLifeByImportance[2]).toBe(90);
    expect(cs.get().runtime.memoryRetention.halfLifeByImportance[1]).toBe(DEFAULT_MEMORY_RETENTION.halfLifeByImportance[1]); // key sibling untouched
    expect(cs.get().runtime.memoryRetention.graceDays).toBe(30); // still the earlier patch
  });

  it('clamps a value past either end back into range', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ runtime: { memoryRetention: { graceDays: -5, vitalityFloor: 200, halfLifeByImportance: { 1: -10, 2: 5000 } } } });
    expect(cs.get().runtime.memoryRetention.graceDays).toBe(0);
    expect(cs.get().runtime.memoryRetention.vitalityFloor).toBe(90);
    expect(cs.get().runtime.memoryRetention.halfLifeByImportance[1]).toBe(0);
    expect(cs.get().runtime.memoryRetention.halfLifeByImportance[2]).toBe(90);
    // 0 is the "never" sentinel and must stay reachable on both ends.
    cs.update({ runtime: { memoryRetention: { graceDays: 9999, vitalityFloor: -1, halfLifeByImportance: { 1: 99999, 5: 0 } } } });
    expect(cs.get().runtime.memoryRetention.graceDays).toBe(365);
    expect(cs.get().runtime.memoryRetention.vitalityFloor).toBe(0);
    expect(cs.get().runtime.memoryRetention.halfLifeByImportance[1]).toBe(90);
    expect(cs.get().runtime.memoryRetention.halfLifeByImportance[5]).toBe(0);
  });

  it('ignores a non-finite value, keeping the current one', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ runtime: { memoryRetention: { graceDays: 60 } } });
    cs.update({ runtime: { memoryRetention: { graceDays: Number.NaN } } });
    expect(cs.get().runtime.memoryRetention.graceDays).toBe(60);
  });

  it('fills the block with defaults when a stored row predates it, and survives a malformed one', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)')
      .run(JSON.stringify({ runtime: { limits: { eventRetentionDays: 90 } } }));
    const cs = new ConfigStore(db);
    expect(cs.get().runtime.memoryRetention).toEqual(DEFAULT_MEMORY_RETENTION);

    const db2 = openDb(':memory:');
    db2.prepare('INSERT INTO settings (id, data) VALUES (1, ?)')
      .run(JSON.stringify({ runtime: { memoryRetention: { enabled: 'yes', graceDays: 'x', halfLifeByImportance: { 1: 'a' } } } }));
    const cs2 = new ConfigStore(db2);
    expect(cs2.get().runtime.memoryRetention.enabled).toBe(DEFAULT_MEMORY_RETENTION.enabled);
    expect(cs2.get().runtime.memoryRetention.graceDays).toBe(DEFAULT_MEMORY_RETENTION.graceDays);
    expect(cs2.get().runtime.memoryRetention.halfLifeByImportance).toEqual(DEFAULT_MEMORY_RETENTION.halfLifeByImportance);
  });

  it('leaves the whole retention block alone when the patch touches another section', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ runtime: { memoryRetention: { graceDays: 45 }, toolDeferralEnabled: false } });
    cs.update({ brain: { maxSteps: 30 } });
    expect(cs.get().runtime.memoryRetention.graceDays).toBe(45);
    expect(cs.get().runtime.toolDeferralEnabled).toBe(false);
  });

  it('appears in GET /config and persists through PUT /config', async () => {
    const { app, token } = await makeTestApp({});
    const auth = { authorization: `Bearer ${token}` };
    const get = await app.request('/config', { headers: auth });
    expect(get.status).toBe(200);
    const body = await get.json() as { runtime: { memoryRetention: typeof DEFAULT_MEMORY_RETENTION } };
    expect(body.runtime.memoryRetention).toEqual(DEFAULT_MEMORY_RETENTION);

    const patch = { runtime: { memoryRetention: { enabled: false, graceDays: 7, vitalityFloor: 20, halfLifeByImportance: { 1: 5, 2: 10, 3: 20, 4: 40, 5: 0 } } } };
    const put = await app.request('/config', {
      method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    expect(put.status).toBe(200);
    const updated = await put.json() as { runtime: { memoryRetention: typeof DEFAULT_MEMORY_RETENTION } };
    expect(updated.runtime.memoryRetention).toEqual(patch.runtime.memoryRetention);
  });
});
