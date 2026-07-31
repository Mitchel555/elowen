import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createReconnectController } from '../../lib/reconnect';

// Three independent triggers can fire for ONE wake-up (the revive emitter, the silence watchdog and a
// server error frame). Without a single-flight guard a phone unlock turns into three concurrent
// brainStart calls with three generations racing each other's stop tombstone.

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createReconnectController', () => {
  it('runs one attempt when every trigger fires in the same millisecond', async () => {
    const connect = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
    const c = createReconnectController(connect);

    c.now();
    c.now();
    c.retry();

    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(1);
    // Still one while the attempt is in flight — the connect is what takes time, not the timer.
    await vi.advanceTimersByTimeAsync(50);
    c.now();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('accepts a new attempt once the previous one settled', async () => {
    const connect = vi.fn(() => Promise.resolve());
    const c = createReconnectController(connect);
    c.now();
    await vi.advanceTimersByTimeAsync(0);
    c.now();
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('backs off exponentially up to the cap and resets on a healthy connection', async () => {
    const at: number[] = [];
    const connect = vi.fn(() => { at.push(Date.now()); return Promise.resolve(); });
    const c = createReconnectController(connect, { random: () => 0 }); // no jitter → deterministic floor

    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      const before = Date.now();
      c.retry();
      await vi.advanceTimersByTimeAsync(60_000);
      delays.push(at[at.length - 1]! - before);
    }
    // With the jitter floored out: half of 1s, 2s, 4s … capped at half of 30s.
    expect(delays.slice(0, 4)).toEqual([500, 1_000, 2_000, 4_000]);
    expect(delays.at(-1)).toBe(15_000);

    c.succeeded();
    const before = Date.now();
    c.retry();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(at.at(-1)! - before).toBe(500);
  });

  it('adds jitter within the current backoff window', async () => {
    const at: number[] = [];
    const c = createReconnectController(() => { at.push(Date.now()); }, { random: () => 1 });
    const before = Date.now();
    c.retry();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(at[0]! - before).toBe(1_000); // full window, where random() === 0 would have given half
  });

  it('retries with backoff when the attempt itself throws', async () => {
    const connect = vi.fn(() => Promise.reject(new Error('daemon down')));
    const c = createReconnectController(connect, { random: () => 0 });
    c.now();
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(900);
    expect(connect).toHaveBeenCalledTimes(1); // still inside the backoff window
    await vi.advanceTimersByTimeAsync(200);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('never reconnects after stop', async () => {
    const connect = vi.fn(() => Promise.resolve());
    const c = createReconnectController(connect);
    c.retry();
    c.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    c.now();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).not.toHaveBeenCalled();
  });

  // The chat provider tears this controller down from its unmount cleanup and keeps no "still mounted" flag
  // of its own. That is only safe because stop() silences the onActive channel for good: a late signal would
  // land as a setState on an unmounted component.
  it('never signals active again after stop', async () => {
    const states: boolean[] = [];
    const c = createReconnectController(() => Promise.reject(new Error('daemon down')), { random: () => 0, onActive: (v) => states.push(v) });
    c.now();
    c.stop(); // torn down with the attempt still in flight — its rejection would normally re-arm the backoff
    await vi.advanceTimersByTimeAsync(60_000);
    c.now();
    c.retry();
    c.succeeded();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(states).toEqual([true, false]);
  });

  // The overlay ("reconnecting…") is driven off onActive, so it must go true the moment recovery starts and
  // false only when the stream is healthy again — not on every internal busy transition.
  it('signals active while recovering and inactive once a frame confirms health', async () => {
    const states: boolean[] = [];
    const c = createReconnectController(() => Promise.resolve(), { random: () => 0, onActive: (v) => states.push(v) });
    c.retry();
    expect(states).toEqual([true]); // an attempt is scheduled
    await vi.advanceTimersByTimeAsync(60_000); // it runs and resolves, but a bare resolve is not proof of health
    expect(states).toEqual([true]);
    c.succeeded(); // the first delivered frame is
    expect(states).toEqual([true, false]);
  });

  it('coalesces duplicate triggers into one active signal and clears it on stop', () => {
    const states: boolean[] = [];
    const c = createReconnectController(() => new Promise<void>(() => {}), { onActive: (v) => states.push(v) });
    c.now();
    c.now(); // busy → no second signal
    c.stop();
    expect(states).toEqual([true, false]);
  });
});
