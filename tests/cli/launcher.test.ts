import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, writeState, clearState, isAlive, isTrackedService, status, stop, start, type RunState, type IsTracked } from '../../src/cli/launcher.js';
import type { spawn as nodeSpawn } from 'node:child_process';

let home: string;
let env: NodeJS.ProcessEnv;
const sample: RunState = { daemon: { pid: 111, port: 4400 }, web: { pid: 222, port: 4500 }, version: '1.1.1', startedAt: '2026-06-22T00:00:00Z' };

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'elowen-launch-')); env = { HOME: home } as NodeJS.ProcessEnv; });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('cli/launcher state', () => {
  it('round-trips run state through the run file', () => {
    writeState(env, sample);
    expect(readState(env)).toEqual(sample);
  });
  it('returns null when the run file is missing', () => {
    expect(readState(env)).toBeNull();
  });
  it('returns null (not throw) when the run file is corrupt', () => {
    mkdirSync(join(home, '.config', 'elowen'), { recursive: true });
    writeFileSync(join(home, '.config', 'elowen', 'run.json'), '{ not json', 'utf8');
    expect(readState(env)).toBeNull();
  });
  it('clearState removes the run file and tolerates a missing one', () => {
    writeState(env, sample);
    clearState(env);
    expect(readState(env)).toBeNull();
    expect(() => clearState(env)).not.toThrow();
  });
});

describe('cli/launcher.isAlive', () => {
  it('is true for the current process and false for a surely-dead pid', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(2147483646)).toBe(false);
  });
});

describe('cli/launcher.isTrackedService', () => {
  it('is false for a dead pid regardless of platform', () => {
    expect(isTrackedService(2147483646, 'daemon')).toBe(false);
  });
  it('rejects a live pid that is not our service (this test runner is not the daemon entry)', () => {
    // On Linux the procfs argv of the vitest process carries no `daemon/index.js`; elsewhere there is no
    // /proc so it falls back to liveness (true). Either way it must never be mistaken for the daemon on
    // the platform we ship to.
    if (process.platform === 'linux') expect(isTrackedService(process.pid, 'daemon')).toBe(false);
  });
});

describe('cli/launcher.status', () => {
  it('reports not-running when there is no run file', async () => {
    const s = await status(env, async () => new Response('', { status: 200 }));
    expect(s.daemon.running).toBe(false);
    expect(s.web.running).toBe(false);
  });
  it('reports running + healthy when the tracked pid is ours and the port answers', async () => {
    writeState(env, { ...sample, daemon: { pid: process.pid, port: 4400 }, web: { pid: process.pid, port: 4500 } });
    const s = await status(env, async () => new Response('ok', { status: 200 }), () => true);
    expect(s.daemon).toMatchObject({ running: true, pid: process.pid, healthy: true });
    expect(s.web).toMatchObject({ running: true, healthy: true });
  });
  it('running but unhealthy when the tracked pid is ours but the port is silent', async () => {
    writeState(env, { ...sample, daemon: { pid: process.pid, port: 4400 }, web: { pid: process.pid, port: 4500 } });
    const s = await status(env, async () => { throw new Error('ECONNREFUSED'); }, () => true);
    expect(s.daemon).toMatchObject({ running: true, healthy: false });
  });
  it('reports not-running for a recycled pid the identity check disowns (never probes its port)', async () => {
    writeState(env, { ...sample, daemon: { pid: process.pid, port: 4400 }, web: { pid: process.pid, port: 4500 } });
    let probed = false;
    const s = await status(env, async () => { probed = true; return new Response('ok', { status: 200 }); }, () => false);
    expect(s.daemon).toMatchObject({ running: false, healthy: false });
    expect(probed).toBe(false);
  });
});

// Two pids no test machine will ever actually have running, so `isAlive()` reads false for them without
// depending on real OS state — `stop`'s wait loop then hinges purely on the injected fetch (port) signal.
const deadPids: RunState = { daemon: { pid: 2147483646, port: 4400 }, web: { pid: 2147483645, port: 4500 }, version: '1.1.1', startedAt: '2026-06-22T00:00:00Z' };

describe('cli/launcher.stop', () => {
  it('signals each tracked pid it confirms is ours, waits for its port to go silent, then clears the run file', async () => {
    writeState(env, deadPids);
    const killed: number[] = [];
    let calls = 0;
    // "still answering" on the first probe of each target, silent from then on — proves stop() actually
    // waits for the port to go quiet instead of clearing state right after the SIGTERM.
    const fetchFn = (async () => { calls++; return calls <= 2 ? new Response('ok', { status: 200 }) : new Response('', { status: 503 }); }) as unknown as typeof fetch;
    await stop(env, { kill: (pid) => killed.push(pid), isTracked: () => true, fetch: fetchFn, pollMs: 1, attempts: 5 });
    expect(killed.sort((a, b) => a - b)).toEqual([deadPids.web.pid, deadPids.daemon.pid].sort((a, b) => a - b));
    expect(readState(env)).toBeNull();
  });
  it('never signals a recycled pid the identity check disowns, but still clears the run file once the tracked one is gone', async () => {
    writeState(env, deadPids); // daemon tracked; web recycled → disowned
    const killed: number[] = [];
    const fetchFn = (async () => new Response('', { status: 503 })) as unknown as typeof fetch; // nothing answers
    await stop(env, { kill: (pid) => killed.push(pid), isTracked: (pid) => pid === deadPids.daemon.pid, fetch: fetchFn, pollMs: 1, attempts: 3 });
    expect(killed).toEqual([deadPids.daemon.pid]);
    expect(readState(env)).toBeNull();
  });
  it('is a no-op when nothing is running', async () => {
    const killed: number[] = [];
    await stop(env, { kill: (pid) => killed.push(pid) });
    expect(killed).toEqual([]);
  });
  it('leaves the run file in place and throws when a tracked service never stops answering', async () => {
    writeState(env, deadPids);
    const fetchFn = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch; // never goes silent
    await expect(stop(env, { isTracked: () => true, fetch: fetchFn, pollMs: 1, attempts: 3 }))
      .rejects.toThrow(/did not stop/);
    expect(readState(env)).not.toBeNull();
  });
});

describe('cli/launcher.start', () => {
  const fakeSpawn = (() => ({ pid: 4321, unref() { /* detached */ } })) as unknown as typeof nodeSpawn;

  /** A spawn+fetch pair where a port only answers healthy once something has actually been "launched" on
   *  it (tracked by the port env var `launch()` passes the child). A blanket-healthy fetch would make the
   *  new "is something else already on this port" pre-flight check misfire before anything was spawned. */
  function trackedHealthMock(pid = 4321): { spawn: typeof nodeSpawn; fetch: typeof fetch } {
    const launchedPorts = new Set<number>();
    const spawn = ((_cmd: unknown, _args: unknown, opts?: { env?: Record<string, string | undefined> }) => {
      const port = Number(opts?.env?.ELOWEN_PORT ?? opts?.env?.PORT);
      if (Number.isFinite(port)) launchedPorts.add(port);
      return { pid, unref() { /* detached */ } };
    }) as unknown as typeof nodeSpawn;
    const fetch = (async (url: string | URL) => {
      const m = /:(\d+)/.exec(String(url));
      const port = m ? Number(m[1]) : NaN;
      return launchedPorts.has(port) ? new Response('ok', { status: 200 }) : new Response('', { status: 503 });
    }) as unknown as typeof fetch;
    return { spawn, fetch };
  }

  it('records run state and resolves once BOTH the daemon and the web answer healthy', async () => {
    const { spawn, fetch: fetchFn } = trackedHealthMock();
    const s = await start(env, { version: '9.9.9', spawn, fetch: fetchFn, pollMs: 1, attempts: 5 });
    expect(s.daemon.pid).toBe(4321);
    expect(s.web.pid).toBe(4321);
    expect(readState(env)).toEqual(s);
  });

  it('throws when the daemon never becomes healthy, but still records pids for cleanup', async () => {
    const fetchFn = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(start(env, { version: '9.9.9', spawn: fakeSpawn, fetch: fetchFn, pollMs: 1, attempts: 2 }))
      .rejects.toThrow(/did not become healthy/);
    expect(readState(env)?.daemon.pid).toBe(4321);
  });

  it('adopts existing pids the identity check confirms are still ours (no re-spawn)', async () => {
    writeState(env, sample); // daemon 111, web 222
    const fetchFn = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
    const s = await start(env, { version: '9.9.9', spawn: fakeSpawn, fetch: fetchFn, pollMs: 1, attempts: 3, isTracked: () => true });
    expect(s.daemon.pid).toBe(111);
    expect(s.web.pid).toBe(222);
  });

  it('re-spawns instead of adopting a stale run.json whose pids the identity check disowns', async () => {
    writeState(env, sample); // pids 111/222 are stale after a reboot that recycled them
    const { spawn, fetch: fetchFn } = trackedHealthMock();
    const s = await start(env, { version: '9.9.9', spawn, fetch: fetchFn, pollMs: 1, attempts: 5, isTracked: () => false });
    expect(s.daemon.pid).toBe(4321); // freshly spawned, not the recycled 111
    expect(s.web.pid).toBe(4321);
  });

  it('refuses to spawn a second daemon when nothing is tracked but the port already answers healthy', async () => {
    // No run.json at all (nothing tracked) yet the daemon port already answers — some other, untracked
    // process owns it (systemd, or a start() that raced past this one's lock).
    const fetchFn = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
    await expect(start(env, { version: '9.9.9', spawn: fakeSpawn, fetch: fetchFn, pollMs: 1, attempts: 3 }))
      .rejects.toThrow(/refusing to spawn a second one/);
  });

  it('serialises concurrent start() calls: a second racing invocation adopts the first instead of spawning again', async () => {
    const { spawn: baseSpawn, fetch: fetchFn } = trackedHealthMock();
    let spawnCount = 0;
    const spawn = ((...args: Parameters<typeof nodeSpawn>) => {
      spawnCount++;
      return (baseSpawn as unknown as (...a: unknown[]) => ReturnType<typeof nodeSpawn>)(...args);
    }) as unknown as typeof nodeSpawn;
    // Without the lock both calls would read an empty run.json before either had written one and BOTH
    // would decide to spawn (spawnCount 4, two daemons + two webs colliding on the same ports).
    const isTracked: IsTracked = (pid) => pid === 4321;
    const [a, b] = await Promise.all([
      start(env, { version: '9.9.9', spawn, fetch: fetchFn, pollMs: 1, attempts: 5, isTracked, lockPollMs: 1, lockAttempts: 200 }),
      start(env, { version: '9.9.9', spawn, fetch: fetchFn, pollMs: 1, attempts: 5, isTracked, lockPollMs: 1, lockAttempts: 200 }),
    ]);
    expect(spawnCount).toBe(2); // one daemon + one web — the second call adopted instead of spawning again
    expect(a.daemon.pid).toBe(b.daemon.pid);
    expect(a.web.pid).toBe(b.web.pid);
  });
});
