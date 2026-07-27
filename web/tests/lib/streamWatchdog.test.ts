import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startStreamWatchdog, SILENCE_LIMIT_MS } from '../../lib/streamWatchdog';

// A dropped SSE connection can stay in readyState OPEN with nothing ever arriving on it, so silence is the
// only observable symptom. The daemon heartbeats every 30 s, which is what makes silence measurable.

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('startStreamWatchdog', () => {
  const run = (opts: { silentMs: number; hidden?: boolean }) => {
    const onSilent = vi.fn();
    const lastFrameAt = Date.now();
    const stop = startStreamWatchdog({
      lastFrameAt: () => lastFrameAt,
      onSilent,
      hidden: () => opts.hidden ?? false,
      intervalMs: 1_000, // fine granularity so the assertion is about the limit, not the poll rate
    });
    vi.advanceTimersByTime(opts.silentMs);
    stop();
    return onSilent;
  };

  it('reports a visible stream that has been silent past the limit', () => {
    expect(run({ silentMs: 76_000 })).toHaveBeenCalled();
  });

  it('leaves a stream that is merely between heartbeats alone', () => {
    expect(run({ silentMs: 74_000 })).not.toHaveBeenCalled();
  });

  it('never fires while the page is hidden', () => {
    expect(run({ silentMs: 300_000, hidden: true })).not.toHaveBeenCalled();
  });

  it('measures the wall clock, not how many ticks it saw', () => {
    const onSilent = vi.fn();
    let clock = 1_000_000;
    // Timers frozen by a locked phone: exactly one tick is delivered, long after the silence began.
    const stop = startStreamWatchdog({
      lastFrameAt: () => 1_000_000,
      onSilent,
      hidden: () => false,
      now: () => clock,
      intervalMs: 15_000,
    });
    clock += SILENCE_LIMIT_MS + 1_000;
    vi.advanceTimersByTime(15_000); // a single tick
    stop();
    expect(onSilent).toHaveBeenCalledTimes(1);
  });

  it('stops checking once stopped', () => {
    const onSilent = vi.fn();
    const stop = startStreamWatchdog({ lastFrameAt: () => 0, onSilent, hidden: () => false });
    stop();
    vi.advanceTimersByTime(300_000);
    expect(onSilent).not.toHaveBeenCalled();
  });
});
