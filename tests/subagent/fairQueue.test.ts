import { describe, it, expect } from 'vitest';
import { FairQueue } from '../../src/subagent/fairQueue.js';

const drainOrder = (q: FairQueue<string>): string[] => {
  const out: string[] = [];
  for (;;) {
    const next = q.shift();
    if (next === undefined) return out;
    out.push(next);
  }
};

describe('FairQueue — one producer must not starve another', () => {
  it('keeps FIFO within a single producer', () => {
    const q = new FairQueue<string>();
    for (const n of ['a', 'b', 'c']) q.push('wf', n);
    expect(drainOrder(q)).toEqual(['a', 'b', 'c']);
  });

  // The shape a workflow tick actually produces: 30 nodes from one parent, then one unrelated delegation.
  // FIFO would serve the newcomer 31st; rotation serves it 2nd.
  it('rotates across producers regardless of how much each one pushed', () => {
    const q = new FairQueue<string>();
    for (let i = 0; i < 30; i += 1) q.push('brain-workflow', `node${i}`);
    q.push('brain-someone-else', 'lonely');
    const order = drainOrder(q);
    expect(order[0]).toBe('node0');
    expect(order[1]).toBe('lonely');
    expect(order).toHaveLength(31);
  });

  it('shares evenly between three producers', () => {
    const q = new FairQueue<string>();
    for (let i = 0; i < 4; i += 1) { q.push('a', `a${i}`); q.push('b', `b${i}`); q.push('c', `c${i}`); }
    expect(drainOrder(q)).toEqual(['a0', 'b0', 'c0', 'a1', 'b1', 'c1', 'a2', 'b2', 'c2', 'a3', 'b3', 'c3']);
  });

  // A producer offered a slot it could not use must not lose its place — that is how a session pinned to
  // a busy runner would slide to the back of the queue every single time room appeared elsewhere.
  it('restores an unplaceable item to the head of the rotation', () => {
    const q = new FairQueue<string>();
    q.push('a', 'a0');
    q.push('b', 'b0');
    const first = q.shift();
    expect(first).toBe('a0');
    q.unshift('a', first as string);
    expect(q.depth).toBe(2);
    expect(drainOrder(q)).toEqual(['a0', 'b0']);
  });

  it('reports its depth and hands everything back on teardown', () => {
    const q = new FairQueue<string>();
    q.push('a', 'a0'); q.push('b', 'b0'); q.push('a', 'a1');
    expect(q.depth).toBe(3);
    expect(q.drain().sort()).toEqual(['a0', 'a1', 'b0']);
    expect(q.depth).toBe(0);
    expect(q.shift()).toBeUndefined();
  });

  it('does not read a producer that has gone quiet as still in the rotation', () => {
    const q = new FairQueue<string>();
    q.push('a', 'a0');
    q.push('b', 'b0');
    expect(q.shift()).toBe('a0');
    q.push('b', 'b1');
    // 'a' emptied and dropped out; 'b' now owns the rotation on its own.
    expect(drainOrder(q)).toEqual(['b0', 'b1']);
  });

  it('reads the queue without disturbing the rotation', () => {
    const q = new FairQueue<string>();
    q.push('a', 'a0'); q.push('b', 'b0'); q.push('a', 'a1');
    expect([...q.entries()].sort()).toEqual(['a0', 'a1', 'b0']);
    expect(q.depth).toBe(3);
    expect(drainOrder(q)).toEqual(['a0', 'b0', 'a1']);
  });
});
