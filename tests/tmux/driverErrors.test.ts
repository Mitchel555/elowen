import { describe, it, expect, beforeEach, vi } from 'vitest';

/** Every tmux argv the driver ran, in order. */
const calls: string[][] = [];
/** Per-test tmux behaviour: return stdout, or an Error to make the call fail. */
let respond: (args: string[]) => string | Error = () => '';

vi.mock('node:child_process', () => ({
  execFile: (_cmd: string, args: string[], ...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (e: Error | null, r?: { stdout: string; stderr: string }) => void;
    calls.push(args);
    const out = respond(args);
    if (out instanceof Error) cb(out);
    else cb(null, { stdout: out, stderr: '' });
  },
}));

const { RealTmuxDriver } = await import('../../src/tmux/driver.js');

/** A tmux failure exactly as execFile surfaces it: stderr carried on the Error. */
const tmuxFail = (stderr: string): Error => Object.assign(new Error(`Command failed: tmux\n${stderr}`), { stderr });

beforeEach(() => { calls.length = 0; respond = () => ''; });

describe('RealTmuxDriver.list error handling', () => {
  it('returns the session names on success', async () => {
    respond = () => 'elowen-A\nelowen-B\n';
    expect(await new RealTmuxDriver().list()).toEqual(['elowen-A', 'elowen-B']);
  });

  it('returns an empty list when tmux reports no running server (genuinely no sessions)', async () => {
    respond = () => tmuxFail('no server running on /tmp/tmux-1000/default');
    expect(await new RealTmuxDriver().list()).toEqual([]);
  });

  it('returns an empty list when the socket does not exist yet', async () => {
    respond = () => tmuxFail('error connecting to /tmp/tmux-1000/default (No such file or directory)');
    expect(await new RealTmuxDriver().list()).toEqual([]);
  });

  it('THROWS on a real tmux failure instead of reporting "no sessions"', async () => {
    // A transient tmux fault reported as an empty list makes every liveness caller (stuck detector,
    // janitor, overseer watchdog) conclude that all running agents died and revert their tasks.
    respond = () => tmuxFail('lost server');
    await expect(new RealTmuxDriver().list()).rejects.toThrow(/lost server/);
  });

  it('THROWS when the tmux binary is missing (ENOENT), rather than claiming nothing runs', async () => {
    respond = () => Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' });
    await expect(new RealTmuxDriver().list()).rejects.toThrow(/ENOENT/);
  });
});

describe('RealTmuxDriver.kill error handling', () => {
  it('resolves when the session is already gone', async () => {
    respond = () => tmuxFail("can't find session: elowen-X");
    await expect(new RealTmuxDriver().kill('elowen-X')).resolves.toBeUndefined();
  });

  it('resolves when no tmux server is running at all', async () => {
    respond = () => tmuxFail('no server running on /tmp/tmux-1000/default');
    await expect(new RealTmuxDriver().kill('elowen-X')).resolves.toBeUndefined();
  });

  it('THROWS when the kill genuinely failed', async () => {
    // Callers treat a resolved kill as "the process is gone" and move on (reap the task, relaunch,
    // hand the name to a new agent) — so a swallowed failure leaves a live agent behind a dead task.
    respond = () => tmuxFail('server exited unexpectedly');
    await expect(new RealTmuxDriver().kill('elowen-X')).rejects.toThrow(/server exited unexpectedly/);
  });
});

describe('RealTmuxDriver.spawn is all-or-nothing', () => {
  it('kills the freshly created session when send-keys fails, and reports the failure', async () => {
    // Without the cleanup the pane shell survives with no command in it, and the caller's retry dies
    // with "duplicate session" — the session name is blocked until a human clears it.
    respond = (args) => (args[0] === 'send-keys' ? tmuxFail('no space left on device') : '');
    await expect(new RealTmuxDriver().spawn('elowen-A', { cwd: '/tmp', command: 'claude' }))
      .rejects.toThrow(/no space left on device/);
    expect(calls.map((c) => c[0])).toContain('kill-session');
    expect(calls.find((c) => c[0] === 'kill-session')).toEqual(['kill-session', '-t', '=elowen-A:']);
  });

  it('leaves the session in place when the whole spawn succeeded', async () => {
    await new RealTmuxDriver().spawn('elowen-A', { cwd: '/tmp', command: 'claude' });
    expect(calls.map((c) => c[0])).toEqual(['new-session', 'set-option', 'send-keys']);
  });
});
