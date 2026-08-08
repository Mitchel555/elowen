import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBrainCore } from '../../src/daemon/brainCore.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';

// The WIRING is the protection here: brainCore must hand ModelRuntime the file-backed store, because
// pi's default AuthStorage serves a construction-time snapshot — and with several processes sharing one
// auth.json, a snapshot is exactly the bug (a re-login in another process is never seen, and the stale
// wallclock-"valid" token 401s every request until restart). The credential-store unit tests all
// instantiate FileCredentialStore directly, so without THIS test, reverting brainCore to a snapshot
// store would keep every one of them green.
describe('buildBrainCore credential wiring', () => {
  let dir: string;
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('the runtime serves a credential another process wrote after boot, from a 0700 brain dir', async () => {
    dir = mkdtempSync(join(tmpdir(), 'elowen-core-'));
    const core = await buildBrainCore({
      dbPath: join(dir, 'elowen.db'),
      project: { id: 1, slug: 'wiring', path: dir },
      tmux: new FakeTmuxDriver(),
      bootstrap: null,
    });
    try {
      // The secrets directory must be born closed — group/other access on it would undercut auth.json's
      // own 0600 (temp files, lock directories and future siblings inherit their exposure from it).
      expect(statSync(join(dir, 'brain')).mode & 0o777).toBe(0o700);
      expect(await core.brainRuntime.listCredentials()).toEqual([]);
      // A re-login performed by ANOTHER process rewrites the shared file AFTER this core booted. A
      // snapshot-serving store would still report nothing; the file-backed store must see it now.
      // (Invented token values — never a real credential in a fixture.)
      writeFileSync(
        join(dir, 'brain', 'auth.json'),
        JSON.stringify({ anthropic: { type: 'oauth', access: 'fake-access-w', refresh: 'fake-refresh-w', expires: Date.now() + 3_600_000 } }),
      );
      expect(await core.brainRuntime.listCredentials()).toEqual([{ providerId: 'anthropic', type: 'oauth' }]);
    } finally {
      core.db.close();
    }
  });
});
