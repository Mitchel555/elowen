import { describe, it, expect, vi } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

type Msg = { text: string; edit?: unknown };
type Lm = {
  onEvent: (e: Record<string, unknown>) => void;
  finalize: (reply?: string) => Promise<void>;
  progress: { lastEdit: number; flush: () => unknown } | null;
};

/** WhatsApp keeps its OWN editable-message transport (Baileys edits) while the render/fold engine is
 *  shared. These tests pin the message LIFECYCLE rules that the shared engine
 *  (plugins/_shared/liveMessage.mjs) states explicitly and the WhatsApp copy had drifted away from:
 *  sends must be serialized (a slow create must not be raced into a second bubble), the last throttled
 *  update must still land on its own, and an over-long trace must keep its NEWEST rows. */
describe('whatsapp LiveMessage (edit lifecycle)', () => {
  const load = async () => (await import(join(repoRoot, 'plugins/whatsapp/lib/stream.mjs'))) as {
    LiveMessage: new (adapter: unknown, jid: string, quoted?: unknown, asker?: string) => Lm;
  };

  /** A fake Baileys adapter: `sock.sendMessage` records the latest progress-bubble text (create + every
   *  edit overwrite the same buffer) and counts creates vs edits. */
  function fakeAdapter(onSend?: (msg: Msg) => Promise<void>) {
    const state = { progress: '', creates: 0, edits: 0, answers: [] as string[] };
    const adapter = {
      cfg: { runtimeFooter: false },
      sock: {
        sendMessage: async (_jid: string, msg: Msg) => {
          if (msg.edit) state.edits++; else state.creates++;
          await onSend?.(msg);
          state.progress = msg.text;
          return { key: msg.edit ?? { id: 'k1' } };
        },
      },
      resolveImageFiles: () => [],
      sendImages: async () => {},
      sendText: async (_jid: string, body: string) => { state.answers.push(body); },
      postAsk: async () => {},
    };
    return { adapter, state };
  }

  it('never opens a SECOND bubble while the first create is still in flight', async () => {
    const { LiveMessage } = await load();
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    // The first create is slow (a real Baileys send can take seconds) — longer than the edit throttle.
    const { adapter, state } = fakeAdapter(async (msg) => { if (!msg.edit) await gate; });
    const lm = new LiveMessage(adapter, 'jid@s');

    lm.onEvent({ type: 'tool', id: 'a', name: 'Bash', detail: 'first-tool', icon: '💻' });
    if (lm.progress) lm.progress.lastEdit = 0; // the throttle window lapsed while the create is unacked
    lm.onEvent({ type: 'tool', id: 'b', name: 'Read', detail: 'second-tool', icon: '📄' });

    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(state.creates).toBe(1);           // a raced flush used to post a second progress bubble
    expect(state.progress).toContain('second-tool'); // …and the update still lands, as an edit
  });

  it('lands the last throttled update without waiting for another event', async () => {
    const { LiveMessage } = await load();
    const { adapter, state } = fakeAdapter();
    vi.useFakeTimers();
    try {
      const lm = new LiveMessage(adapter, 'jid@s');
      lm.onEvent({ type: 'tool', id: 'a', name: 'Bash', detail: 'first-tool', icon: '💻' });
      await vi.advanceTimersByTimeAsync(0); // the create settles
      lm.onEvent({ type: 'tool', id: 'b', name: 'Read', detail: 'second-tool', icon: '📄' }); // inside the throttle window
      await vi.advanceTimersByTimeAsync(5000);
      // No further event arrives — the trailing flush must still carry the newest trace to the bubble.
      expect(state.progress).toContain('second-tool');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the NEWEST rows when the trace outgrows the WhatsApp message limit', async () => {
    const { LiveMessage } = await load();
    const { adapter, state } = fakeAdapter();
    const lm = new LiveMessage(adapter, 'jid@s');
    for (let i = 0; i < 80; i++) {
      lm.onEvent({ type: 'tool', id: `t${i}`, name: `Tool${i}`, detail: `step-${i}-${'x'.repeat(60)}`, icon: '🔧' });
      lm.onEvent({ type: 'tool_output', id: `t${i}`, output: { title: 'out', kind: 'console', text: `result ${i}`, tone: 'success' } });
    }
    await lm.finalize('Done.');
    expect(state.progress.length).toBeLessThanOrEqual(4000);
    expect(state.progress).toContain('step-79-');  // the active tail — dropped by a head-first truncation
    expect(state.progress).not.toContain('step-0-'); // the oldest rows are what gets elided
  });
});
