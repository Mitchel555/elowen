import { monitorEventLoopDelay } from 'node:perf_hooks';

/** Event loop delay percentiles in MILLISECONDS, over the current sampling window. */
export interface LoopLag {
  p50: number;
  p99: number;
  max: number;
}

export interface LoopLagMonitor {
  /** Percentiles since the window last rolled. */
  lag(): LoopLag;
  /** Stop sampling and release the timer. */
  stop(): void;
}

/** How long a sampling window lasts before the histogram is cleared. Percentiles that accumulate since
 *  process start are useless for "is it starving RIGHT NOW": one bad minute during a fan-out would keep
 *  p99 high for days afterwards, and a daemon that has been up a week would never show a fresh spike. */
const WINDOW_MS = 60_000;

/** Sampling interval, and therefore the FLOOR of every reading: the histogram records the interval it
 *  actually observed, so an idle loop reports ~`RESOLUTION_MS`, not zero (measured: resolution 1 → idle
 *  p50 1.1 ms, resolution 20 → 20.2 ms). It is set to 1 ms so the numbers stay comparable with the ~1 ms
 *  `/health` round-trip; a coarser sampler would report 20 ms on a perfectly healthy daemon and make
 *  every threshold meaningless. The timer is native (libuv), so the cost is not the JS-side one it looks
 *  like. */
const RESOLUTION_MS = 1;

const toMs = (nanos: number): number => (Number.isFinite(nanos) ? Math.round(nanos / 1e5) / 10 : 0);

/** Measure how late the event loop runs its own timers — the one number that says whether this process
 *  is keeping up. It is what distinguishes "the provider is slow" from "we never got round to reading
 *  the response", which is invisible from every other metric the daemon reports.
 *
 *  The window rolls on a timer rather than on read, so that two readers cannot clear each other's data
 *  and a scrape does not change what the next scrape sees. */
/** Sustained p99 above this means the loop is not keeping up: callbacks are waiting a tenth of a second
 *  for their turn, which is already visible as a sluggish CLI and web UI. */
const SUSTAINED_P99_MS = 150;

/** Log when the loop starts and stops keeping up. Only the TRANSITIONS are logged — a fan-out that
 *  saturates the daemon for ten minutes should leave two lines, not one per check, or the signal drowns
 *  in the noise it generates. Returns a stop function. */
export function watchLoopLag(
  monitor: LoopLagMonitor,
  log: { warn(m: string): void; info(m: string): void },
  opts: { checkMs?: number; thresholdMs?: number } = {},
): () => void {
  const threshold = opts.thresholdMs ?? SUSTAINED_P99_MS;
  let saturated = false;
  const timer = setInterval(() => {
    const { p50, p99, max } = monitor.lag();
    if (p99 > threshold && !saturated) {
      saturated = true;
      log.warn(`event loop is not keeping up — p50 ${p50}ms, p99 ${p99}ms, max ${max}ms (interactive requests are queueing behind other work)`);
    } else if (p99 <= threshold && saturated) {
      saturated = false;
      log.info(`event loop recovered — p50 ${p50}ms, p99 ${p99}ms`);
    }
  }, opts.checkMs ?? 30_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function startLoopLagMonitor(windowMs = WINDOW_MS): LoopLagMonitor {
  const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  histogram.enable();
  const roll = setInterval(() => histogram.reset(), windowMs);
  // Never hold the process open for a metric — a daemon shutting down must not wait for this.
  roll.unref?.();
  return {
    lag: () => ({
      p50: toMs(histogram.percentile(50)),
      p99: toMs(histogram.percentile(99)),
      max: toMs(histogram.max),
    }),
    stop: () => {
      clearInterval(roll);
      histogram.disable();
    },
  };
}
