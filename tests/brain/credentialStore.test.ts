import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Credential, OAuthCredential } from '@earendil-works/pi-ai';
import { FileCredentialStore } from '../../src/brain/credentialStore.js';

// All token values in this file are invented — no real credential ever belongs in a fixture.
const oauth = (label: string, expires: number): OAuthCredential => ({
  type: 'oauth', access: `fake-access-${label}`, refresh: `fake-refresh-${label}`, expires,
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  // writeFileSync's `mode` is filtered by the umask and does not apply to a pre-existing file at all —
  // the explicit fchmod is what guarantees 0600 regardless of either. A 0644 auth.json left behind by
  // an older build must come out 0600 after the first write, not stay world-readable.
  it('writes auth.json 0600 whatever the umask and whatever the previous file mode', async () => {
    const previousUmask = process.umask(0o000);
    try {
      writeAuthFile({});
      chmodSync(authPath, 0o644);
      const store = new FileCredentialStore(authPath);
      await store.modify('anthropic', async () => oauth('tightened', 1));
      expect(statSync(authPath).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  // The rename must replace a symlink AT the auth path, never write through it — following it would
  // let a planted link redirect the secrets into (over) any other file this user can write.
  it('replaces a symlink at the auth path instead of writing through it', async () => {
    const victim = join(dir, 'victim.json');
    writeFileSync(victim, '{}');
    symlinkSync(victim, authPath);
    const store = new FileCredentialStore(authPath);
    await store.modify('anthropic', async () => oauth('direct', 1));
    expect(lstatSync(authPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(victim, 'utf-8')).toBe('{}');
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
      await wait(2);
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

  // THE reproduced lost-update race: A takes the lock and stalls past the stale window (its keepalive,
  // like a SIGSTOPped process's, never fires); B takes the lock over and writes. A then wakes — and
  // must neither publish its stale view over B's write nor remove B's live lock on its way out. The
  // old unconditional cleanup did both, which let a third writer in beside B (reproduced upstream as
  // increments summing to 10 instead of 111 — in production, a rotated refresh token thrown away).
  it('a holder that stalls past the stale window neither writes nor unlocks after the takeover', async () => {
    writeAuthFile({ p: oauth('base', 1_000) });
    const lockPath = `${authPath}.lock`;
    // keepaliveMs far above the stale window = a holder whose event loop is stalled refreshes nothing.
    const a = new FileCredentialStore(authPath, { staleLockMs: 100, keepaliveMs: 60_000 });
    const b = new FileCredentialStore(authPath, { staleLockMs: 100, keepaliveMs: 60_000, retryDelayMs: 20 });
    const aRun = a.modify('p', async () => { await wait(400); return oauth('from-a', 1); });
    const bRun = (async () => {
      await wait(150); // let A acquire and go stale
      return b.modify('p', async () => { await wait(300); return oauth('from-b', 2); });
    })();
    await expect(aRun).rejects.toThrow('taken over');
    // B is still inside its critical section here — its lock must have survived A's cleanup.
    expect(existsSync(lockPath)).toBe(true);
    await expect(bRun).resolves.toMatchObject({ access: 'fake-access-from-b' });
    expect(await new FileCredentialStore(authPath).read('p')).toMatchObject({ access: 'fake-access-from-b' });
  });

  // A symlink at the lock path used to be an unbreakable, BUSY-SPINNING lock: statSync followed it,
  // rmdir on it failed forever, and the stale branch re-looped above the deadline check — one syscall
  // from any local writer wedged every credential write and pinned the event loop.
  it('refuses a symlink planted at the lock path instead of spinning on it', async () => {
    writeAuthFile({ p: oauth('x', 1) });
    const decoy = join(dir, 'decoy');
    mkdirSync(decoy);
    // Point it at a real directory, so anything that FOLLOWS the link still sees "a directory".
    symlinkSync(decoy, `${authPath}.lock`);
    const store = new FileCredentialStore(authPath, { acquireDeadlineMs: 500, retryDelayMs: 10 });
    await expect(store.modify('p', async () => oauth('nope', 2))).rejects.toThrow('not a lock directory');
  });

  it('gives up with a timeout when a live foreign lock never releases', async () => {
    writeAuthFile({ p: oauth('x', 1) });
    mkdirSync(`${authPath}.lock`); // fresh mtime — never stale within this test
    const store = new FileCredentialStore(authPath, { staleLockMs: 60_000, acquireDeadlineMs: 150, retryDelayMs: 20 });
    await expect(store.modify('p', async () => oauth('nope', 2))).rejects.toThrow('timed out waiting');
  });

  // A read racing pi's in-place writer may catch the file torn. That is the ONE transient failure the
  // read path absorbs — by retrying until the writer has finished, never by serving a stale snapshot.
  it('a read that catches a torn in-place write retries and follows the finished write', async () => {
    writeAuthFile({ p: oauth('good', 1) });
    const store = new FileCredentialStore(authPath);
    expect(await store.read('p')).toMatchObject({ access: 'fake-access-good' });
    writeFileSync(authPath, '{ "p": { "type": "oau'); // a writer without atomic rename, caught mid-write
    const read = store.read('p');
    setTimeout(() => writeAuthFile({ p: oauth('after', 2) }), 20); // the writer finishes while the read retries
    expect(await read).toMatchObject({ access: 'fake-access-after' });
  });

  // Permanent corruption must be a VISIBLE error: the old fallback served the last good parse for any
  // failure whatsoever, which could quietly pin a revoked token forever. And the error must carry
  // nothing of the file — JSON.parse's own message quotes raw content, which here is secrets.
  it('a file that stays unparsable is an error, and the error carries no file content', async () => {
    writeFileSync(authPath, '{ "p": { "type": "oauth", "access": "fake-leaked-secret');
    const store = new FileCredentialStore(authPath);
    const failure = await store.read('p').then(() => undefined, (e: unknown) => e as Error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain('does not parse as JSON');
    expect(`${failure?.message}\n${failure?.stack ?? ''}`).not.toContain('fake-leaked-secret');
  });

  it('rejects valid JSON that is not a credential map instead of casting it blindly', async () => {
    writeFileSync(authPath, JSON.stringify([1, 2, 3]));
    const store = new FileCredentialStore(authPath);
    await expect(store.read('p')).rejects.toThrow('not a JSON object of credentials');
    writeFileSync(authPath, JSON.stringify({ p: 42 }));
    await expect(store.read('p')).rejects.toThrow('not a JSON object of credentials');
  });

  // ENOENT is a real state (logged out everywhere), not an error — and it must also drop any memory of
  // the previous content, so nothing can resurrect a credential the delete was meant to destroy.
  it('a deleted file logs everyone out, and later corruption cannot resurrect the old credential', async () => {
    writeAuthFile({ p: oauth('revoked', 1) });
    const store = new FileCredentialStore(authPath);
    expect(await store.read('p')).toMatchObject({ access: 'fake-access-revoked' });
    rmSync(authPath);
    expect(await store.read('p')).toBeUndefined();
    writeFileSync(authPath, '{ "p": { "type": "oau'); // stays torn — no writer finishes it
    await expect(store.read('p')).rejects.toThrow('does not parse as JSON');
  });
});
