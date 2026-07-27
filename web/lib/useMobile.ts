'use client';
import { useEffect, useState } from 'react';

/** The width at or below which this is a phone. Exported because it is not only a media query: the UI
 *  scale has to make the same call, and a phone that counts as mobile for the layout but as a cramped
 *  desktop window for the zoom gets the compact layout shrunk a second time. */
export const MOBILE_MAX_WIDTH = 767;

/** The viewport against the mobile breakpoint (≤ 767px) — mirrors the Sidebar's drawer threshold so the
 *  two never disagree on what "mobile" means. `undefined` until the first effect measures it: neither SSR
 *  nor the first paint knows the viewport, so a layout that must not mount the WRONG variant even for a
 *  single commit (a phone building a desktop side column) waits for the boolean instead of guessing. */
export function useMobileViewport(): boolean | undefined {
  const [mobile, setMobile] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`);
    setMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => setMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return mobile;
}

/** The same viewport check collapsed to a boolean, with "not measured yet" reading as desktop. SSR-safe
 *  (server and first paint agree on false). For a layout whose desktop branch is the safe first paint —
 *  it only ever gains a drawer on a narrow screen — this avoids a blank frame. */
export function useMobile(): boolean {
  return useMobileViewport() === true;
}
