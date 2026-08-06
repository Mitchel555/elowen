import { describe, it, expect } from 'vitest';
import { LiveSessionRegistry, sendLockKey } from '../../../src/brain/session/liveRegistry.js';

type Rec = { sessionId: string; session: { dispose(): void; isStreaming: boolean } };

/** A turn held open on `id`, mirroring the real nesting: `send-<id>` around the whole send, the bare
 *  session id around prompt(). Resolves once BOTH locks are actually held, so the assertion never races
 *  the microtask that takes the inner one. */
function holdTurn(registry: LiveSessionRegistry<Rec>, id: string) {
  let release!: () => void;
  let acquired!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const bothHeld = new Promise<void>((r) => { acquired = r; });
  const turn = registry.withLock(sendLockKey(id), () => registry.withLock(id, async () => {
    acquired();
    await held;
  }));
  return { bothHeld, release, turn };
}

describe('LiveSessionRegistry.busy — the count the shutdown message reports', () => {
  it('counts a running turn ONCE, though it holds the send lock and the session lock at the same time', async () => {
    const registry = new LiveSessionRegistry<Rec>();
    const turn = holdTurn(registry, 'brain-1-abc');
    await turn.bothHeld;

    expect(registry.busy().turns).toBe(1);

    turn.release();
    await turn.turn;
    // The registry drops a key in a `.then()` chained AFTER the operation settles, so awaiting the turn is
    // not enough — by its own documented contract the count trails reality by a tick.
    await new Promise((r) => setTimeout(r, 0));
    expect(registry.busy().turns).toBe(0);
  });

  it('counts one per conversation, not per lock, when several turns run at once', async () => {
    const registry = new LiveSessionRegistry<Rec>();
    const a = holdTurn(registry, 'brain-1-abc');
    const b = holdTurn(registry, 'brain-2-def');
    await Promise.all([a.bothHeld, b.bothHeld]);

    expect(registry.busy().turns).toBe(2);

    a.release(); b.release();
    await Promise.all([a.turn, b.turn]);
  });

  it('still counts a conversation locked on its own — a channel turn takes the bare id only', async () => {
    const registry = new LiveSessionRegistry<Rec>();
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const running = new Promise<void>((r) => { acquired = r; });
    const turn = registry.withLock('brain-ch-discord-1', async () => { acquired(); await held; });
    await running;

    expect(registry.busy().turns).toBe(1);

    release();
    await turn;
  });
});
