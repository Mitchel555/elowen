import { describe, it, expect } from 'vitest';
import {
  deliverQueuedUserEcho,
  enqueueMirrored,
  queuedWithPending,
  reconcileMirrors,
  stageDeliveredUserEchoes,
} from '../../src/brain/session/queueMirror.js';
import type { LiveBrain, QueuedMsg } from '../../src/brain/session/liveBrain.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb } from '../../src/store/db.js';

describe('queueMirror.reconcileMirrors', () => {
  const img = [{ type: 'image' as const, data: 'B64', mimeType: 'image/png' }];

  it('drops delivered messages off the FRONT (PI delivers FIFO), keeping the survivors\' images', () => {
    const steer: QueuedMsg[] = [{ text: 'a', images: img }, { text: 'b' }, { text: 'c' }];
    const followUp: QueuedMsg[] = [];
    // PI delivered the two oldest steering messages → only 'c' remains in its (expanded) text queue.
    reconcileMirrors(steer, followUp, ['c-expanded'], []);
    expect(steer).toEqual([{ text: 'c', queuedText: 'c-expanded' }]); // 'a','b' trimmed from the front → ['c']
    expect(steer.map((m) => m.text)).toEqual(['c']);
  });

  it('pads from PI text when something enqueued outside the mirror (those carry no images)', () => {
    const steer: QueuedMsg[] = [{ text: 'kept', images: img }];
    reconcileMirrors(steer, [], ['kept', 'bypass1', 'bypass2'], []);
    expect(steer).toHaveLength(3);
    expect(steer[0]).toEqual({ text: 'kept', images: img, queuedText: 'kept' }); // image preserved
    expect(steer[1]).toEqual({ text: 'bypass1', queuedText: 'bypass1' });
    expect(steer[2]).toEqual({ text: 'bypass2', queuedText: 'bypass2' });
  });

  it('matched counts leave the image-carrying mirror untouched', () => {
    const steer: QueuedMsg[] = [{ text: 'x', images: img }];
    reconcileMirrors(steer, [], ['x-expanded-by-pi'], []); // same count → no shrink, no pad
    expect(steer).toEqual([{ text: 'x', images: img, queuedText: 'x-expanded-by-pi' }]);
  });

  it('returns the delivered front item and retains PI-expanded text for exact user-message matching', () => {
    const echo = { persistText: 'clean', displayText: 'clean', publish: true };
    const steer: QueuedMsg[] = [{ text: '/skill:test clean', echo }, { text: 'later' }];
    reconcileMirrors(steer, [], ['<skill>expanded</skill> clean', 'later'], []);

    const removed = reconcileMirrors(steer, [], ['later'], []);

    expect(removed).toEqual([
      expect.objectContaining({ text: '/skill:test clean', queuedText: '<skill>expanded</skill> clean', echo }),
    ]);
    expect(steer).toEqual([expect.objectContaining({ text: 'later', queuedText: 'later' })]);
  });
});

describe('queueMirror.queuedWithPending', () => {
  it('prepends display-only compaction chips ahead of PI queue items, keeping their own ids', () => {
    const live = {
      queuedSteer: [{ text: 'steered' }],
      queuedFollowUp: [{ text: 'follow' }],
      pendingCompactionEchoes: [{ id: 'pc-1', text: 'typed during compact' }],
    } as unknown as LiveBrain;
    expect(queuedWithPending(live)).toEqual([
      { id: 'pc-1', text: 'typed during compact' }, // waiting under the manual /compact, shown first
      { id: '0', text: 'steered' },
      { id: '1', text: 'follow' },
    ]);
  });

  it('is exactly the PI queue when nothing waits under a compaction', () => {
    const live = { queuedSteer: [{ text: 'x' }], queuedFollowUp: [] } as unknown as LiveBrain;
    expect(queuedWithPending(live)).toEqual([{ id: '0', text: 'x' }]);
  });
});

describe('queueMirror.enqueueMirrored', () => {
  it('records the message (with images) on the mirror AND forwards to PI steer/followUp', async () => {
    const calls: { kind: string; text: string; images?: unknown }[] = [];
    const live = {
      session: {
        steer: async (text: string, images?: unknown) => { calls.push({ kind: 'steer', text, images }); },
        followUp: async (text: string, images?: unknown) => { calls.push({ kind: 'followUp', text, images }); },
      },
    } as unknown as LiveBrain;
    const img = [{ type: 'image' as const, data: 'Z', mimeType: 'image/png' }];
    await enqueueMirrored(live, 'steer', 'hi', img);
    await enqueueMirrored(live, 'followUp', 'later');
    expect(live.queuedSteer).toEqual([{ text: 'hi', images: img }]);
    expect(live.queuedFollowUp).toEqual([{ text: 'later', images: undefined }]);
    expect(calls).toEqual([
      { kind: 'steer', text: 'hi', images: img },
      { kind: 'followUp', text: 'later', images: undefined },
    ]);
  });

  it('projects and publishes a queued user only after its delivered item is staged', () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 's1', userId: 1, model: 'm' });
    const published: unknown[] = [];
    const echo = { persistText: 'expanded durable text', displayText: 'clean display', publish: true };
    const delivered = { text: 'clean display', queuedText: 'PI expanded text', echo };
    const live = {
      sessionId: 's1',
      replay: { publish: (event: unknown) => published.push(event), journal: (event: unknown) => published.push(event) },
    } as unknown as LiveBrain;

    expect(deliverQueuedUserEcho(store, live, 'PI expanded text')).toBe(false);
    stageDeliveredUserEchoes(live, [delivered]);
    expect(deliverQueuedUserEcho(store, live, 'PI expanded text')).toBe(true);

    expect(store.getMessages('s1').map((row) => JSON.parse(row.content).content)).toEqual(['expanded durable text']);
    expect(published).toEqual([expect.objectContaining({ type: 'user', text: 'clean display' })]);
  });

  // A message sent WHILE a turn streams is queued, and its durable row is written here, at delivery —
  // long after the base64 is gone. Unless the references written at enqueue time ride along, the row
  // keeps only its `[📎 …]` marker and the attachment vanishes on reload, unlike an idle-sent one.
  it('carries a queued message\'s attachments into both the durable row and the echo', () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 's1', userId: 1, model: 'm' });
    const published: unknown[] = [];
    const images = [{ file: '1e2d3c4b-5a69-4788-9aab-bbccddeeff00.png', mimeType: 'image/png' }];
    const echo = { persistText: 'text\n[📎 1× image]', displayText: 'text', publish: true, images };
    const live = {
      sessionId: 's1',
      replay: { publish: (event: unknown) => published.push(event), journal: (event: unknown) => published.push(event) },
    } as unknown as LiveBrain;

    stageDeliveredUserEchoes(live, [{ text: 'text', queuedText: 'q', echo }]);
    expect(deliverQueuedUserEcho(store, live, 'q')).toBe(true);

    expect(JSON.parse(store.getMessages('s1')[0]!.content).images).toEqual(images);
    expect(published).toEqual([expect.objectContaining({
      type: 'user',
      images: [{ url: '/brain/chat-images/1e2d3c4b-5a69-4788-9aab-bbccddeeff00.png', mimeType: 'image/png' }],
    })]);
  });

  it('leaves a queued message without attachments free of the field', () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 's1', userId: 1, model: 'm' });
    const published: unknown[] = [];
    const live = {
      sessionId: 's1',
      replay: { publish: (e: unknown) => published.push(e), journal: (e: unknown) => published.push(e) },
    } as unknown as LiveBrain;

    stageDeliveredUserEchoes(live, [{ text: 'plain', queuedText: 'q', echo: { persistText: 'plain', displayText: 'plain', publish: true } }]);
    deliverQueuedUserEcho(store, live, 'q');

    expect(JSON.parse(store.getMessages('s1')[0]!.content).images).toBeUndefined();
    expect((published[0] as { images?: unknown }).images).toBeUndefined();
  });

  // Esc-discard deletes from the admitted user row to the END of the session, so a second user row landing
  // inside the same turn would be deleted along with it — while only the first is handed back to the
  // composer. Delivering a queued message therefore drops the discard claim: the turn stops being
  // discardable as a unit the moment it contains text the discard could not restore.
  it('drops the discard claim once a second user message lands in the turn', () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 's1', userId: 1, model: 'm' });
    const echo = { persistText: 'the steered message', displayText: 'the steered message', publish: true };
    const live = {
      sessionId: 's1',
      lastAdmitted: { durableId: 'u1', text: 'the first message' },
      turnProducedOutput: false,
      replay: { publish: () => {}, journal: () => {} },
    } as unknown as LiveBrain;

    stageDeliveredUserEchoes(live, [{ text: 'the steered message', queuedText: 'pi text', echo }]);
    expect(deliverQueuedUserEcho(store, live, 'pi text')).toBe(true);

    expect(live.lastAdmitted).toBeUndefined();
  });

  it('leaves the discard claim alone when nothing was delivered', () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 's1', userId: 1, model: 'm' });
    const admitted = { durableId: 'u1', text: 'the first message' };
    const live = {
      sessionId: 's1', lastAdmitted: admitted,
      replay: { publish: () => {}, journal: () => {} },
    } as unknown as LiveBrain;

    // An ordinary prompt message_start, not a queued delivery — the turn is still discardable as a unit.
    expect(deliverQueuedUserEcho(store, live, 'something never staged')).toBe(false);
    expect(live.lastAdmitted).toBe(admitted);
  });
});
