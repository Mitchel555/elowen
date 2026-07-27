import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { subscribeRevive, type ReviveEvent } from '../../lib/useRevive';

/** jsdom has no real page lifecycle, so `document.hidden` is stubbed and the events are dispatched by
 *  hand. What CANNOT be tested here — a genuine bfcache freeze/restore, iOS timer suspension — is
 *  device-only; this suite covers the emitter's own contract (one listener set, coalescing, hiddenMs). */
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
}

const wake = (): void => { setHidden(false); document.dispatchEvent(new Event('visibilitychange')); };
const sleep = (): void => { setHidden(true); document.dispatchEvent(new Event('visibilitychange')); };

// The emitter is a module-level singleton (that is the point — one listener set for the whole app), so
// its coalescing timestamp survives between tests. A clock that only ever moves FORWARD, well past the
// coalescing window each test, keeps them independent without exposing a test-only reset.
let clock = 1_800_000_000_000;
const at = (ms: number): void => { clock = ms; };
beforeEach(() => { clock += 3_600_000; vi.spyOn(Date, 'now').mockImplementation(() => clock); });
afterEach(() => { setHidden(false); vi.restoreAllMocks(); });

describe('useRevive — shared wake-up emitter', () => {
  it('reports how long the page was hidden', () => {
    const seen: ReviveEvent[] = [];
    const off = subscribeRevive((e) => seen.push(e));
    sleep();
    at(clock + 30_000);
    wake();
    off();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.hiddenMs).toBe(30_000);
  });

  it('wakes on pageshow even when the page was never marked hidden (the bfcache restore)', () => {
    const seen: ReviveEvent[] = [];
    const off = subscribeRevive((e) => seen.push(e));
    window.dispatchEvent(new Event('pageshow'));
    off();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.hiddenMs).toBe(0);
  });

  it('coalesces a burst of wake signals into ONE event', () => {
    const seen: ReviveEvent[] = [];
    const off = subscribeRevive((e) => seen.push(e));
    window.dispatchEvent(new Event('pageshow'));
    wake();
    window.dispatchEvent(new Event('focus'));
    at(clock + 900); // still inside the 1s coalescing window
    window.dispatchEvent(new Event('focus'));
    expect(seen).toHaveLength(1);

    at(clock + 200); // past it — a genuinely later wake gets through
    window.dispatchEvent(new Event('focus'));
    off();
    expect(seen).toHaveLength(2);
  });

  it('reports a reconnect after the network dropped', () => {
    const seen: ReviveEvent[] = [];
    const off = subscribeRevive((e) => seen.push(e));
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    off();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.wasOffline).toBe(true);
  });

  it('installs ONE set of DOM listeners for many subscribers and removes them with the last one', () => {
    const addDoc = vi.spyOn(document, 'addEventListener');
    const removeDoc = vi.spyOn(document, 'removeEventListener');
    const offA = subscribeRevive(() => {});
    const offB = subscribeRevive(() => {});
    const installs = addDoc.mock.calls.filter(([type]) => type === 'visibilitychange').length;
    expect(installs).toBe(1);

    offA();
    expect(removeDoc.mock.calls.filter(([type]) => type === 'visibilitychange')).toHaveLength(0);
    offB();
    expect(removeDoc.mock.calls.filter(([type]) => type === 'visibilitychange')).toHaveLength(1);
  });

  it('delivers each wake to every subscriber', () => {
    const a: ReviveEvent[] = [];
    const b: ReviveEvent[] = [];
    const offA = subscribeRevive((e) => a.push(e));
    const offB = subscribeRevive((e) => b.push(e));
    window.dispatchEvent(new Event('pageshow'));
    offA();
    offB();

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});
