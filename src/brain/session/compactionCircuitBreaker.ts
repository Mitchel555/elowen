import type { AgentSessionEvent, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { logger } from '../../shared/logger.js';

const log = logger('brain-compaction');

/** What triggered a compaction, as PI reports it on both `session_before_compact` and `compaction_end`. */
type CompactionReason = 'manual' | 'threshold' | 'overflow';

/** Consecutive failed AUTOMATIC compactions after which a session stops attempting them.
 *
 *  A context that cannot be summarized fails identically on every retry — one tool result that alone
 *  exceeds the window, a summary the model refuses — and PI re-checks the threshold after every single
 *  turn. Without a stop, each following turn spends one summarization request that cannot succeed, for
 *  the rest of the session's life. Claude Code measured exactly this failure mode at fleet scale before
 *  adding the same guard.
 *
 *  Three is high enough that a transient provider failure never trips it — PI's own retry budget is
 *  already spent INSIDE each one of those three attempts, so three failures mean three exhausted retry
 *  chains — and low enough that an irrecoverable session wastes three calls rather than thousands. Kept
 *  as the DEFAULT of the operator-tunable `compactionFailureLimit` knob (Elowen AI → Limits). */
export const DEFAULT_COMPACTION_FAILURE_LIMIT = 3;

/** The limit in force, resolved live — the same module-level-resolver seam `toolResultClearing` uses for
 *  its spill thresholds. Injected once at bootstrap; defaults to {@link DEFAULT_COMPACTION_FAILURE_LIMIT}
 *  so tests and any un-wired path keep the historical behaviour. */
let compactionFailureLimit: () => number = () => DEFAULT_COMPACTION_FAILURE_LIMIT;
export function setCompactionFailureLimit(resolve: () => number): void { compactionFailureLimit = resolve; }

/** Read per compaction outcome, never cached at spawn, so a Limits change reaches sessions that are
 *  already running. Floored at 1 at the point of use: a stored 0 would trip the breaker before a session
 *  had attempted anything, turning a tuning knob into "never compact automatically". */
function failureLimit(): number {
  return Math.max(1, Math.round(compactionFailureLimit()));
}

/** What the user is told when the breaker trips. The session cannot recover on its own from here, so
 *  this is a terminal condition they have to act on, not a transient status notice. */
export function compactionStoppedMessage(failures: number): string {
  return `Automatic context compaction failed ${failures} times in a row, so it has been stopped for this conversation — every further attempt would spend a model call that cannot succeed. This conversation can no longer shrink its own context: start a new one, or run /compact yourself once the oversized content is out of the way.`;
}

export interface CompactionCircuitBreakerOptions {
  sessionId: string;
  /** Reported ONCE per trip, so the user learns the conversation stopped managing its own context.
   *  Callers route it to whatever channel they already use for terminal session errors. */
  onTripped?: (message: string) => void;
}

export interface CompactionCircuitBreaker {
  /** Registers the cancel gate on PI's extension API (pass to the resource loader's factories). */
  extension: (pi: ExtensionAPI) => void;
  /** Feed PI's session event stream: this is what counts compaction outcomes. */
  observe: (event: AgentSessionEvent) => void;
  /** Whether a compaction with this reason is currently refused. The gate and the tests share this one
   *  rule instead of each restating the threshold. */
  blocks: (reason: CompactionReason) => boolean;
}

/** Stop a session from retrying a compaction that keeps failing.
 *
 *  Per-session state lives in this closure — the same pattern `toolResultClearing` uses for its latch —
 *  and holds nothing but counters, so it can never leak between sessions and never keeps a session
 *  object (or its messages) alive once the session itself is dropped. */
export function createCompactionCircuitBreaker(options: CompactionCircuitBreakerOptions): CompactionCircuitBreaker {
  let consecutiveFailures = 0;
  /** A compaction attempt is in flight (PI emitted `compaction_start`). PI also reports exhausted
   *  overflow recovery as a bare `compaction_end` with no attempt behind it; that one spent nothing and
   *  must not count against the budget. */
  let attemptStarted = false;
  let reported = false;

  const tripped = (): boolean => consecutiveFailures >= failureLimit();

  const blocks = (reason: CompactionReason): boolean => reason !== 'manual' && tripped();

  const extension = (pi: ExtensionAPI): void => {
    // A manual /compact is never refused: it is the user's own recovery lever, and succeeding with it
    // resets the counter. Only the attempts PI repeats unattended are stopped.
    pi.on('session_before_compact', (event) => (blocks(event.reason) ? { cancel: true } : undefined));
  };

  const observe = (event: AgentSessionEvent): void => {
    if (event.type === 'compaction_start') {
      attemptStarted = true;
      return;
    }
    if (event.type !== 'compaction_end') return;
    const started = attemptStarted;
    attemptStarted = false;
    // `aborted` covers both the user cancelling and this breaker's own cancel — neither is evidence that
    // compaction cannot work, so neither moves the counter.
    if (event.aborted) return;
    if (event.result != null) {
      consecutiveFailures = 0;
      reported = false;
      return;
    }
    if (!started) return;
    consecutiveFailures += 1;
    // Below the limit the session is free again — including after an operator RAISED the limit past a
    // count that had already tripped it, which must be able to trip (and report) a second time.
    if (!tripped()) { reported = false; return; }
    if (reported) return;
    reported = true;
    log.warn(`compaction failed ${consecutiveFailures} times in a row on ${options.sessionId}; automatic compaction is now stopped for this session`);
    options.onTripped?.(compactionStoppedMessage(consecutiveFailures));
  };

  return { extension, observe, blocks };
}
