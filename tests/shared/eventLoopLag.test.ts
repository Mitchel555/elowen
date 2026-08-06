import { describe, it, expect } from 'vitest';
import { startLoopLagMonitor, watchLoopLag, type LoopLag } from '../../src/shared/eventLoopLag.js';

/** Occupy the event loop synchronously for `ms`, the way a long CPU-bound callback does. */
const blockLoop = (ms: number) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* deliberately busy */ }
};

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('event loop lag monitor', () => {
  it('reports a low reading on an idle loop', async () => {
    const monitor = startLoopLagMonitor();
    await tick(120);
    const { p50, max } = monitor.lag();
    monitor.stop();
    // The sampler's own resolution is the floor of every reading, so this is "small", not "zero".
    expect(p50).toBeLessThan(5);
    expect(max).toBeLessThan(100);
  });

  // The whole point of the metric: work that hogs the loop must be visible. Without this the daemon
  // cannot tell a slow provider from a loop that never got round to reading the response.
  it('reports the delay when the loop is blocked', async () => {
    const monitor = startLoopLagMonitor();
    await tick(40); // let the sampler take a reading before the loop is taken away from it
    blockLoop(250);
    await tick(40);
    const { max } = monitor.lag();
    monitor.stop();
    expect(max).toBeGreaterThan(100);
    // Only `max` is asserted on purpose. At 1 ms resolution a 250 ms stall is ONE sample among ~90, so
    // the 99th percentile stays near the floor — percentiles describe sustained starvation, `max`
    // catches the single long callback. Asserting p99 here would be asserting a false model of the data.
  });

  it('clears the window so an old spike stops being reported', async () => {
    const monitor = startLoopLagMonitor(400);
    await tick(30);
    blockLoop(150);
    await tick(30);
    expect(monitor.lag().max).toBeGreaterThan(100);
    // Past the window: the spike is history and must not keep the reading pinned high.
    await tick(500);
    const after = monitor.lag();
    monitor.stop();
    expect(after.max).toBeLessThan(100);
  });

  it('stops sampling when stopped', async () => {
    const monitor = startLoopLagMonitor();
    await tick(30);
    monitor.stop();
    blockLoop(150);
    await tick(20);
    expect(monitor.lag().max).toBeLessThan(100);
  });
});

describe('loop lag watchdog', () => {
  /** A monitor whose readings the test drives directly — the watchdog's logic is what is under test. */
  const scripted = (readings: LoopLag[]) => {
    let i = 0;
    return { lag: () => readings[Math.min(i++, readings.length - 1)], stop: () => { /* nothing */ } };
  };
  const quiet: LoopLag = { p50: 1, p99: 1, max: 2 };
  const busy: LoopLag = { p50: 40, p99: 400, max: 900 };

  const collect = async (readings: LoopLag[], checks: number) => {
    const lines: string[] = [];
    const log = { warn: (m: string) => lines.push(`WARN ${m}`), info: (m: string) => lines.push(`INFO ${m}`) };
    const stop = watchLoopLag(scripted(readings), log, { checkMs: 1, thresholdMs: 150 });
    await new Promise((r) => setTimeout(r, checks));
    stop();
    return lines;
  };

  it('says nothing while the loop keeps up', async () => {
    expect(await collect([quiet], 30)).toEqual([]);
  });

  // A saturated daemon must leave a trace — during the incident that motivated this, the only evidence
  // was a masked provider error, and nothing said the loop itself had stalled.
  it('warns once when the loop stops keeping up, not once per check', async () => {
    const lines = await collect([busy], 40);
    expect(lines.filter((l) => l.startsWith('WARN'))).toHaveLength(1);
    expect(lines[0]).toContain('p99 400ms');
  });

  it('reports recovery, and warns again if it degrades a second time', async () => {
    const lines = await collect([busy, busy, quiet, quiet, busy], 60);
    expect(lines.map((l) => l.split(' ')[0])).toEqual(['WARN', 'INFO', 'WARN']);
  });
});
