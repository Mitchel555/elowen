import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

/** The retention twin of `runtimeLimitsParity.test.ts`: the canonical table is `src/store/configStore.ts`
 *  (`RETENTION_BOUNDS`) and the defaults live in `src/brain/memoryVitality.ts` (`DEFAULT_MEMORY_RETENTION`),
 *  `MemoryRetentionModal` mirrors both, and the web may not IMPORT the daemon (dependency-cruiser's
 *  `web-not-to-backend` rule) — so the two are compared as TEXT. Without this, a bound raised on one side
 *  only leaves the slider offering a value the daemon silently lowers. */
const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');
const daemonVitality = read('../../../../src/brain/memoryVitality.ts');
const daemonConfig = read('../../../../src/store/configStore.ts');
const web = read('../../../modules/settings/MemoryRetentionModal.tsx');

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

const daemonDefaults = numericFields(objectBlock(daemonVitality, 'export const DEFAULT_MEMORY_RETENTION: MemoryRetentionConfig = {', 'DEFAULT_MEMORY_RETENTION'));
const webDefaults = numericFields(objectBlock(web, 'export const DEFAULT_MEMORY_RETENTION: MemoryRetentionConfig = {', 'DEFAULT_MEMORY_RETENTION'));

/** The daemon clamps each retention field to `[min, max] as const`; the web mirrors them per field. */
function daemonBounds(): Record<string, [number, number]> {
  const block = objectBlock(daemonConfig, 'const RETENTION_BOUNDS = {', 'RETENTION_BOUNDS');
  const out: Record<string, [number, number]> = {};
  for (const [, key, min, max] of block.matchAll(/(\w+): \[(\d+), (\d+)\] as const,/g)) {
    out[key] = [num(min), num(max)];
  }
  return out;
}

function webFieldBounds(): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const [, key, min, max] of web.matchAll(/\{ key: '(\w+)', min: (\d+), max: (\d+),/g)) {
    out[key] = [Number(min), Number(max)];
  }
  return out;
}

/** The half-life sliders share one range constant — read it back as its own row. */
function webHalfLifeRange(): [number, number] {
  const found = /const HALF_LIFE_RANGE: readonly \[number, number\] = \[(\d+), (\d+)\];/.exec(web);
  expect(found, 'HALF_LIFE_RANGE not found').toBeTruthy();
  return found ? [Number(found[1]), Number(found[2])] : [0, 0];
}

describe('memory retention — web editor against the daemon clamp', () => {
  it('offers exactly the daemon fields, no more and no fewer, and seeds the form with the daemon defaults', () => {
    expect(Object.keys(webDefaults).sort()).toEqual(Object.keys(daemonDefaults).sort());
    expect(webDefaults).toEqual(daemonDefaults);
  });

  it('bounds every slider to the daemon clamp bound, including the shared half-life range', () => {
    const bounds = daemonBounds();
    const webBounds = webFieldBounds();
    expect(webBounds.graceDays).toEqual(bounds.graceDays);
    expect(webBounds.vitalityFloor).toEqual(bounds.vitalityFloor);
    expect(webHalfLifeRange()).toEqual(bounds.halfLife);
  });

  // Guards the parsing itself: were a regex to stop matching, the tables above would silently be empty.
  it('actually read both tables', () => {
    expect(daemonDefaults).toEqual({
      graceDays: 14, vitalityFloor: 10, 1: 30, 2: 60, 3: 120, 4: 240, 5: 0,
    });
    expect(daemonBounds()).toEqual({ graceDays: [0, 365], vitalityFloor: [0, 90], halfLife: [0, 3650] });
    expect(webFieldBounds().graceDays).toEqual([0, 365]);
    expect(webHalfLifeRange()).toEqual([0, 3650]);
  });
});
