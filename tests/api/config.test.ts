import { describe, it, expect } from 'vitest';
import { makeTestApp } from '../helpers/testApp.js';
import { openDb } from '../../src/store/db.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { brainLimitsPatchSchema, runtimeLimitsPatchSchema, memoryRetentionPatchSchema } from '../../src/api/schemas/config.js';

const put = (token: string, body: unknown) => ({
  method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// review-api-store-sol, finding 7: the old `await c.req.json() as ConfigPatch` cast let a malformed
// value through unvalidated. A Zod schema at the boundary now rejects the hostile shapes with a 400
// instead of persisting them (where e.g. a non-string modelNotes value later crashed modelsBlock()).
describe('PUT /config validates the patch at the trust boundary', () => {
  it('rejects a non-string modelNotes value with a 400', async () => {
    const { app, token } = await makeTestApp({});
    const res = await app.request('/config', put(token, { modelNotes: { sonnet: 7 } }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('modelNotes');
  });

  // A key the schema does not declare is STRIPPED by Zod, not rejected — the request answers 200 and
  // the value silently never reaches the config. That is how the web-push contact stayed empty after a
  // successful-looking save, so this asserts the round trip, not the status code.
  it('persists webPushContact through the patch', async () => {
    const { app, token } = await makeTestApp({});
    const res = await app.request('/config', put(token, { webPushContact: 'https://build.example.com' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { webPushContact?: string };
    expect(body.webPushContact).toBe('https://build.example.com');
  });

  it('rejects a non-string allowedExecs element with a 400', async () => {
    const { app, token } = await makeTestApp({});
    const res = await app.request('/config', put(token, { allowedExecs: ['sonnet', 42] }));
    expect(res.status).toBe(400);
  });

  it('rejects a malformed customModels entry with a 400', async () => {
    const { app, token } = await makeTestApp({});
    const res = await app.request('/config', put(token, { customModels: [{ label: 'ok', exec: 7 }] }));
    expect(res.status).toBe(400);
  });

  it('rejects a non-string plugins.enabled element with a 400', async () => {
    const { app, token } = await makeTestApp({});
    const res = await app.request('/config', put(token, { plugins: { enabled: ['files', null] } }));
    expect(res.status).toBe(400);
  });

  it('rejects a non-string autopilot field with a 400', async () => {
    const { app, token } = await makeTestApp({});
    const res = await app.request('/config', put(token, { autopilot: { model: 123 } }));
    expect(res.status).toBe(400);
  });

  it('still accepts a well-formed patch (no regression)', async () => {
    const { app, token } = await makeTestApp({});
    const res = await app.request('/config', put(token, {
      allowedExecs: ['sonnet'], modelNotes: { sonnet: 'good at code' },
      customModels: [{ label: 'Mine', exec: 'my/model' }], plugins: { enabled: ['files'] },
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { allowedExecs: string[]; modelNotes: Record<string, string> };
    expect(body.allowedExecs).toEqual(['sonnet']);
    expect(body.modelNotes.sonnet).toBe('good at code');
  });
});

// A field present in a store's default shape but missing from its patch schema is stripped by Zod
// before ConfigStore.update ever sees it: the route answers 200, clampBrainLimits falls through to the
// old stored value, and the save silently does nothing (this is exactly how memoryLiveRecallPasses/
// Count/Chars went missing from brainLimitsPatchSchema). ConfigStore's own default shape — not a
// hand-maintained list — is the source of truth, so adding a knob to the store without adding it here
// fails this test instead of shipping a silently no-op setting.
describe('patch schemas accept exactly the store defaults\u2019 keys', () => {
  it('brainLimitsPatchSchema matches ConfigStore\u2019s brain.limits shape', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    expect(Object.keys(brainLimitsPatchSchema.shape).filter((key) => key !== 'memoryLiveRecallChars').sort())
      .toEqual(Object.keys(cs.get().brain.limits).sort());
  });

  it('migrates a legacy live-recall patch from an already-open client', async () => {
    const { app, token } = await makeTestApp({});
    const res = await app.request('/config', put(token, {
      brain: { limits: { memoryLiveRecallPasses: 10, memoryLiveRecallCount: 10, memoryLiveRecallChars: 20_000 } },
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as { brain: { limits: Record<string, number> } };
    expect(body.brain.limits.memoryLiveRecallCount).toBe(2);
    expect(body.brain.limits.memoryLiveRecallBytes).toBe(20_000);
    expect(body.brain.limits).not.toHaveProperty('memoryLiveRecallChars');
  });

  it('runtimeLimitsPatchSchema matches ConfigStore\u2019s runtime.limits shape', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    expect(Object.keys(runtimeLimitsPatchSchema.shape).sort()).toEqual(Object.keys(cs.get().runtime.limits).sort());
  });

  it('memoryRetentionPatchSchema matches ConfigStore\u2019s memoryRetention shape', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    expect(Object.keys(memoryRetentionPatchSchema.shape).sort()).toEqual(Object.keys(cs.get().runtime.memoryRetention).sort());
  });
});
