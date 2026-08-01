import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

/** The runtime-knob twin of `brainLimitsParity.test.ts`: the canonical table is `src/store/configStore.ts`
 *  (its defaults seed the form, its clamp bounds decide which values survive a save), `RuntimeLimitsModal`
 *  mirrors both, and the web may not IMPORT the daemon (dependency-cruiser's `web-not-to-backend` rule) —
 *  so the two are compared as TEXT. Without this, a bound raised on one side only leaves the slider
 *  offering a value the daemon silently lowers. */
const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');
const daemon = read('../../../../src/store/configStore.ts');
const web = read('../../../modules/settings/RuntimeLimitsModal.tsx');

/** Numeric literals are written with `_` separators on the daemon side. */
const num = (literal: string): number => Number(literal.replace(/_/g, ''));

/** The text of one `const NAME … = { … };` object literal. */
function objectBlock(source: string, marker: string, label: string): string {
  const start = source.indexOf(marker);
  expect(start, `${label} not found`).toBeGreaterThan(-1);
  const end = source.indexOf('\n};', start);
  expect(end, `${label} is not a closed object literal`).toBeGreaterThan(start);
  return source.slice(start + marker.length, end);
}

function numericFields(block: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [, key, value] of block.matchAll(/(\w+):\s*([\d_]+),/g)) out[key] = num(value);
  return out;
}

const daemonDefaults = numericFields(objectBlock(daemon, 'export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = {', 'DEFAULT_RUNTIME_LIMITS'));
const webDefaults = numericFields(objectBlock(web, 'export const RUNTIME_LIMIT_DEFAULTS: RuntimeLimits = {', 'RUNTIME_LIMIT_DEFAULTS'));
const boundsBlock = objectBlock(daemon, 'const RUNTIME_LIMIT_BOUNDS: Record<keyof RuntimeLimits, [min: number, max: number]> = {', 'RUNTIME_LIMIT_BOUNDS');

/** Every runtime bound is written out explicitly (no `band()` derivation, unlike the brain limits), so an
 *  entry the regex cannot read is a real drift signal rather than an unsupported expression. */
function daemonBounds(): Record<string, [min: number, max: number]> {
  const out: Record<string, [number, number]> = {};
  for (const [, key, expression] of boundsBlock.matchAll(/^ {2}(\w+): (.+),$/gm)) {
    const explicit = /^\[([\d_]+), ([\d_]+)\]$/.exec(expression);
    expect(explicit, `unrecognised bound expression for ${key}: ${expression}`).toBeTruthy();
    if (explicit) out[key] = [num(explicit[1]), num(explicit[2])];
  }
  return out;
}

function webBounds(): Record<string, [min: number, max: number]> {
  const out: Record<string, [number, number]> = {};
  for (const [, key, min, max] of web.matchAll(/\{ key: '(\w+)', kind: '\w+', min: (\d+), max: (\d+),/g)) {
    out[key] = [Number(min), Number(max)];
  }
  return out;
}

describe('runtime limits — web editor against the daemon clamp', () => {
  it('offers exactly the daemon fields, no more and no fewer', () => {
    expect(Object.keys(webBounds()).sort()).toEqual(Object.keys(daemonBounds()).sort());
    expect(Object.keys(webDefaults).sort()).toEqual(Object.keys(daemonDefaults).sort());
  });

  it('bounds every slider to the daemon clamp bound', () => {
    expect(webBounds()).toEqual(daemonBounds());
  });

  it('seeds the form with the daemon defaults', () => {
    expect(webDefaults).toEqual(daemonDefaults);
  });

  // Guards the parsing itself: were a regex to stop matching, every table above would silently be empty
  // and all three assertions would pass on nothing.
  it('actually read both tables', () => {
    expect(Object.keys(daemonBounds())).toHaveLength(4);
    expect(Object.keys(webBounds())).toHaveLength(4);
    expect(daemonBounds().localShellTimeoutMs).toEqual([10000, 300000]);
    expect(daemonBounds().memorySemanticFloorPerMille).toEqual([100, 800]);
    expect(webBounds().eventRetentionDays).toEqual([1, 365]);
    expect(webDefaults.memorySemanticFloorPerMille).toBe(300);
  });
});
