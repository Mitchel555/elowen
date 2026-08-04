'use client';
import { useEffect, useState } from 'react';

/** A clock for relative labels ("12m", "2h") that must keep counting on their own.
 *
 *  Such a label is computed at render time, so without this it freezes until something else re-renders
 *  the component — a recall could land and the row would still read what it read a minute ago.
 *
 *  One heartbeat serves the whole app: a timer per component would mean one per table row. Subscribers
 *  state the resolution they need and only re-render when that much time has actually passed, so a
 *  minute-grained label costs two renders a minute rather than sixty. The heartbeat is idle while the
 *  tab is hidden (a background tab has nobody reading it) and catches up the moment it comes back. */
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

const notify = (): void => { for (const fn of [...subscribers]) fn(); };
// Coming back from a hidden tab: re-render at once rather than waiting out the rest of the interval.
const onVisibility = (): void => { if (!document.hidden) notify(); };

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  if (!timer) {
    timer = setInterval(() => { if (!document.hidden) notify(); }, 1000);
    document.addEventListener('visibilitychange', onVisibility);
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size > 0 || !timer) return;
    clearInterval(timer);
    timer = null;
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/** The current time, refreshed no more often than `periodMs`. Default 1s — the resolution of an elapsed
 *  label under a minute, which is exactly the range a live view is worth watching. */
export function useNow(periodMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => subscribe(() => {
    // Returning the previous value tells React to bail out, so a subscriber coarser than the heartbeat
    // costs nothing between its own ticks.
    setNow((prev) => (Date.now() - prev >= periodMs ? Date.now() : prev));
  }), [periodMs]);
  return now;
}
