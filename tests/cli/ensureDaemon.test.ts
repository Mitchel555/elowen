import { describe, it, expect } from 'vitest';
import { spawn as nodeSpawn } from 'node:child_process';
import { ensureDaemon, systemdKnown, type EnsureDaemonDeps } from '../../src/cli/index.js';
import { runCmd } from '../../src/cli/systemd.js';

/** A spawn fake that records invocations and answers like a successful detached spawn. */
function fakeSpawn(recorded: { count: number }): typeof nodeSpawn {
  return ((() => { recorded.count++; return { unref: () => {}, pid: 4242 }; }) as unknown as typeof nodeSpawn);
}

/** Canary: reaching the real spawn in a test would boot a real daemon — any test that does not mean to
 *  spawn will fail loudly instead. */
const noSpawn = (() => { throw new Error('ensureDaemon must not spawn here'); }) as unknown as typeof nodeSpawn;

/** The healthy-first fast path and the pre-spawn polling window both resolve through these seams. */
function deps(over: Partial<EnsureDaemonDeps> = {}): EnsureDaemonDeps {
  return {
    urlHealthy: async () => false,
    waitHealthy: async () => [false],
    spawn: noSpawn,
    systemdKnown: async () => false,
    ...over,
  };
}

describe('cli/index.ensureDaemon', () => {
  it('is a no-op when autostart is disabled — no probes at all', async () => {
    process.env.ELOWEN_AUTOSTART = '0';
    try {
      const d = deps({ urlHealthy: async () => { throw new Error('must not probe'); } });
      await expect(ensureDaemon(d)).resolves.toBeUndefined();
    } finally {
      delete process.env.ELOWEN_AUTOSTART;
    }
  });

  it('returns immediately when the daemon is already healthy (no polling window, no spawn)', async () => {
    let waited = false;
    const d = deps({ urlHealthy: async () => true, waitHealthy: async () => { waited = true; return [false]; } });
    await expect(ensureDaemon(d)).resolves.toBeUndefined();
    expect(waited).toBe(false);
  });

  it('keeps polling a short window instead of spawning on the first failed probe — the daemon comes up', async () => {
    const spawned = { count: 0 };
    const d = deps({ waitHealthy: async () => [true], spawn: fakeSpawn(spawned) });
    await expect(ensureDaemon(d)).resolves.toBeUndefined();
    expect(spawned.count).toBe(0); // the mid-window recovery made the spawn unnecessary
  });

  it('never spawns on a systemd-managed box — advises systemctl start instead', async () => {
    const spawned = { count: 0 };
    const d = deps({ systemdKnown: async () => true, spawn: fakeSpawn(spawned) });
    await expect(ensureDaemon(d)).rejects.toThrow(/systemctl start elowen-daemon elowen-web/);
    expect(spawned.count).toBe(0);
  });

  it('spawns a detached daemon on a non-systemd box when nothing answers after the window', async () => {
    const spawned = { count: 0 };
    let call = 0;
    // The pre-spawn window resolves unhealthy; the post-spawn wait resolves healthy.
    const d = deps({ waitHealthy: async () => [++call === 1 ? false : true], spawn: fakeSpawn(spawned) });
    await expect(ensureDaemon(d)).resolves.toBeUndefined();
    expect(spawned.count).toBe(1);
  });

  it('reports failure when a spawned daemon never becomes healthy', async () => {
    const spawned = { count: 0 };
    const d = deps({ waitHealthy: async () => [false], spawn: fakeSpawn(spawned) });
    await expect(ensureDaemon(d)).rejects.toThrow('elowen daemon did not become healthy');
    expect(spawned.count).toBe(1);
  });
});

describe('cli/index.systemdKnown', () => {
  it('is true when the elowen units are listed', async () => {
    const run: typeof runCmd = async () => ({ code: 0, stdout: 'elowen-daemon.service enabled\nelowen-web.service enabled\n' });
    expect(await systemdKnown(run)).toBe(true);
  });
  it('is true when only the daemon unit is listed (the port-owning one)', async () => {
    const run: typeof runCmd = async () => ({ code: 0, stdout: 'elowen-daemon.service enabled\n' });
    expect(await systemdKnown(run)).toBe(true);
  });
  it('is false when systemctl fails (no systemd at PID 1)', async () => {
    const run: typeof runCmd = async () => ({ code: 1, stdout: '' });
    expect(await systemdKnown(run)).toBe(false);
  });
  it('is false when the elowen units are not among the listed ones', async () => {
    const run: typeof runCmd = async () => ({ code: 0, stdout: 'ssh.service enabled\ndocker.service enabled\n' });
    expect(await systemdKnown(run)).toBe(false);
  });
  // The tests above replay a canned stdout, so they pass for ANY argv — including the one systemd answers
  // with "0 unit files listed" and exit 0. That is not hypothetical: querying without the `.service`
  // suffix matches nothing, which made this whole check dead code on real boxes while staying green here.
  // Pin the argv itself, because the stub cannot tell a working query from a broken one.
  it('queries systemctl with the .service suffix, which is what actually matches a unit', async () => {
    const seen: string[][] = [];
    const run: typeof runCmd = async (_cmd, args) => { seen.push(args); return { code: 0, stdout: '' }; };
    await systemdKnown(run);
    expect(seen).toEqual([['list-unit-files', 'elowen-daemon.service', 'elowen-web.service']]);
  });
});
