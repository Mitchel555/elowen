'use client';

/** One wake-up of the page: it became visible again, was restored from the bfcache, regained focus or
 *  came back online. `hiddenMs` is how long it had been hidden (0 when it never was — a bfcache restore
 *  reports no visibility transition at all). */
export interface ReviveEvent {
  hiddenMs: number;
}

/** A hide shorter than this, on a stream that still looks healthy, needs no recovery — anything longer may
 *  have lost frames. Shared by every stream so "was the page away long enough to matter" has one answer. */
export const STALE_HIDE_MS = 5_000;

type ReviveListener = (event: ReviveEvent) => void;

/** Repeated wake signals for ONE wake-up (pageshow + visibilitychange + focus all fire when a phone is
 *  unlocked) collapse into a single event inside this window. */
const COALESCE_MS = 1_000;

const listeners = new Set<ReviveListener>();
let installed = false;
let hiddenSince: number | null = null;
let lastPublishedAt = 0;

function publish(): void {
  const now = Date.now();
  if (now - lastPublishedAt < COALESCE_MS) return;
  lastPublishedAt = now;
  const event: ReviveEvent = { hiddenMs: hiddenSince === null ? 0 : Math.max(0, now - hiddenSince) };
  hiddenSince = null;
  for (const listener of [...listeners]) listener(event);
}

const onVisibilityChange = (): void => {
  if (document.hidden) { hiddenSince = Date.now(); return; }
  publish();
};
// The only signal a bfcache restore reliably produces (iOS may deliver no visibilitychange at all), so
// it always wakes — `persisted` is diagnostic, never a reason to stay asleep.
const onPageShow = (): void => publish();
const onFocus = (): void => publish();
// Regaining the network is a wake signal in its own right: a stream that died while the connection was
// down will not recover on its own. Going OFFLINE is deliberately not listened for — there is nothing to
// recover at that moment, and every consumer decides what to do purely from `hiddenMs`.
const onOnline = (): void => publish();

function install(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('focus', onFocus);
  window.addEventListener('online', onOnline);
}

function uninstall(): void {
  if (!installed) return;
  installed = false;
  document.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('pageshow', onPageShow);
  window.removeEventListener('focus', onFocus);
  window.removeEventListener('online', onOnline);
  hiddenSince = null;
}

/** Subscribe to page wake-ups. The DOM listeners are installed ONCE for the whole app and torn down with
 *  the last subscriber: the events are global, so a per-hook listener set would mean every stream
 *  reconnecting on its own uncoordinated copy of the same signal. WHAT to recover stays with each stream
 *  — only the detection is shared. Returns the unsubscribe. */
export function subscribeRevive(listener: ReviveListener): () => void {
  install();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) uninstall();
  };
}
