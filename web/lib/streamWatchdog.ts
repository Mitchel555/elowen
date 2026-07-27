'use client';

/** No frame at all for this long, on a page the user is looking at, means the stream is dead: the daemon
 *  heartbeats every 30 s regardless of activity, so this is two and a half missed beats. */
export const SILENCE_LIMIT_MS = 75_000;
/** How stale a stream may be at a wake-up before it is reconnected without waiting for the watchdog. A
 *  frozen page runs no timers, so the tick that should have caught this never happened. */
export const REVIVE_SILENCE_LIMIT_MS = 45_000;
/** Poll granularity: the silence is detected within this much of the limit. */
const CHECK_INTERVAL_MS = 5_000;

export interface StreamWatchdogOptions {
  /** When the last frame (event OR heartbeat) arrived, as a wall-clock timestamp. */
  lastFrameAt: () => number;
  /** The stream has gone silent — close it and reconnect. */
  onSilent: () => void;
  now?: () => number;
  hidden?: () => boolean;
  limitMs?: number;
  intervalMs?: number;
}

/** Watch a stream for silence and report it. Returns the stop function.
 *
 *  The check is always made against the wall clock, never against how often the interval fired: mobile
 *  browsers freeze timers on a locked phone, so a tick count says nothing about elapsed time. For the same
 *  reason a hidden page is skipped entirely — its timers are unreliable and its stream is expected to be
 *  idle; the wake-up path re-reads the clock instead. */
export function startStreamWatchdog(opts: StreamWatchdogOptions): () => void {
  const now = opts.now ?? (() => Date.now());
  const hidden = opts.hidden ?? (() => document.visibilityState === 'hidden');
  const limitMs = opts.limitMs ?? SILENCE_LIMIT_MS;
  const timer = setInterval(() => {
    if (hidden()) return;
    if (now() - opts.lastFrameAt() > limitMs) opts.onSilent();
  }, opts.intervalMs ?? CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}
