// ConnectorClient.download must reject an oversized Teams attachment WITHOUT buffering it into memory
// first — a declared Content-Length over the cap should short-circuit before any body byte is read, and
// even without a (trustworthy) Content-Length the body must be streamed with a hard running-byte abort
// rather than pulled whole via `res.arrayBuffer()`.
import { describe, it, expect, afterEach } from 'vitest';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const log = { info() {}, warn() {}, error() {} };

async function loadConnector() {
  const { ConnectorClient } = await import(join(repoRoot, 'plugins/msteams/lib/connector.mjs')) as {
    ConnectorClient: new (cfg: Record<string, unknown>, logger: typeof log) => {
      download: (url: string, maxBytes: number) => Promise<Buffer>;
      token: () => Promise<string>;
    };
  };
  const client = new ConnectorClient({ appId: 'a', appPassword: 'b', tenantId: 't' }, log);
  Object.assign(client, { token: async () => 'tok' });
  return client;
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('ConnectorClient.download size guard', () => {
  it('rejects a declared-oversized attachment without ever reading the body', async () => {
    const client = await loadConnector();
    let arrayBufferCalled = false;
    let cancelCalled = false;
    globalThis.fetch = (async () => ({
      ok: true,
      headers: { get: (h: string) => (h.toLowerCase() === 'content-length' ? '10485760' : null) }, // 10MB
      arrayBuffer: async () => { arrayBufferCalled = true; return new ArrayBuffer(10 * 1024 * 1024); },
      body: { cancel: async () => { cancelCalled = true; } },
    })) as unknown as typeof fetch;

    await expect(client.download('https://x/test.png', 5 * 1024 * 1024)).rejects.toThrow(/exceeds the configured size cap/);
    expect(arrayBufferCalled).toBe(false); // the whole point: no full-body buffering before the check
    expect(cancelCalled).toBe(true);
  });

  it('streams the body and aborts as soon as the running total crosses the cap, without pulling it all', async () => {
    const client = await loadConnector();
    const CHUNK = new Uint8Array(1024 * 1024); // 1MB
    let pulls = 0;
    let cancelled = false;
    const reader = {
      read: async () => {
        pulls++;
        if (pulls > 5) return { done: true, value: undefined };
        return { done: false, value: CHUNK };
      },
      cancel: async () => { cancelled = true; },
      releaseLock: () => {},
    };
    globalThis.fetch = (async () => ({
      ok: true,
      headers: { get: () => null }, // no Content-Length — must fall back to streaming
      arrayBuffer: async () => { throw new Error('arrayBuffer should not be used on the streaming path'); },
      body: { getReader: () => reader },
    })) as unknown as typeof fetch;

    await expect(client.download('https://x/test.png', 2 * 1024 * 1024)).rejects.toThrow(/exceeds the configured size cap/);
    expect(cancelled).toBe(true);
    // Cap is 2MB (2 chunks); the read loop must stop right after crossing it, not after all 5 chunks.
    expect(pulls).toBeLessThanOrEqual(3);
  });

  it('still returns the buffer for an attachment within the cap', async () => {
    const client = await loadConnector();
    const CHUNK = new Uint8Array(10);
    let calls = 0;
    const reader = {
      read: async () => (calls++ === 0 ? { done: false, value: CHUNK } : { done: true, value: undefined }),
      cancel: async () => {},
      releaseLock: () => {},
    };
    globalThis.fetch = (async () => ({
      ok: true,
      headers: { get: () => null },
      body: { getReader: () => reader },
    })) as unknown as typeof fetch;

    const buf = await client.download('https://x/test.png', 1024);
    expect(buf.byteLength).toBe(10);
  });
});
