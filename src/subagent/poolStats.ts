/** What `/health` reports about the sub-agent pool.
 *
 *  Its own module so the API layer can name the shape without importing the pool implementation (and with
 *  it `node:child_process`) into the route graph. A saturated pool must be VISIBLE: without these numbers
 *  "delegations feel slow" and "delegations are queued behind a 30-node workflow" look identical from
 *  outside, which is exactly the mystery the event-loop block next to it was added to end. */
/** Not exported: it is only ever reached through {@link SubagentPoolStats}, and a second public name for
 *  one shape is a second thing to keep in step. */
interface SubagentPoolRunnerStats {
  /** The child's pid — the handle an operator can actually `top`. Null before the fork completes. */
  pid: number | null;
  /** Channels routed to this runner: the sessions it owns for their lifetime. */
  sessions: number;
  /** Turns placed here and not yet settled — the pool's own exact count, not the heartbeat's. */
  activeTurns: number;
  /** Last reported resident size, or null before the first heartbeat. */
  rssBytes: number | null;
  /** Last reported event-loop p99 in ms, or null before the first heartbeat. */
  loopP99Ms: number | null;
  /** Whether the pool currently counts this runner as at its comfort line. */
  saturated: boolean;
}

export interface SubagentPoolStats {
  /** `in-process` when the cap is 0 — the pool is off and every delegated turn runs on the daemon. */
  mode: 'runner' | 'in-process';
  /** The effective cap: the lower of the CPU and memory ceilings, then the operator's knob. */
  cap: number;
  cpuCap: number;
  memCap: number;
  /** The per-runner resident size the memory ceiling was derived from. */
  runnerRssBytes: number;
  /** False while that figure is still the conservative estimate rather than a live measurement. */
  measuredRunnerRss: boolean;
  /** True when the operator's knob, not the machine, decided the cap. */
  operatorCapped: boolean;
  /** Turns admitted but not yet placed. Non-zero means the pool is time-sharing, not stuck. */
  queueDepth: number;
  /** How long the longest-waiting turn has been queued, in ms. 0 when nothing is queued. */
  oldestQueuedMs: number;
  /** Why the most recent fork failed, cleared as soon as one succeeds — null in the healthy case.
   *
   *  `mode` alone cannot express this: it reports the CONFIGURATION, so a pool whose every spawn is being
   *  refused still reads `runner` with an empty `runners` list, which is byte for byte what an idle pool
   *  with nothing to do looks like. That is not hypothetical — a daemon running an older build than the
   *  one in `dist/` has every fork rejected on the build-id handshake and silently serves every delegated
   *  turn in-process, which is precisely the state an operator comes to `/health` to rule out. */
  spawnFailure: { reason: string; agoMs: number; consecutive: number } | null;
  runners: SubagentPoolRunnerStats[];
}
