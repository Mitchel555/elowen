import { describe, it, expect } from 'vitest';
import { makeTestApp } from '../helpers/testApp.js';

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
