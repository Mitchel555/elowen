import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const runLifecycle = vi.fn(async () => true);
const runHeadlessSetup = vi.fn(async () => {});
const parseHeadlessFlags = vi.fn(() => ({}));
const systemctl = vi.fn(async () => ({ code: 0, stdout: '' }));
/** Whether this box looks like an `elowen install` one (systemd units) or a plain local install. */
let installed = false;

vi.mock('../../../src/cli/commands.js', () => ({
  runLifecycle: (...args: unknown[]) => runLifecycle(...(args as [])),
  defaultLifecycleDeps: () => ({}),
}));
vi.mock('../../../src/cli/installInfo.js', () => ({
  readInstallInfo: () => (installed ? { publicUrl: 'http://localhost:4500', mode: 'localhost', serviceUser: 'elowen', daemonPort: 4400, webPort: 4500 } : null),
  webBaseUrl: () => 'http://localhost:4500',
}));
vi.mock('../../../src/cli/systemd.js', () => ({
  SERVICES: ['elowen-daemon', 'elowen-web'],
  systemctl: (...args: unknown[]) => systemctl(...(args as [])),
}));
vi.mock('../../../src/cli/setup/headless.js', () => ({
  parseHeadlessFlags: (...args: unknown[]) => parseHeadlessFlags(...(args as [])),
  runHeadlessSetup: (...args: unknown[]) => runHeadlessSetup(...(args as [])),
}));

const { runSetup } = await import('../../../src/cli/setup/command.js');

const verbs = (): unknown[] => runLifecycle.mock.calls.map((c) => (c as unknown as unknown[])[0]);

beforeEach(() => {
  installed = false;
  runLifecycle.mockClear();
  runHeadlessSetup.mockClear();
  systemctl.mockClear();
  parseHeadlessFlags.mockClear();
  parseHeadlessFlags.mockImplementation(() => ({}));
});
afterEach(() => vi.unstubAllGlobals());

/** `elowen setup` must not run the wizard against a daemon that is answering but broken. The readiness
 *  probe used to be a bare `fetch` in a try/catch: any HTTP response — including a 500 from a wedged
 *  daemon — resolved, so setup declared it up and every following API call failed with a confusing
 *  error instead of the daemon being restarted. */
describe('cli/setup/command bringUp readiness', () => {
  it('treats an HTTP error response as NOT healthy and starts the daemon', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await runSetup(['--non-interactive'], {}, 'http://localhost:4400', '1.2.3');
    expect(verbs()).toContain('up');
    expect(runHeadlessSetup).toHaveBeenCalledOnce();
  });

  /** The flag gate has to run BEFORE bringUp, not after it. bringUp restarts the daemon on a box that
   *  looks unhealthy, so with the gate behind it a plain typo — `elowen setup --non-interactive
   *  --provider` with no value — cost a service restart before the run died on the parse error. */
  it('refuses a malformed flag before it touches the machine', async () => {
    parseHeadlessFlags.mockImplementation(() => { throw new Error('missing value for --provider'); });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => {
      throw new Error(`exit:${String(code)}`);
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runSetup(['--non-interactive', '--provider'], {}, 'http://localhost:4400', '1.2.3')).rejects.toThrow('exit:1');
    expect(runLifecycle).not.toHaveBeenCalled();
    expect(systemctl).not.toHaveBeenCalled();
    expect(runHeadlessSetup).not.toHaveBeenCalled();
    exit.mockRestore();
    err.mockRestore();
  });

  it('starts nothing when the daemon already answers healthily', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })));
    await runSetup(['--non-interactive'], {}, 'http://localhost:4400', '1.2.3');
    expect(runLifecycle).not.toHaveBeenCalled();
    expect(systemctl).not.toHaveBeenCalled();
    expect(runHeadlessSetup).toHaveBeenCalledOnce();
  });
});

/** Recovery, not just "ask for it to exist". bringUp only runs when /health did NOT answer, so on both
 *  kinds of box it has to be able to REPLACE a running-but-broken daemon. */
describe('cli/setup/command bringUp recovery', () => {
  it('takes a locally-owned daemon DOWN before up, because `up` would re-adopt the wedged pid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await runSetup(['--non-interactive'], {}, 'http://localhost:4400', '1.2.3');
    expect(verbs()).toEqual(['down', 'up']);
  });

  it('restarts the systemd units instead of `start`, which is a no-op on a wedged unit', async () => {
    installed = true;
    // Unhealthy first (the wedged daemon), healthy once the restart has landed.
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (++calls === 1 ? new Response('boom', { status: 500 }) : new Response('{"ok":true}', { status: 200 }))));
    await runSetup(['--non-interactive'], {}, 'http://localhost:4400', '1.2.3');
    expect(systemctl).toHaveBeenCalledWith('restart', 'elowen-daemon', 'elowen-web');
    expect(runLifecycle).not.toHaveBeenCalled(); // never a second, port-conflicting local daemon
    expect(runHeadlessSetup).toHaveBeenCalledOnce();
  });

  it('fails with the daemon still unhealthy after the restart, instead of running the wizard against it', async () => {
    installed = true;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => { /* silenced */ });
    // Fake timers so the real 5s readiness budget is spent instantly — and so the wait is proven to end
    // on the budget rather than on the number of probes.
    vi.useFakeTimers();
    const run = expect(runSetup(['--non-interactive'], {}, 'http://localhost:4400', '1.2.3')).rejects.toThrow('exit');
    await vi.advanceTimersByTimeAsync(6000);
    await run;
    vi.useRealTimers();
    expect(err.mock.calls[0]?.[0]).toMatch(/did not become healthy/);
    expect(runHeadlessSetup).not.toHaveBeenCalled();
    exit.mockRestore();
    err.mockRestore();
  });
});
