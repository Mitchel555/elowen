import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  recordSessionEvent, drainSessionNotices,
  scheduleReasoningMarker, flushReasoningMarker, REASONING_MARKER_DEBOUNCE_MS,
} from '../../src/brain/service/sessionEvents.js';
import type { BrainStore, BrainSessionEvent, SessionEventKind } from '../../src/store/brainStore.js';
import type { LiveBrain } from '../../src/brain/session/liveBrain.js';
import type { BrainEvent } from '../../src/brain/events.js';

function fakeLive(published: BrainEvent[]): LiveBrain {
  return {
    sessionId: 's1',
    thinkingLabels: { low: 'Low', medium: 'Medium', high: 'High' },
    replay: { publish: (event: BrainEvent) => { published.push(event); } },
  } as unknown as LiveBrain;
}

/** `hasTurns: false` models a conversation nobody has spoken in yet (lastMessageAt returns undefined). */
function fakeStore(hasTurns = true): BrainStore & { appended: { kind: string; detail: string }[] } {
  let seq = 0;
  const appended: { kind: string; detail: string }[] = [];
  return {
    appended,
    lastMessageAt: () => (hasTurns ? '2026-07-16 09:00:00' : undefined),
    appendSessionEvent(_sessionId: string, kind: SessionEventKind, detail: string): BrainSessionEvent {
      seq += 1;
      appended.push({ kind, detail });
      return { id: `evt-${seq}`, kind, detail, at: `2026-07-16T09:0${seq}:00.000Z` };
    },
  } as unknown as BrainStore & { appended: { kind: string; detail: string }[] };
}

describe('recordSessionEvent', () => {
  it('persists the marker, publishes it live, and queues a one-shot model-facing notice', () => {
    const published: BrainEvent[] = [];
    const live = fakeLive(published);
    recordSessionEvent(fakeStore(), 's1', live, 'model', '  anthropic/claude  ');

    expect(published).toEqual([{ type: 'session-event', id: 'evt-1', kind: 'model', detail: 'anthropic/claude', at: '2026-07-16T09:01:00.000Z' }]);
    expect(live.pendingSessionNotices).toEqual(['switched your model to anthropic/claude']);
  });

  it('ignores a blank detail (nothing persisted, published or queued)', () => {
    const published: BrainEvent[] = [];
    const live = fakeLive(published);
    const store = fakeStore();
    recordSessionEvent(store, 's1', live, 'rename', '   ');
    expect(store.appended).toEqual([]);
    expect(published).toEqual([]);
    expect(live.pendingSessionNotices).toBeUndefined();
  });

  // Setting up a conversation before speaking in it is not a change to anything: the first prompt already
  // carries the chosen model/mode, so a marker above it would report history that never happened.
  it('records nothing in a conversation that has no turns yet', () => {
    const published: BrainEvent[] = [];
    const live = fakeLive(published);
    const store = fakeStore(false);
    recordSessionEvent(store, 's1', live, 'model', 'anthropic/claude');
    expect(store.appended).toEqual([]);
    expect(published).toEqual([]);
    expect(live.pendingSessionNotices).toBeUndefined();
  });

  // /cd — the agent is told its working directory once, when its session spawns, so without this marker
  // it keeps describing the directory it started in no matter where the tools are actually running.
  it('tells the agent the working directory moved', () => {
    const published: BrainEvent[] = [];
    const live = fakeLive(published);
    recordSessionEvent(fakeStore(), 's1', live, 'cwd', '/srv/api');

    expect(published).toEqual([{ type: 'session-event', id: 'evt-1', kind: 'cwd', detail: '/srv/api', at: '2026-07-16T09:01:00.000Z' }]);
    expect(live.pendingSessionNotices).toEqual(['changed the working directory to /srv/api']);
  });

  // Renaming from the picker: the marker must still be durable, but there is no stream and no agent to tell.
  it('persists the marker only when the conversation is not live', () => {
    const store = fakeStore();
    recordSessionEvent(store, 's1', undefined, 'rename', 'Marker demo');
    expect(store.appended).toEqual([{ kind: 'rename', detail: 'Marker demo' }]);
  });
});

// The reasoning-effort marker is DEBOUNCED: ctrl+r cycling fires one change per keypress, and the level
// itself applies immediately — only the visible marker waits until the level sat unchanged for the window,
// so a burst coalesces into one marker showing where the user settled.
describe('scheduleReasoningMarker', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('coalesces rapid cycling into ONE marker showing the settled level', () => {
    const published: BrainEvent[] = [];
    const live = fakeLive(published);
    const store = fakeStore();
    scheduleReasoningMarker(store, live, 'low', 'medium');
    scheduleReasoningMarker(store, live, 'medium', 'high');
    expect(store.appended).toEqual([]); // nothing lands per keypress
    vi.advanceTimersByTime(REASONING_MARKER_DEBOUNCE_MS);
    expect(store.appended).toEqual([{ kind: 'reasoning', detail: 'High' }]);
    expect(live.pendingSessionNotices).toEqual(['set your reasoning effort to High']);
    vi.advanceTimersByTime(60_000); // one settle, one marker — the timer is disarmed
    expect(store.appended).toHaveLength(1);
  });

  it('a single settled change emits exactly one marker', () => {
    const live = fakeLive([]);
    const store = fakeStore();
    scheduleReasoningMarker(store, live, 'low', 'high');
    vi.advanceTimersByTime(REASONING_MARKER_DEBOUNCE_MS);
    expect(store.appended).toEqual([{ kind: 'reasoning', detail: 'High' }]);
  });

  it('a change mid-window restarts the debounce and keeps the latest target', () => {
    const live = fakeLive([]);
    const store = fakeStore();
    scheduleReasoningMarker(store, live, 'low', 'medium');
    vi.advanceTimersByTime(REASONING_MARKER_DEBOUNCE_MS - 1);
    scheduleReasoningMarker(store, live, 'medium', 'high');
    vi.advanceTimersByTime(REASONING_MARKER_DEBOUNCE_MS - 1);
    expect(store.appended).toEqual([]); // the second change re-armed the full window
    vi.advanceTimersByTime(1);
    expect(store.appended).toEqual([{ kind: 'reasoning', detail: 'High' }]);
  });

  it('cycling back to the level the transcript already shows cancels the marker', () => {
    const live = fakeLive([]);
    const store = fakeStore();
    scheduleReasoningMarker(store, live, 'low', 'medium');
    scheduleReasoningMarker(store, live, 'medium', 'low');
    expect(live.pendingReasoningMarker).toBeUndefined();
    vi.advanceTimersByTime(60_000);
    expect(store.appended).toEqual([]); // full circle — nothing changed, nothing announced
  });

  it('flushReasoningMarker lands a pending marker immediately and disarms the timer (turn start)', () => {
    const live = fakeLive([]);
    const store = fakeStore();
    scheduleReasoningMarker(store, live, 'low', 'high');
    flushReasoningMarker(store, live);
    expect(store.appended).toEqual([{ kind: 'reasoning', detail: 'High' }]);
    vi.advanceTimersByTime(60_000);
    expect(store.appended).toHaveLength(1); // the settle timer must not fire a second marker
    flushReasoningMarker(store, live); // nothing pending — a plain no-op
    expect(store.appended).toHaveLength(1);
  });
});

// Prepare/commit (finding 7): the buffer must NOT be cleared until the caller confirms the prompt
// carrying the block actually reached the provider — the same contract drainPostCompactionContext uses.
// Clearing eagerly (the old one-shot shape) meant a failure between the drain and the prompt call left
// the visible marker in the transcript while the model was never told, and a notice queued concurrently
// (a settings save racing this turn's prompt assembly) was silently dropped.
describe('drainSessionNotices', () => {
  it('emits one <system-reminder> for the queued notices and leaves the buffer untouched until commit', () => {
    const live = { pendingSessionNotices: ['switched the work mode to Workflow', 'set your reasoning effort to high'] } as unknown as LiveBrain;
    const { block, commit } = drainSessionNotices(live);

    expect(block).toContain('<session-changes>');
    expect(block).toContain('- The user switched the work mode to Workflow.');
    expect(block).toContain('- The user set your reasoning effort to high.');
    expect(block).toContain('<instruction>');
    // Not cleared yet — a caller that never commits (a failed prompt) must see it again next time.
    expect(live.pendingSessionNotices).toEqual(['switched the work mode to Workflow', 'set your reasoning effort to high']);

    commit();
    expect(live.pendingSessionNotices).toEqual([]);
  });

  it('returns an empty block and a no-op commit when nothing is queued', () => {
    const live = {} as unknown as LiveBrain;
    const { block, commit } = drainSessionNotices(live);
    expect(block).toBe('');
    expect(() => commit()).not.toThrow();
  });

  it('a failed/aborted turn that never commits leaves the notices intact for the next attempt', () => {
    const live = { pendingSessionNotices: ['switched your model to anthropic/claude'] } as unknown as LiveBrain;
    const { block } = drainSessionNotices(live); // prepared for a prompt that then throws — commit is never called
    expect(block).toContain('switched your model to anthropic/claude');

    const second = drainSessionNotices(live); // the next attempt sees the SAME notice, not an empty buffer
    expect(second.block).toContain('switched your model to anthropic/claude');
    second.commit();
    expect(live.pendingSessionNotices).toEqual([]);
  });

  it('commit removes only the captured prefix — a notice queued concurrently (while the prompt is in flight) survives', () => {
    const live = { pendingSessionNotices: ['switched your model to anthropic/claude'] } as unknown as LiveBrain;
    const { commit } = drainSessionNotices(live);
    // A concurrent settings save queues a second notice AFTER this turn's snapshot was captured but
    // before its prompt delivery is confirmed.
    live.pendingSessionNotices!.push('switched the work mode to Plan');

    commit();

    expect(live.pendingSessionNotices).toEqual(['switched the work mode to Plan']);
  });
});
