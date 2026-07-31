import { describe, expect, it, vi } from 'vitest';
import { ConversationLifecycle } from '../../src/brain/service/lifecycle.js';
import { ClientAttachments } from '../../src/brain/service/attachments.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { GoalLoopService } from '../../src/brain/service/goalLoop.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { SESSION_IDLE_ROLLOVER_MS } from '../../src/brain/session/idleRollover.js';
import type { LiveBrain, SpawnOpts } from '../../src/brain/session/liveBrain.js';

/** These four fixes (restart's session-identity race, listener ownership moving into ClientAttachments,
 *  the goal-zombie respawn gap and rollover's commit/rollback) are one interlocking area — see
 *  docs/plans/2026-07-27-review-synthesis.md Tier 1 #2/#3, Tier 2 #12, and review-brain-core-sol.md
 *  findings 1, 4, 5, 6. */

function live(spec: { model: string; sessionId: string }): LiveBrain {
  return {
    session: { dispose: vi.fn(), isStreaming: false } as never,
    sessionId: spec.sessionId,
    model: spec.model,
    requestProfile: { fast: false },
    fastAvailable: false,
    thinkingLabels: {},
    policy: { allowedProjectIds: 'all', allowedPaths: () => [] },
    listeners: new Set(),
    replay: { publish: vi.fn() } as never,
    turnContext: () => ({ beforeUser: '', afterUser: '' }),
    pluginToolNames: new Set(),
  } as LiveBrain;
}

/** A real BrainStore + real GoalLoopService, wired the same way brainService.ts wires them (the goal
 *  loop drives itself back through the lifecycle via late-bound thunks), so a respawn's goal handling is
 *  exercised through the genuine collaboration rather than a stub. `send` is the only piece the tests
 *  observe or trigger directly — it stands in for BrainService.send. */
function harness(spawn: (opts: SpawnOpts) => Promise<LiveBrain>) {
  const sessions = new LiveSessionRegistry<LiveBrain>();
  const attachments = new ClientAttachments();
  const store = new BrainStore(openDb(':memory:'));
  store.createSession({ id: 'brain-1', userId: 1, title: 'T', model: 'm' });
  store.createSession({ id: 'brain-2', userId: 1, title: 'T2', model: 'm' });

  const send = vi.fn(async () => {});
  let lifecycle!: ConversationLifecycle;
  const goals = new GoalLoopService({
    store,
    ownedUserSession: (userId, sessionId) => lifecycle.ownedUserSession(userId, sessionId),
    activeSessionId: (userId) => lifecycle.activeSessionId(userId),
    attachedCount: (sessionId) => attachments.attachedCount(sessionId),
    ensureLive: (userId, sessionId, o) => lifecycle.ensureLive(userId, sessionId, o),
    start: async (userId) => ({ sessionId: lifecycle.activeSessionId(userId) }),
    send,
    defaultTurnBudget: () => 8,
    goalMaxTurns: () => 64,
    isYolo: () => false,
    publishGoal: () => {},
  });
  lifecycle = new ConversationLifecycle({
    store,
    sessions,
    attachments,
    elicitation: { cancelForSession: vi.fn() },
    goals,
    spawn,
    policy: () => ({ allowedProjectIds: 'all', allowedPaths: () => [] }),
    userSettings: () => ({ autoCompact: false, autoCompactAt: 80 }),
    selectionAllowed: () => true,
  } as never);
  return { sessions, attachments, store, goals, lifecycle, send };
}

describe('restart() targets exactly the session it captured (sol finding 1 / synthesis Tier 1 #2)', () => {
  it('never disposes or respawns a session the active pointer moved to while restart awaited settlement', async () => {
    const spawnedIds: string[] = [];
    const spawn = vi.fn(async (o: SpawnOpts) => {
      spawnedIds.push(o.sessionId);
      return live({ model: 'respawned', sessionId: o.sessionId });
    });
    const { sessions, lifecycle } = harness(spawn);

    const original = live({ model: 'model-a', sessionId: 'brain-1' });
    sessions.set('brain-1', original);
    sessions.setActive(1, 'brain-1');

    // Hold the session lock — simulates an in-flight turn (turnRunner holds serial(sessionId) across the
    // whole prompt()) so restart's `await settled(sessionId)` genuinely parks.
    let releaseTurn!: () => void;
    const heldLock = new Promise<void>((resolve) => { releaseTurn = resolve; });
    sessions.withLock('brain-1', () => heldLock);

    const restartPromise = lifecycle.restart(1);
    await Promise.resolve(); await Promise.resolve(); // let restart reach the settled() await

    // While restart is waiting, the user switches to a brand-new conversation.
    const other = live({ model: 'model-b', sessionId: 'brain-2' });
    sessions.set('brain-2', other);
    sessions.setActive(1, 'brain-2');

    releaseTurn();
    await restartPromise;

    // The session the active pointer moved to must be completely untouched.
    expect(other.session.dispose).not.toHaveBeenCalled();
    expect(sessions.get('brain-2')).toBe(other);
    expect(spawnedIds).not.toContain('brain-2');

    // The captured session is the one restart() actually respawns, exactly once.
    expect(original.session.dispose).toHaveBeenCalledTimes(1);
    expect(spawnedIds).toEqual(['brain-1']);

    // The active pointer stays exactly where the user left it — restart never touches it.
    expect(sessions.activeIdFor(1)).toBe('brain-2');
  });

  it('no-ops instead of tearing down whatever won the race, when the captured session itself was replaced during the await', async () => {
    const spawn = vi.fn(async (o: SpawnOpts) => live({ model: 'irrelevant', sessionId: o.sessionId }));
    const { sessions, lifecycle } = harness(spawn);

    const original = live({ model: 'model-a', sessionId: 'brain-1' });
    sessions.set('brain-1', original);
    sessions.setActive(1, 'brain-1');

    let releaseTurn!: () => void;
    const heldLock = new Promise<void>((resolve) => { releaseTurn = resolve; });
    sessions.withLock('brain-1', () => heldLock);

    const restartPromise = lifecycle.restart(1);
    await Promise.resolve(); await Promise.resolve();

    // A concurrent respawn (e.g. a model switch) replaces 'brain-1' with a NEW instance under the SAME
    // id while restart is still waiting for the turn to settle.
    const replacement = live({ model: 'model-b', sessionId: 'brain-1' });
    sessions.set('brain-1', replacement);

    releaseTurn();
    await restartPromise;

    expect(replacement.session.dispose).not.toHaveBeenCalled();
    expect(sessions.get('brain-1')).toBe(replacement);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('goal survives a same-id respawn instead of becoming a zombie (sol finding 5 / synthesis Tier 2 #12)', () => {
  it('restart suspends the continuation and reschedules it after a successful respawn', async () => {
    vi.useFakeTimers();
    try {
      const spawn = vi.fn(async (o: SpawnOpts) => live({ model: 'm', sessionId: o.sessionId }));
      const { sessions, lifecycle, store, send } = harness(spawn);
      sessions.set('brain-1', live({ model: 'model-a', sessionId: 'brain-1' }));
      sessions.setActive(1, 'brain-1');
      store.upsertGoal({ sessionId: 'brain-1', userId: 1, goal: 'Keep going', turnBudget: 8 });

      await lifecycle.restart(1);

      // Still active — a respawn is not a stop, and the idle reaper only ever cleans up a zombie because
      // the row stays 'active' with nothing driving it.
      expect(store.getGoal('brain-1')!.status).toBe('active');

      // A driver was actually rescheduled, not just "still active on paper".
      await vi.advanceTimersByTimeAsync(200);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        session: 'brain-1', internal: { kind: 'goalContinue' },
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('a definitive stop pauses an active goal with a reason instead of leaving it active with no driver', () => {
    const spawn = vi.fn(async (o: SpawnOpts) => live({ model: 'm', sessionId: o.sessionId }));
    const { sessions, lifecycle, store } = harness(spawn);
    sessions.set('brain-1', live({ model: 'model-a', sessionId: 'brain-1' }));
    sessions.setActive(1, 'brain-1');
    store.upsertGoal({ sessionId: 'brain-1', userId: 1, goal: 'Keep going', turnBudget: 8 });

    lifecycle.stop(1);

    const g = store.getGoal('brain-1')!;
    expect(g.status).toBe('paused');
    expect(g.paused_reason).toContain('session stopped');
  });

  it('an unrecoverable respawn failure pauses the goal with the error as the reason', async () => {
    const spawn = vi.fn(async () => { throw new Error('provider unavailable'); });
    const { sessions, lifecycle, store } = harness(spawn);
    sessions.set('brain-1', live({ model: 'model-a', sessionId: 'brain-1' }));
    sessions.setActive(1, 'brain-1');
    store.upsertGoal({ sessionId: 'brain-1', userId: 1, goal: 'Keep going', turnBudget: 8 });

    await expect(lifecycle.restart(1)).rejects.toThrow('provider unavailable');

    const g = store.getGoal('brain-1')!;
    expect(g.status).toBe('paused');
    expect(g.last_verdict).toBe('error');
    expect(g.paused_reason).toBe('provider unavailable');
  });

  it('a goal with no continuation timer keeps the session out of the picture (no goal — nothing to zombie)', async () => {
    const spawn = vi.fn(async (o: SpawnOpts) => live({ model: 'm', sessionId: o.sessionId }));
    const { sessions, lifecycle, store } = harness(spawn);
    sessions.set('brain-1', live({ model: 'model-a', sessionId: 'brain-1' }));
    sessions.setActive(1, 'brain-1');

    await lifecycle.restart(1); // no goal ever set — resumeAfterRespawn must be a no-op, not a throw
    expect(store.getGoal('brain-1')).toBeUndefined();
  });
});

/** A dedicated (lighter) harness for maybeRollover: no goal loop involved, and `store.lastMessageAt`
 *  needs to be old enough to clear the idle cutoff, which is easiest to control directly. */
function rolloverHarness(spawn: (opts: SpawnOpts) => Promise<LiveBrain>) {
  const sessions = new LiveSessionRegistry<LiveBrain>();
  const attachments = new ClientAttachments();
  const oldEnough = new Date(Date.now() - SESSION_IDLE_ROLLOVER_MS - 60_000).toISOString();
  const store = {
    getSession: (id: string) => ({ id, user_id: 1, work_dir: '' }),
    listSessions: () => [] as { id: string; user_id: number; work_dir?: string }[],
    lastMessageAt: () => oldEnough,
  };
  const lifecycle = new ConversationLifecycle({
    store,
    sessions,
    attachments,
    elicitation: { cancelForSession: vi.fn() },
    goals: { cancelGoalContinuation: vi.fn(), resumeAfterRespawn: vi.fn(), pauseForRespawnFailure: vi.fn() },
    spawn,
    policy: () => ({ allowedProjectIds: 'all', allowedPaths: () => [] }),
    userSettings: () => ({ autoCompact: false, autoCompactAt: 80 }),
    selectionAllowed: () => true,
  } as never);
  return { sessions, attachments, lifecycle };
}

describe('rollover is transactional when the spawn fails (sol finding 6 / synthesis Tier 1 #3 background)', () => {
  it('rolls the attachment retarget back onto the old id when the fresh spawn throws, instead of leaving the current client permanently dark', async () => {
    const spawn = vi.fn(async () => { throw new Error('provider unavailable'); });
    const { sessions, attachments, lifecycle } = rolloverHarness(spawn);
    const oldLive = live({ model: 'model-a', sessionId: 'brain-1' });
    sessions.set('brain-1', oldLive);
    sessions.setActive(1, 'brain-1');

    const listener = vi.fn();
    attachments.attach(1, 'brain-1', listener, vi.fn());

    await expect(lifecycle.maybeRollover(1, oldLive)).rejects.toThrow('provider unavailable');

    // setActive only ever runs after a successful respawn, so the pointer never moved off the old id.
    expect(sessions.activeIdFor(1)).toBe('brain-1');
    // The listener must resolve back to the OLD id — not a fresh id nothing will ever spawn into.
    expect(attachments.attachedCount('brain-1')).toBe(1);
    expect(attachments.attachedCount('brain-2')).toBe(0);
    // No stray fresh session was left registered (the old one was disposed, the new spawn never completed).
    expect(sessions.liveEntries()).toHaveLength(0);
  });

  it('carries no prompt/cadence state on a successful rollover — a fresh conversation starts clean', async () => {
    let fresh!: LiveBrain;
    const spawn = vi.fn(async (o: SpawnOpts) => { fresh = live({ model: 'model-a', sessionId: o.sessionId }); return fresh; });
    const { sessions, lifecycle } = rolloverHarness(spawn);
    const oldLive = live({ model: 'model-a', sessionId: 'brain-1' });
    oldLive.lastTurnMode = 'plan';
    oldLive.orientedForCompaction = 'divider-1';
    oldLive.modeReminderTurns = 3;
    sessions.set('brain-1', oldLive);
    sessions.setActive(1, 'brain-1');

    const result = await lifecycle.maybeRollover(1, oldLive);

    expect(result.sessionId).not.toBe('brain-1');
    expect(result).toBe(fresh);
    expect(result.lastTurnMode).toBeUndefined();
    expect(result.orientedForCompaction).toBeUndefined();
    expect(result.modeReminderTurns).toBeUndefined();
  });
});
