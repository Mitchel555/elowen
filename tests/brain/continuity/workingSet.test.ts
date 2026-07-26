import { describe, it, expect } from 'vitest';
import { WORKING_SET_MAX, rollupWorkingSet } from '../../../src/brain/continuity/workingSet.js';

/** A persisted toolResult row as the store holds it: the whole PI message serialized into `content`. */
const row = (tool: string, path: string, ok = true) => ({
  content: JSON.stringify({ role: 'toolResult', toolName: tool, details: { ok, tool, path, contentHash: 'h' } }),
});

describe('continuity/workingSet', () => {
  it('reports nothing when no dropped row named a file', () => {
    expect(rollupWorkingSet([])).toBeNull();
    expect(rollupWorkingSet([{ content: JSON.stringify({ role: 'assistant', content: 'hi' }) }])).toBeNull();
  });

  it('collects read and written files, marking which were changed', () => {
    expect(rollupWorkingSet([row('Read', '/a.ts'), row('Write', '/b.ts')])).toEqual([
      { path: '/b.ts', wrote: true },
      { path: '/a.ts', wrote: false },
    ]);
  });

  it('treats Edit as a write', () => {
    expect(rollupWorkingSet([row('Edit', '/a.ts')])).toEqual([{ path: '/a.ts', wrote: true }]);
  });

  // Newest first: the model needs where it was LAST working, not where it started.
  it('orders by most recent touch', () => {
    const set = rollupWorkingSet([row('Read', '/first.ts'), row('Read', '/second.ts'), row('Read', '/third.ts')]);
    expect(set?.map((e) => e.path)).toEqual(['/third.ts', '/second.ts', '/first.ts']);
  });

  it('de-duplicates a file touched repeatedly, keeping its latest position', () => {
    const set = rollupWorkingSet([row('Read', '/a.ts'), row('Read', '/b.ts'), row('Read', '/a.ts')]);
    expect(set?.map((e) => e.path)).toEqual(['/a.ts', '/b.ts']);
  });

  // "You edited this" must not decay back to "you looked at this" because a read happened afterwards.
  it('keeps a file marked as written even when a later read follows', () => {
    expect(rollupWorkingSet([row('Write', '/a.ts'), row('Read', '/a.ts')])).toEqual([{ path: '/a.ts', wrote: true }]);
  });

  // A failed read means the model never saw the file — pointing it back there would be a lie.
  it('ignores a failed tool result', () => {
    expect(rollupWorkingSet([row('Read', '/gone.ts', false)])).toBeNull();
  });

  it('ignores results from tools that merely happen to carry a path', () => {
    const bash = { content: JSON.stringify({ role: 'toolResult', details: { ok: true, tool: 'Bash', path: '/cwd' } }) };
    expect(rollupWorkingSet([bash])).toBeNull();
  });

  it('ignores a result with no usable path', () => {
    const noPath = { content: JSON.stringify({ role: 'toolResult', details: { ok: true, tool: 'Read' } }) };
    const blank = { content: JSON.stringify({ role: 'toolResult', details: { ok: true, tool: 'Read', path: '' } }) };
    expect(rollupWorkingSet([noPath, blank])).toBeNull();
  });

  // One bad row costs one entry, never the rollup.
  it('skips a row it cannot parse and keeps the rest', () => {
    expect(rollupWorkingSet([{ content: '{oops' }, row('Read', '/a.ts')])).toEqual([{ path: '/a.ts', wrote: false }]);
  });

  it('caps the list so the block stays orientation rather than a manifest', () => {
    const many = Array.from({ length: WORKING_SET_MAX + 8 }, (_, i) => row('Read', `/f${i}.ts`));
    const set = rollupWorkingSet(many);
    expect(set).toHaveLength(WORKING_SET_MAX);
    expect(set?.[0]?.path).toBe(`/f${WORKING_SET_MAX + 7}.ts`); // the newest survive the cap
  });
});
