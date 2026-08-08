/** THE BRAIN'S FILE-BACKED CREDENTIAL STORE — what ModelRuntime resolves OAuth tokens through.
 *
 *  pi-coding-agent's own AuthStorage parses auth.json ONCE, at construction, and serves read()/list()
 *  from that in-memory snapshot for the life of the process. Elowen shares one auth.json across SEVERAL
 *  processes — the daemon plus every forked sub-agent runner — and the file changes under all of them:
 *  a re-login through the settings UI rewrites it, and any process's token refresh rotates it. A
 *  snapshot-serving store then keeps handing out a credential the provider has already revoked. The
 *  failure is silent and permanent: a logout+login leaves the OLD access token wallclock-"valid" (its
 *  `expires` is still in the future), so pi's expiry check never enters the refresh path — the only
 *  path that re-reads the disk — and every request 401s until the process restarts.
 *
 *  This store therefore holds NO long-lived snapshot: every read() and list() parses the file anew, so
 *  a credential written by any process is what every other process serves on its very next access. The
 *  file is small and reads are rare (one per model request), so freshness costs nothing measurable.
 *
 *  Writes keep pi's contract (see pi-ai's CredentialStore doc: "mutual exclusion per provider id,
 *  cross-process too where the backing store supports it"): modify()/delete() are serialized in-process
 *  through one promise chain and across processes through a lock directory. The lock lives at
 *  `<authPath>.lock` — the same path (and the same mkdir semantics) proper-lockfile uses inside pi's
 *  AuthStorage, so the two implementations exclude each other should both ever run against one file.
 *  Inside the lock the file is re-read, which is what lets pi's double-checked refresh see a token
 *  another process rotated a moment ago and skip its own refresh instead of burning the rotated one. */
import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';

type AuthFileData = Record<string, Credential>;

/** A lock this old belongs to a process that died holding it; a waiter may take it over. Matches the
 *  30 s staleness pi's AuthStorage passes to proper-lockfile, so neither side steals the other's live
 *  lock earlier than its own would be stolen. */
const STALE_LOCK_MS = 30_000;
/** How often a held lock's mtime is touched. A token refresh inside modify() is a network call that can
 *  outlast the stale window on a slow day; the keepalive is what stops a waiter from "recovering" a lock
 *  that is very much alive. Well under STALE_LOCK_MS so one missed touch cannot look stale. */
const LOCK_KEEPALIVE_MS = 10_000;
/** Give up acquiring after this long — surfacing a wedged lock as an error beats queueing model
 *  requests behind it forever. */
const LOCK_ACQUIRE_DEADLINE_MS = 15_000;
const LOCK_RETRY_DELAY_MS = 50;

const isErrnoCode = (e: unknown, code: string): boolean =>
  typeof e === 'object' && e !== null && (e as NodeJS.ErrnoException).code === code;

export class FileCredentialStore implements CredentialStore {
  private readonly lockPath: string;
  /** The last successfully parsed content — served ONLY when a read lands mid-write and catches the
   *  file torn (pi's AuthStorage writes in place, not via rename). Never served merely because it is
   *  newer code's turn to run: the normal path always re-reads the disk. */
  private lastGood: AuthFileData = {};
  /** In-process write serialization. One chain for the whole file (not per provider) because every
   *  write rewrites the whole document anyway — two providers' writes would still contend on the file
   *  lock, and write traffic (login, hourly refresh) is far too small to care. */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly authPath: string) {
    this.lockPath = `${authPath}.lock`;
  }

  /** Parse auth.json as it is on disk right now. Missing file = logged out everywhere = empty store;
   *  any other failure (unreadable, torn JSON) throws for the caller to decide. */
  private loadStrict(): AuthFileData {
    let raw: string;
    try {
      raw = readFileSync(this.authPath, 'utf-8');
    } catch (e) {
      if (isErrnoCode(e, 'ENOENT')) return {};
      throw e;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('the credential store file is not a JSON object');
    }
    const data = parsed as AuthFileData;
    this.lastGood = data;
    return data;
  }

  /** Read-path load: a read racing an in-place write must not fail the model request it serves, so a
   *  torn file degrades to the last good parse instead of throwing. */
  private loadOptimistic(): AuthFileData {
    try {
      return this.loadStrict();
    } catch {
      return this.lastGood;
    }
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.loadOptimistic()[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.loadOptimistic()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return this.enqueue(() => this.withFileLock(async () => {
      const data = this.loadStrict();
      const next = await fn(data[providerId]);
      // undefined = leave unchanged — but resolve with the CURRENT on-disk credential, exactly like
      // pi's AuthStorage: this is how a caller that skipped its refresh receives the token some other
      // process already rotated.
      if (next === undefined) return data[providerId];
      this.persist({ ...data, [providerId]: next });
      return next;
    }));
  }

  async delete(providerId: string): Promise<void> {
    await this.enqueue(() => this.withFileLock(async () => {
      const data = this.loadStrict();
      if (!(providerId in data)) return;
      delete data[providerId];
      this.persist(data);
    }));
  }

  /** Atomic replace: write a sibling temp file (0600 — these are secrets) and rename it over the
   *  original, so no reader in any process can ever observe a half-written file from us. */
  private persist(data: AuthFileData): void {
    const tmpPath = `${this.authPath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmpPath, this.authPath);
    this.lastGood = data;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeChain.catch(() => undefined).then(task);
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  /** Cross-process mutual exclusion via mkdir (atomic on every platform we run on), with stale-lock
   *  takeover so a crash while holding the lock cannot brick credential writes forever. */
  private async withFileLock<T>(task: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + LOCK_ACQUIRE_DEADLINE_MS;
    for (;;) {
      try {
        mkdirSync(this.lockPath);
        break;
      } catch (e) {
        if (!isErrnoCode(e, 'EEXIST')) throw e;
        let stale = false;
        try {
          stale = Date.now() - statSync(this.lockPath).mtimeMs > STALE_LOCK_MS;
        } catch { /* released between mkdir and stat — loop and try to acquire again */ }
        if (stale) {
          try { rmdirSync(this.lockPath); } catch { /* another waiter won the takeover — loop */ }
          continue;
        }
        if (Date.now() > deadline) throw new Error('timed out waiting for the credential store lock');
        await sleep(LOCK_RETRY_DELAY_MS);
      }
    }
    const keepalive = setInterval(() => {
      const now = new Date();
      try { utimesSync(this.lockPath, now, now); } catch { /* lock gone (stale takeover) — nothing left to keep alive */ }
    }, LOCK_KEEPALIVE_MS);
    // The keepalive must never be what keeps the process alive.
    keepalive.unref();
    try {
      return await task();
    } finally {
      clearInterval(keepalive);
      try { rmdirSync(this.lockPath); } catch { /* taken over as stale after an over-long task — already released */ }
    }
  }
}
