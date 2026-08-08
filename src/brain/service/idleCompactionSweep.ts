import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { logger } from '../../shared/logger.js';
import { runCompaction } from '../events.js';
import { idleThresholdMs } from '../session/cacheTiming.js';
import { IdleCompactionLatch, lastActivityMs, type AssessIdleCompaction } from '../session/idleCompaction.js';

const log = logger('brain-compaction');

/** The slice of a LiveBrain the sweep touches — structural, so tests drive it with small fakes. */
export interface IdleCompactableLive {
  session: AgentSession;
  interactedAt?: number;
  assessIdleCompaction?: AssessIdleCompaction;
}

export interface IdleCompactionSweepDeps {
  liveEntries(): readonly (readonly [string, IdleCompactableLive])[];
  /** Re-fetched under the session lock: the entry snapshot may have been disposed while the sweep
   *  awaited earlier sessions, and compacting a disposed runtime would throw into the log for nothing. */
  live(sessionId: string): IdleCompactableLive | undefined;
  lastMessageAt(sessionId: string): string | undefined;
  /** An open terminal bound to this conversation (ClientAttachments.hasLiveStableClient). This is the
   *  population idle compaction exists for: every other surface either rolls the conversation over on
   *  its next message after 30 idle minutes (web, Discord — compacting it would be pure waste) or is
   *  reaped from the live registry before the cache gate can even open (unwatched sessions). */
  hasLiveStableClient(sessionId: string): boolean;
  /** A background delegate still running for this conversation: its result delivery is imminent-ish and
   *  needs the parent's full context to integrate well, so the parent is left alone until it settles. */
  hasActiveChildren(sessionId: string): boolean;
  /** A parked AskUserQuestion HOLDS the session's serial lock — locking behind it would stall the whole
   *  sweep until the question times out, and rewriting the context under an open question is wrong anyway. */
  hasPendingElicitation(sessionId: string): boolean;
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** Injected for tests; defaults to process.env (the same env pi-ai reads its cache retention from). */
  env?: NodeJS.ProcessEnv;
}

/** Compact idle conversations once their prompt cache has PROVABLY expired.
 *
 *  Driven by the daemon's 60 s tick (bootstrap), like reapIdleLiveSessions. The gate is the shared
 *  `idleThresholdMs` (cache TTL + 1 min — the same bound toolResultClearing waits for before rewriting
 *  history): before it, compacting would throw away a warm cached prefix a returning user could still
 *  hit; after it, the cache is gone either way, so the summarization loses nothing and every later turn
 *  re-caches the compacted context instead of the full history. The summarization request itself never
 *  reads the conversation's cache at ANY time (PI sends it standalone with cacheRetention "none"), so
 *  there is no cheaper, earlier moment — see the idleCompaction module doc.
 *
 *  Guards, in order: the once-per-idle-epoch latch (the loop guard — a compaction does not advance
 *  lastMessageAt, so the gate stays open and only the latch stops a refire every tick), the surface
 *  predicate (open-terminal conversations only), the busy predicates, and the per-session assessment
 *  (auto-compact toggle, circuit breaker, worth-it floor) evaluated under the session lock. */
export class IdleCompactionSweep {
  private readonly latch = new IdleCompactionLatch();
  constructor(private d: IdleCompactionSweepDeps) {}

  async run(now: number = Date.now()): Promise<string[]> {
    const gateMs = idleThresholdMs(this.d.env ?? process.env);
    const compacted: string[] = [];
    const liveIds = new Set<string>();
    for (const [sessionId, entry] of this.d.liveEntries()) {
      liveIds.add(sessionId);
      const lastActivity = lastActivityMs(this.d.lastMessageAt(sessionId), entry.interactedAt);
      if (lastActivity === 0 || now - lastActivity < gateMs) continue;
      if (this.latch.decidedAlready(sessionId, lastActivity)) continue;
      if (!this.d.hasLiveStableClient(sessionId)) continue;
      if (this.d.hasActiveChildren(sessionId) || this.d.hasPendingElicitation(sessionId)) continue;
      if (entry.session.isStreaming || entry.session.isCompacting) continue;
      await this.d.withLock(sessionId, async () => {
        // Re-check under the lock: a turn may have run (or the session been disposed) while this sweep
        // waited. A fresh lastActivity means the epoch this decision was armed for no longer exists.
        const live = this.d.live(sessionId);
        if (!live || live.session.isStreaming) return;
        if (lastActivityMs(this.d.lastMessageAt(sessionId), live.interactedAt) !== lastActivity) return;

        if (this.latch.decidedAlready(sessionId, lastActivity)) return;
        // Latch BEFORE the attempt: one summarization request per idle epoch, success or failure — a
        // context that fails to summarize fails identically on an immediate retry (the breaker counts
        // the failure too, via its own session subscription).
        this.latch.markDecided(sessionId, lastActivity);
        const verdict = live.assessIdleCompaction?.();
        if (!verdict?.eligible) {
          if (verdict) log.info(`idle compaction skipped on ${sessionId}: ${verdict.reason}`);
          return;
        }
        try {
          const result = await runCompaction(live.session);
          if (result.compacted) {
            compacted.push(sessionId);
            log.info(`idle-compacted ${sessionId} (cache cold; est. ${verdict.contextTokens} → floor ~${verdict.floorTokens} tokens)`);
          }
        } catch (error) {
          log.warn(`idle compaction failed on ${sessionId}`, error);
        }
      });
    }
    this.latch.sweep(liveIds);
    return compacted;
  }
}
