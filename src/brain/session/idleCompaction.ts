import { parseDbTs } from '../../shared/time.js';

/** Idle auto-compaction policy: the pure decision pieces behind IdleCompactionSweep (service/).
 *
 *  The sweep compacts a conversation once its prompt cache has PROVABLY expired (the shared
 *  `idleThresholdMs` gate from cacheTiming — the same gate toolResultClearing waits for). Timing it to
 *  the cache matters for one reason only: compaction rewrites the context, so running it while the
 *  cached prefix is still warm would throw that prefix away and make a return-within-the-window pay a
 *  full re-cache it would not have paid. Once the cache is cold there is nothing left to lose, and the
 *  next turn — whenever it comes — re-caches the compacted context instead of the full history.
 *
 *  Deliberately NOT timed to "just before expiry": PI's summarization request never touches the
 *  conversation's cache in the first place (pi-coding-agent `completeSummarization` sends the serialized
 *  history as a standalone request with `cacheRetention: "none"` and a fresh sessionId), so firing early
 *  buys nothing and only forfeits the warm window. */

/** The floor under which an idle compaction is refused: summarizing must remove at least this many
 *  tokens beyond the post-compaction floor. The summarization request pays FULL input price on the
 *  whole serialized history (no cache read — see module doc), while the saving is the removed tokens'
 *  cache write on the next turn plus their cache read on every turn after; below ~30k removed the
 *  dollar saving is cents while the summary permanently loses conversational detail. */
export const IDLE_COMPACTION_MIN_SAVINGS_TOKENS = 30_000;

/** Whether an idle compaction can pay for itself. Two conditions, both required:
 *  - the removable part (context beyond the post-compaction floor) reaches the savings floor, and
 *  - the context is at least TWICE the floor — the summarization bills the whole context while only the
 *    part above the floor is removed, so a context dominated by its own floor spends a full-price
 *    request to shrink by a sliver. */
export function idleCompactionWorthwhile(contextTokens: number, floorTokens: number): boolean {
  return contextTokens >= 2 * floorTokens
    && contextTokens - floorTokens >= IDLE_COMPACTION_MIN_SAVINGS_TOKENS;
}

export type IdleCompactionAssessment =
  | { eligible: true; contextTokens: number; floorTokens: number }
  | { eligible: false; reason: 'auto-compact-off' | 'breaker' | 'too-small' };

/** The per-session facts the assessment needs, provided as thunks by the session factory (which owns
 *  the live proactive flag, the circuit breaker and the token estimates). Read at assessment time, not
 *  captured — a live settings change or a breaker trip must reach the very next sweep. */
export interface IdleCompactionInputs {
  /** The session's auto-compact toggle. Idle compaction is an AUTOMATIC compaction, so a user who
   *  switched auto-compact off must not get one from a timer either. */
  proactive(): boolean;
  /** Whether the compaction circuit breaker currently refuses automatic compaction — the same
   *  `blocks('threshold')` rule PI's own threshold attempts are gated on, so the idle trigger can
   *  never sneak past a tripped or provably-pointless state. */
  breakerBlocks(): boolean;
  /** Estimated current context tokens (provider-usage based, so it includes the fixed cost). */
  contextTokens(): number;
  /** Estimated post-compaction floor: fixed cost + summary allowance + retained tail. */
  floorTokens(): number;
}

export type AssessIdleCompaction = () => IdleCompactionAssessment;

export function assessIdleCompaction(inputs: IdleCompactionInputs): IdleCompactionAssessment {
  if (!inputs.proactive()) return { eligible: false, reason: 'auto-compact-off' };
  if (inputs.breakerBlocks()) return { eligible: false, reason: 'breaker' };
  const contextTokens = inputs.contextTokens();
  const floorTokens = inputs.floorTokens();
  if (!idleCompactionWorthwhile(contextTokens, floorTokens)) return { eligible: false, reason: 'too-small' };
  return { eligible: true, contextTokens, floorTokens };
}

/** A session's last activity in epoch ms — the newest stored message vs the user's last explicit
 *  interaction, the same pair rolloverDue keys on. 0 means no activity on record (never idle-compact). */
export function lastActivityMs(lastMessageAt: string | undefined, interactedAt: number | undefined): number {
  return Math.max(parseDbTs(lastMessageAt), interactedAt ?? 0);
}

/** One idle-compaction DECISION per idle epoch, keyed on the last-activity stamp the decision was made
 *  for. This is the loop guard: a successful compaction pins the summary's timestamp to the oldest kept
 *  row (compactSessionMessages), so lastMessageAt does NOT advance and the idle gate stays open — without
 *  the latch the sweep would re-fire every tick. Only a NEW turn (a new stamp) re-arms the session, and
 *  by then the context has genuinely changed, so re-assessing is correct. A declined decision latches the
 *  same way: nothing about the session changes while it idles, so re-assessing every tick is pure noise. */
export class IdleCompactionLatch {
  /** sessionId → the lastActivity stamp already decided on. */
  private decided = new Map<string, number>();

  decidedAlready(sessionId: string, lastActivity: number): boolean {
    return this.decided.get(sessionId) === lastActivity;
  }

  markDecided(sessionId: string, lastActivity: number): void {
    this.decided.set(sessionId, lastActivity);
  }

  /** Forget sessions no longer live so the map cannot grow for the daemon's lifetime. */
  sweep(liveIds: ReadonlySet<string>): void {
    for (const id of [...this.decided.keys()]) if (!liveIds.has(id)) this.decided.delete(id);
  }
}
