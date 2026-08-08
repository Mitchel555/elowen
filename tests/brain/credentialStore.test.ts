import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Credential, OAuthCredential } from '@earendil-works/pi-ai';
import { FileCredentialStore } from '../../src/brain/credentialStore.js';

// All token values in this file are invented — no real credential ever belongs in a fixture.
const oauth = (label: string, expires: number): OAuthCredential => ({
  type: 'oauth', access: `fake-access-${label}`, refresh: `fake-refresh-${label}`, expires,
});

let dir: string;
let authPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elowen-credstore-'));
  authPath = join(dir, 'auth.json');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const writeAuthFile = (data: Record<string, Credential>): void => {
  writeFileSync(authPath, JSON.stringify(data, null, 2));
};

describe('FileCredentialStore', () => {
  // THE regression for "delegations 401 after a re-login until the daemon restarts": a process that
  // built its store before the re-login must serve the NEW credential on its next read, unprompted.
  it('read() reflects a credential another process wrote after this store was created', async () => {
    writeAuthFile({ 'openai-codex': oauth('old', Date.now() + 3_600_000) });
    const store = new FileCredentialStore(authPath);
    expect(await store.read('openai-codex')).toMatchObject({ access: 'fake-access-old' });
    // Simulate a re-login performed by ANOTHER process (the daemon), rewriting the shared file.
    writeAuthFile({ 'openai-codex': oauth('new', Date.now() + 7_200_000) });
    expect(await store.read('openai-codex')).toMatchObject({ access: 'fake-access-new', refresh: 'fake-refresh-new' });
  });

  it('read() resolves undefined for a missing provider and for a missing file', async () => {
    const store = new FileCredentialStore(authPath);
    expect(await store.read('anthropic')).toBeUndefined();
    writeAuthFile({ anthropic: oauth('a', 1) });
    expect(await store.read('github-copilot')).toBeUndefined();
  });

  it('list() reflects the file as it is now, without exposing secrets', async () => {
    const store = new FileCredentialStore(authPath);
    expect(await store.list()).toEqual([]);
    writeAuthFile({ anthropic: oauth('a', 1), custom: { type: 'api_key', key: 'fake-key' } });
    const listed = await store.list();
    expect(listed).toEqual([
      { providerId: 'anthropic', type: 'oauth' },
      { providerId: 'custom', type: 'api_key' },
    ]);
  });

  // pi's double-checked refresh depends on this: the mutator must see the on-disk state, so a token
  // some other process already rotated makes it return undefined instead of re-refreshing.
  it('modify() hands the mutator the current on-disk credential and resolves with it on undefined', async () => {
    const store = new FileCredentialStore(authPath);
    writeAuthFile({ 'openai-codex': oauth('rotated-elsewhere', Date.now() + 3_600_000) });
    let seen: Credential | undefined;
    const result = await store.modify('openai-codex', async (current) => { seen = current; return undefined; });
    expect(seen).toMatchObject({ access: 'fake-access-rotated-elsewhere' });
    expect(result).toMatchObject({ access: 'fake-access-rotated-elsewhere' });
    // Unchanged on disk: undefined means "leave it".
    expect(JSON.parse(readFileSync(authPath, 'utf-8'))['openai-codex'].access).toBe('fake-access-rotated-elsewhere');
  });

  it('modify() persists the returned credential with owner-only file permissions', async () => {
    const store = new FileCredentialStore(authPath);
    const cred = oauth('login', Date.now() + 3_600_000);
    await store.modify('anthropic', async () => cred);
    expect(await store.read('anthropic')).toEqual(cred);
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
  });

  it('delete() removes only the named provider', async () => {
    writeAuthFile({ anthropic: oauth('a', 1), 'openai-codex': oauth('b', 2) });
    const store = new FileCredentialStore(authPath);
    await store.delete('anthropic');
    expect(await store.read('anthropic')).toBeUndefined();
    expect(await store.read('openai-codex')).toMatchObject({ access: 'fake-access-b' });
  });

  // Two store instances = two processes (daemon + runner). Every increment must land: a lost update
  // here would be a lost rotated refresh token in production, which bricks the account until re-login.
  it('concurrent modify() calls from two instances never lose an update', async () => {
    writeAuthFile({ p: oauth('base', 1_000) });
    const a = new FileCredentialStore(authPath);
    const b = new FileCredentialStore(authPath);
    const bump = (store: FileCredentialStore) => store.modify('p', async (current) => {
      if (current?.type !== 'oauth') throw new Error('expected the oauth credential');
      // Hold the credential across a tick so an unserialized competitor would interleave and clobber.
      await new Promise((r) => setTimeout(r, 2));
      return { ...current, expires: current.expires + 1 };
    });
    await Promise.all([...Array.from({ length: 5 }, () => bump(a)), ...Array.from({ length: 5 }, () => bump(b))]);
    expect((await a.read('p') as OAuthCredential).expires).toBe(1_010);
  });

  it('a lock left behind by a crashed process is taken over instead of blocking forever', async () => {
    writeAuthFile({ p: oauth('x', 1) });
    const lockPath = `${authPath}.lock`;
    mkdirSync(lockPath);
    // Age the abandoned lock past the stale window; a live holder's keepalive would keep it fresh.
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    const store = new FileCredentialStore(authPath);
    const cred = oauth('recovered', 2);
    await expect(store.modify('p', async () => cred)).resolves.toEqual(cred);
  });

  it('a read that catches the file torn serves the last good parse instead of failing the request', async () => {
    writeAuthFile({ p: oauth('good', 1) });
    const store = new FileCredentialStore(authPath);
    expect(await store.read('p')).toMatchObject({ access: 'fake-access-good' });
    // A writer without atomic rename (pi's AuthStorage writes in place) can expose a torn file briefly.
    writeFileSync(authPath, '{ "p": { "type": "oau');
    expect(await store.read('p')).toMatchObject({ access: 'fake-access-good' });
    // Once the writer finishes, reads follow the file again.
    writeAuthFile({ p: oauth('after', 2) });
    expect(await store.read('p')).toMatchObject({ access: 'fake-access-after' });
  });
});
