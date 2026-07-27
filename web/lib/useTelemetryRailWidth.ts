'use client';
import { useCallback, useEffect, useState, type CSSProperties } from 'react';

const KEY = 'elowen:telemetry-rail-width';

/** Below this the meters and the owl start crowding each other; above it the transcript is the one
 *  being squeezed, and the rail is a companion to the conversation, not a second document. */
export const RAIL_MIN_WIDTH = 240;
export const RAIL_MAX_WIDTH = 560;
export const RAIL_DEFAULT_WIDTH = 320;

const clamp = (n: number) => Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_MAX_WIDTH, Math.round(n)));

function read(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return RAIL_DEFAULT_WIDTH;
    const n = Number(raw);
    return Number.isFinite(n) ? clamp(n) : RAIL_DEFAULT_WIDTH;
  } catch {
    return RAIL_DEFAULT_WIDTH; // private mode / SSR — keep the default
  }
}

function write(width: number): number {
  try { localStorage.setItem(KEY, String(width)); } catch { /* quota / private mode — ignore */ }
  return width;
}

/** The docked telemetry rail's width, remembered per device. Mirrors `useSidebarState`: the value
 *  hydrates inside an effect so server and first paint agree on the default. */
export function useTelemetryRailWidth() {
  const [width, setWidth] = useState(RAIL_DEFAULT_WIDTH);
  useEffect(() => { setWidth(read()); }, []);

  // Delta rather than an absolute width: a drag reads as travel from wherever the edge currently is,
  // and a keyboard step is the same operation with a fixed distance.
  const resizeBy = useCallback((delta: number) => setWidth((w) => write(clamp(w + delta))), []);
  const reset = useCallback(() => setWidth(write(RAIL_DEFAULT_WIDTH)), []);

  return { width, resizeBy, reset };
}

const TINY_AT_MIN = 0.75, TINY_AT_MAX = 1;         /* 12px → 16px */
const CAPTION_AT_MIN = 0.875, CAPTION_AT_MAX = 1.125; /* 14px → 18px */

/** The rail's own type scale, published as the two smallest text tokens.
 *
 *  `--text-tiny` / `--text-caption` are GLOBAL tokens: the Tailwind utilities compile to
 *  `var(--text-tiny)` and some two dozen modules across the app use them, so raising them in
 *  `tokens.css` would resize the whole product to fix one column. Overriding them on the rail element
 *  keeps the sections on the very same utilities while sizing them for this column alone.
 *
 *  The scale rides the width because that is what the drag means: a rail pulled wider is one the user
 *  wants to read from further away, and text that stayed at 9px in a 560px column would only look
 *  emptier. */
export function railTypeVars(width: number): CSSProperties {
  const t = Math.max(0, Math.min(1, (width - RAIL_MIN_WIDTH) / (RAIL_MAX_WIDTH - RAIL_MIN_WIDTH)));
  const rem = (from: number, to: number) => `${Math.round((from + (to - from) * t) * 1000) / 1000}rem`;
  return {
    '--text-tiny': rem(TINY_AT_MIN, TINY_AT_MAX),
    '--text-caption': rem(CAPTION_AT_MIN, CAPTION_AT_MAX),
  } as CSSProperties;
}
