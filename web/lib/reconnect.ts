'use client';

/** A single, serialized way back onto a dropped stream. Every recovery path — a page wake-up, the silence
 *  watchdog, a server error frame, a socket close — funnels through ONE controller per stream, so a phone
 *  unlock (which fires all of them at once) produces exactly one reconnect instead of a race between
 *  several, each claiming its own generation. */
export interface ReconnectController {
  /** Reconnect immediately, unless an attempt is already scheduled or running. */
  now(): void;
  /** Reconnect after the next backoff delay, unless an attempt is already scheduled or running. */
  retry(): void;
  /** The stream is healthy again (first frame received) — start the backoff over. */
  succeeded(): void;
  /** Teardown: cancel anything pending and refuse every later trigger. */
  stop(): void;
}

export interface ReconnectOptions {
  /** First backoff window; doubles per attempt. */
  baseMs?: number;
  /** Ceiling of the backoff window. */
  maxMs?: number;
  /** Injectable for tests. */
  random?: () => number;
  /** Notified true when a recovery attempt is in flight (scheduled or running) and false once the stream is
   *  healthy again or the controller stops — lets a surface show a "reconnecting" overlay without keeping
   *  its own copy of the busy bookkeeping. Fires only on a real change. It does NOT stay silent for the
   *  first connect: a snapshot that times out or errors on load is retried through this controller like any
   *  other, so a surface can show the overlay before the stream has ever been healthy. */
  onActive?: (active: boolean) => void;
}

const BASE_MS = 1_000;
const MAX_MS = 30_000;

/** `connect` may be async: the attempt counts as in flight until it settles, which is what keeps a slow
 *  reconnect from being started a second time. A rejected attempt schedules the next one itself, so a
 *  daemon that is still down is retried with backoff rather than leaving the stream dead for good. */
export function createReconnectController(connect: () => void | Promise<void>, opts: ReconnectOptions = {}): ReconnectController {
  const baseMs = opts.baseMs ?? BASE_MS;
  const maxMs = opts.maxMs ?? MAX_MS;
  const random = opts.random ?? Math.random;
  const onActive = opts.onActive;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let stopped = false;
  let active = false;

  const busy = (): boolean => stopped || running || timer !== null;
  const setActive = (v: boolean): void => { if (active === v) return; active = v; onActive?.(v); };

  const retry = (): void => {
    if (busy()) return;
    const window = Math.min(maxMs, baseMs * 2 ** attempt);
    attempt += 1;
    // Half the window plus jitter: several tabs waking together must not hammer the daemon in lockstep.
    timer = setTimeout(run, window / 2 + random() * (window / 2));
    setActive(true);
  };

  function run(): void {
    timer = null;
    if (stopped) return;
    running = true;
    void Promise.resolve().then(connect).then(
      () => { running = false; },
      () => { running = false; retry(); },
    );
  }

  return {
    now: () => { if (busy()) return; attempt += 1; setActive(true); run(); },
    retry,
    succeeded: () => { attempt = 0; setActive(false); },
    stop: () => { stopped = true; if (timer) { clearTimeout(timer); timer = null; } setActive(false); },
  };
}
