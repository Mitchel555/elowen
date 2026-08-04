import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useNow } from '../../lib/useNow';

const hidden = (value: boolean) => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
  document.dispatchEvent(new Event('visibilitychange'));
};

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
});

const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe('useNow', () => {
  it('keeps advancing on its own, so an elapsed label cannot freeze', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNow());
    const start = result.current;

    await advance(3000);

    expect(result.current).toBeGreaterThanOrEqual(start + 3000);
  });

  // A minute-grained label re-rendering every second is sixty times the work for the same string.
  it('holds still between a coarse subscriber\'s own ticks', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNow(60_000));
    const start = result.current;

    await advance(5000);
    expect(result.current).toBe(start);

    await advance(60_000);
    expect(result.current).toBeGreaterThanOrEqual(start + 60_000);
  });

  it('stops ticking while the tab is hidden and catches up when it returns', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNow());
    const start = result.current;

    act(() => { hidden(true); });
    await advance(5000);
    expect(result.current).toBe(start); // nobody is reading a background tab

    act(() => { hidden(false); });
    expect(result.current).toBeGreaterThanOrEqual(start + 5000);
  });

  // One heartbeat serves every subscriber; the last one to leave must take it with them, or a closed
  // memory view keeps waking the page forever.
  it('runs a single timer and shuts it down with the last subscriber', async () => {
    vi.useFakeTimers();
    const first = renderHook(() => useNow());
    const second = renderHook(() => useNow());
    expect(vi.getTimerCount()).toBe(1);

    first.unmount();
    expect(vi.getTimerCount()).toBe(1); // still one reader left

    second.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
