import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const runLifecycle = vi.fn(async () => true);
const runHeadlessSetup = vi.fn(async () => {});

vi.mock('../../../src/cli/commands.js', () => ({
  runLifecycle: (...args: unknown[]) => runLifecycle(...(args as [])),
  defaultLifecycleDeps: () => ({}),
}));
vi.mock('../../../src/cli/installInfo.js', () => ({
  readInstallInfo: () => null, // not an `elowen install` box → the local lifecycle brings the daemon up
  webBaseUrl: () => 'http://localhost:4500',
}));
vi.mock('../../../src/cli/setup/headless.js', () => ({
  runHeadlessSetup: (...args: unknown[]) => runHeadlessSetup(...(args as [])),
}));

const { runSetup } = await import('../../../src/cli/setup/command.js');

beforeEach(() => { runLifecycle.mockClear(); runHeadlessSetup.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

/** `elowen setup` must not run the wizard against a daemon that is answering but broken. The readiness
 *  probe used to be a bare `fetch` in a try/catch: any HTTP response — including a 500 from a wedged
 *  daemon — resolved, so setup declared it up and every following API call failed with a confusing
 *  error instead of the daemon being restarted. */
describe('cli/setup/command bringUp readiness', () => {
  it('treats an HTTP error response as NOT healthy and starts the daemon', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await runSetup(['--non-interactive'], {}, 'http://localhost:4400', '1.2.3');
    expect(runLifecycle).toHaveBeenCalledOnce();
    expect(runLifecycle.mock.calls[0]![0]).toBe('up');
    expect(runHeadlessSetup).toHaveBeenCalledOnce();
  });

  it('starts nothing when the daemon already answers healthily', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })));
    await runSetup(['--non-interactive'], {}, 'http://localhost:4400', '1.2.3');
    expect(runLifecycle).not.toHaveBeenCalled();
    expect(runHeadlessSetup).toHaveBeenCalledOnce();
  });
});
