import { describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { IdleCompactionSweep, type IdleCompactableLive } from '../../src/brain/service/idleCompactionSweep.js';
import type { IdleCompactionAssessment } from '../../src/brain/session/idleCompaction.js';

const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);
/** SQLite-shaped UTC timestamp `agoMs` before NOW (matches brain_messages.created_at). */
const sqliteTs = (agoMs: number): string => new Date(NOW - agoMs).toISOString().replace('T', ' ').slice(0, 19);
const MIN = 60_000;

/** Long-retention gate is cacheTtl (60 min) + 1 min = 61 min; comfortably past it. */
const COLD_AGO = 62 * MIN;

const ELIGIBLE: IdleCompactionAssessment = { eligible: true, contextTokens: 200_000, floorTokens: 40_000 };

function fakeSession(over: Partial<{ isStreaming: boolean; isCompacting: boolean; compact: () => Promise<void> }> = {}) {
  return {
    isStreaming: false,
    isCompacting: false,
    compact: vi.fn(async () => {}),
    getContextUsage: () => undefined,
    messages: [],
    ...over,
  } as unknown as AgentSession & { compact: ReturnType<typeof vi.fn> };
}

/** One live session with mutable sweep-relevant state, wired into a sweep with injectable env. */
function harness(over: {
  lastMessageAgoMs?: number;
  interactedAt?: number;
  stableClient?: boolean;
  activeChildren?: boolean;
  pendingElicitation?: boolean;
  assessment?: IdleCompactionAssessment | undefined;
  env?: NodeJS.ProcessEnv;
  session?: ReturnType<typeof fakeSession>;
  onLockAcquired?: () => void;
} = {}) {
  const session = over.session ?? fakeSession();
  const state = {
    lastMessageAt: sqliteTs(over.lastMessageAgoMs ?? COLD_AGO) as string | undefined,
    stableClient: over.stableClient ?? true,
    activeChildren: over.activeChildren ?? false,
    pendingElicitation: over.pendingElicitation ?? false,
    live: true,
  };
  const entry: IdleCompactableLive = {
    session,
    ...(over.interactedAt !== undefined ? { interactedAt: over.interactedAt } : {}),
    ...('assessment' in over && over.assessment === undefined ? {} : { assessIdleCompaction: () => over.assessment ?? ELIGIBLE }),
  };
  const sweep = new IdleCompactionSweep({
    liveEntries: () => [['s1', entry]],
    live: (id) => (id === 's1' && state.live ? entry : undefined),
    lastMessageAt: () => state.lastMessageAt,
    hasLiveStableClient: () => state.stableClient,
    hasActiveChildren: () => state.activeChildren,
    hasPendingElicitation: () => state.pendingElicitation,
    withLock: async (_key, fn) => { over.onLockAcquired?.(); return fn(); },
    env: over.env ?? ({ PI_CACHE_RETENTION: 'long' } as NodeJS.ProcessEnv),
  });
  return { sweep, session, state };
}

describe('IdleCompactionSweep', () => {
  it('compacts an open-terminal conversation once the cold-cache gate has provably passed', async () => {
    const { sweep, session } = harness();
    await expect(sweep.run(NOW)).resolves.toEqual(['s1']);
    expect(session.compact).toHaveBeenCalledOnce();
  });

  it('never fires while the prompt cache could still be warm', async () => {
    // 60 min idle: the 1 h TTL may just have run out, but the shared gate demands TTL + 1 min —
    // rewriting history a minute early would throw away a prefix a returning user could still hit.
    const { sweep, session } = harness({ lastMessageAgoMs: 60 * MIN });
    await expect(sweep.run(NOW)).resolves.toEqual([]);
    expect(session.compact).not.toHaveBeenCalled();
  });

  it('derives the gate from the SAME cache-retention env pi-ai reads (5-min regime included)', async () => {
    // Short retention: TTL 5 min + 1 min buffer = 6 min. Seven minutes idle is cold there but would be
    // far inside the warm window under long retention — proving the gate follows cacheTiming, not a
    // hardcoded hour.
    const short = harness({ lastMessageAgoMs: 7 * MIN, env: {} as NodeJS.ProcessEnv });
    await expect(short.sweep.run(NOW)).resolves.toEqual(['s1']);
    const long = harness({ lastMessageAgoMs: 7 * MIN });
    await expect(long.sweep.run(NOW)).resolves.toEqual([]);
  });

  it('fires at most once per idle epoch — the gate stays open after a compaction, the latch must hold', async () => {
    // A compaction pins the summary timestamp to the oldest kept row, so lastMessageAt does NOT advance
    // and every later tick still sees the gate open. Without the latch this loops at full cost per tick.
    const { sweep, session } = harness();
    await sweep.run(NOW);
    await sweep.run(NOW + MIN);
    await sweep.run(NOW + 2 * MIN);
    expect(session.compact).toHaveBeenCalledOnce();
  });

  it('re-arms after a new turn and a fresh idle epoch', async () => {
    const { sweep, session, state } = harness();
    await sweep.run(NOW);
    expect(session.compact).toHaveBeenCalledOnce();
    // A new turn lands 10 min later; another cold idle period follows.
    const turnAt = NOW + 10 * MIN;
    state.lastMessageAt = new Date(turnAt).toISOString().replace('T', ' ').slice(0, 19);
    await sweep.run(turnAt + MIN); // fresh epoch, still warm — nothing
    expect(session.compact).toHaveBeenCalledOnce();
    await sweep.run(turnAt + COLD_AGO);
    expect(session.compact).toHaveBeenCalledTimes(2);
  });

  it('leaves conversations without an open terminal alone — their next message rolls them over anyway', async () => {
    const { sweep, session } = harness({ stableClient: false });
    await expect(sweep.run(NOW)).resolves.toEqual([]);
    expect(session.compact).not.toHaveBeenCalled();
  });

  it('leaves a parent with a running background delegate alone', async () => {
    const { sweep, session } = harness({ activeChildren: true });
    await sweep.run(NOW);
    expect(session.compact).not.toHaveBeenCalled();
  });

  it('skips a session whose parked question holds the serial lock', async () => {
    const { sweep, session } = harness({ pendingElicitation: true });
    await sweep.run(NOW);
    expect(session.compact).not.toHaveBeenCalled();
  });

  it('skips a streaming or already-compacting session', async () => {
    const streaming = harness({ session: fakeSession({ isStreaming: true }) });
    await streaming.sweep.run(NOW);
    expect(streaming.session.compact).not.toHaveBeenCalled();
    const compacting = harness({ session: fakeSession({ isCompacting: true }) });
    await compacting.sweep.run(NOW);
    expect(compacting.session.compact).not.toHaveBeenCalled();
  });

  it('honors an ineligible assessment (breaker / toggle / too small) without spending a request', async () => {
    const { sweep, session } = harness({ assessment: { eligible: false, reason: 'breaker' } });
    await sweep.run(NOW);
    expect(session.compact).not.toHaveBeenCalled();
  });

  it('does nothing for a live without the factory seam (hand-built fakes, older paths)', async () => {
    const { sweep, session } = harness({ assessment: undefined });
    await sweep.run(NOW);
    expect(session.compact).not.toHaveBeenCalled();
  });

  it('a recent explicit interaction (resume) shields an old conversation', async () => {
    const { sweep, session } = harness({ interactedAt: NOW - MIN });
    await sweep.run(NOW);
    expect(session.compact).not.toHaveBeenCalled();
  });

  it('re-checks under the session lock: a turn that landed while the sweep waited cancels the decision', async () => {
    // Simulate a send that grabbed the lock first and finished a turn: by the time the sweep's lock
    // callback runs, lastMessageAt is fresh. The armed decision must be abandoned, not executed.
    const h = harness({
      onLockAcquired: () => { h.state.lastMessageAt = new Date(NOW).toISOString().replace('T', ' ').slice(0, 19); },
    });
    await expect(h.sweep.run(NOW)).resolves.toEqual([]);
    expect(h.session.compact).not.toHaveBeenCalled();
  });

  it('a session disposed while the sweep waited is skipped, not compacted', async () => {
    const h = harness({ onLockAcquired: () => { h.state.live = false; } });
    await h.sweep.run(NOW);
    expect(h.session.compact).not.toHaveBeenCalled();
  });

  it('a failed summarization neither throws out of the sweep nor retries within the epoch', async () => {
    const session = fakeSession({ compact: vi.fn(async () => { throw new Error('summarization failed'); }) as never });
    const { sweep } = harness({ session });
    await expect(sweep.run(NOW)).resolves.toEqual([]);
    await sweep.run(NOW + MIN);
    expect(session.compact).toHaveBeenCalledOnce(); // one doomed attempt per epoch, never a per-tick loop
  });

  it('PI’s "nothing to compact" no-op is benign and still latches the epoch', async () => {
    const session = fakeSession({ compact: vi.fn(async () => { throw new Error('Nothing to compact yet'); }) as never });
    const { sweep } = harness({ session });
    await expect(sweep.run(NOW)).resolves.toEqual([]); // compacted:false → not reported as compacted
    await sweep.run(NOW + MIN);
    expect(session.compact).toHaveBeenCalledOnce();
  });
});
