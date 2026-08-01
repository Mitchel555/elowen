import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BrainClient, Unauthorized } from '../../../src/cli/chat/brainClient.js';
import { wireSubmit } from '../../../src/cli/chat/commands.js';
import { LocalShellBuffer, LOCAL_SHELL_TIMEOUT_MS } from '../../../src/cli/chat/localShell.js';
import { ChatApplicationLifetime } from '../../../src/cli/chat/applicationLifetime.js';
import { ChatState } from '../../../src/cli/chat/chatState.js';
import { TranscriptModel } from '../../../src/brain/transcriptModel.js';

/** The `!` local-shell timeout is an operator setting (Elowen AI → Runtime) the CLI reads from the daemon
 *  at boot. Two halves are covered: the client that fetches it (defensively, since an older daemon serves
 *  no runtime block at all) and the submit wiring that hands it to the real shell runner. */

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const clientWith = (body: unknown, status = 200): BrainClient => new BrainClient({
  base: 'http://x', token: 't', clientId: 'cli-a',
  fetchImpl: (vi.fn(async () => json(status, body)) as unknown) as typeof fetch,
});

describe('BrainClient.localShellTimeoutMs', () => {
  it('reads the configured timeout from the public config', async () => {
    const c = clientWith({ runtime: { limits: { localShellTimeoutMs: 120_000 } } });
    expect(await c.localShellTimeoutMs()).toBe(120_000);
  });

  it('yields null when the daemon serves no runtime block, so the caller keeps its built-in default', async () => {
    expect(await clientWith({ brain: { providers: [] } }).localShellTimeoutMs()).toBeNull();
  });

  it('yields null for a malformed or unusable value rather than a NaN timeout', async () => {
    for (const bad of ['30000', null, 0, -5, Number.NaN]) {
      expect(await clientWith({ runtime: { limits: { localShellTimeoutMs: bad } } }).localShellTimeoutMs()).toBeNull();
    }
  });

  it('still reports an expired session as unauthorized', async () => {
    await expect(clientWith({}, 401).localShellTimeoutMs()).rejects.toBeInstanceOf(Unauthorized);
  });
});

describe('`!` submit wiring', () => {
  /** Poll until `done` or the deadline; the `!` result lands through the lifetime's publication hop. */
  async function waitFor(done: () => boolean, timeoutMs = 4_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!done()) {
      if (Date.now() > deadline) throw new Error('the local shell result never landed');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('kills a `!` command at the configured timeout instead of the built-in 30 s', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-shell-timeout-config-'));
    const priorHome = process.env.HOME;
    process.env.HOME = home;
    const lifetime = new ChatApplicationLifetime<'metadata'>();
    try {
      let onSubmit: ((text: string) => void) | undefined;
      const editor = {
        addToHistory: vi.fn(), setText: vi.fn(),
        set onSubmit(fn: (text: string) => void) { onSubmit = fn; },
      };
      const shellContext = new LocalShellBuffer();
      const state = new ChatState({ transcript: new TranscriptModel() });
      wireSubmit(
        state,
        // No `runLocalShell` override below, so this drives the REAL runner the CLI uses in production.
        { client: {}, editor, shellContext, attachmentChips: {}, commandDefs: [], tui: {}, lifetime, localShellTimeoutMs: 60 } as never,
        { render: vi.fn() } as never,
        { stream: {}, pickers: {} } as never,
      );

      // Far longer than the configured timeout: only a runner that received it can settle this in time.
      onSubmit?.('!sleep 30');
      await waitFor(() => shellContext.pending);
      expect(shellContext.take('next')).toMatch(/timed out after 0\.06s/);
    } finally {
      lifetime.stop();
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('the built-in default is unchanged, so an unreachable/older daemon behaves exactly as before', () => {
    expect(LOCAL_SHELL_TIMEOUT_MS).toBe(30_000);
  });
});
