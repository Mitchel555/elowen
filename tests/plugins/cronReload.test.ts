import { describe, it, expect, vi } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadPlugins } from '../../src/plugins/loader.js';
import type { SessionSource } from '../../src/plugins/api.js';

// A plugin reload (stopAll + startAll) replaces the cron adapter while a tick may still be parked on a
// slow brain turn. The torn-down generation and its replacement share one jobs.json and one delivery
// sink, and the in-memory `running` guard covers only a single adapter — so both the hand-over and the
// due-slot claim have to hold across generations.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pluginsDir = join(repoRoot, 'plugins');

interface CronAdapterUnderTest {
  listen(fn: (src: SessionSource, text: string) => Promise<string | undefined>): void;
  tick(): Promise<void>;
  disconnect(): void;
}

function freshDataRoot(): string { return mkdtempSync(join(tmpdir(), 'elowen-pdata-')); }

async function loadCron(dataRoot: string, notify: (text: string, channelId?: string) => Promise<void>) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['cronjob'], dataRoot, logger, notify });
  return reg.platforms[0] as unknown as CronAdapterUnderTest;
}

/** Two recurring jobs, both due right now, in the order the tick walks them. */
function writeTwoDueJobs(dataRoot: string): void {
  mkdirSync(join(dataRoot, 'cronjob'), { recursive: true });
  const lastRun = new Date(Date.now() - 10 * 60_000).toISOString();
  writeFileSync(join(dataRoot, 'cronjob/jobs.json'), JSON.stringify([
    { id: 'r1', name: 'first', schedule: 'every 5m', prompt: 'do it', lastRun, createdAt: lastRun },
    { id: 'r2', name: 'second', schedule: 'every 5m', prompt: 'do it', lastRun, createdAt: lastRun },
  ]));
}

/** A handler that parks on job r1 until released, recording every job it is asked to run. */
function parkingHandler(tag: string, calls: string[]) {
  let release: () => void = () => {};
  let reachedR1: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const running = new Promise<void>((r) => { reachedR1 = r; });
  const handler = async (src: SessionSource) => {
    calls.push(`${tag}:${src.channelId}`);
    if (src.channelId === 'job-r1') { reachedR1(); await gate; }
    return 'done';
  };
  return { handler, gate: { release: () => release() }, running };
}

describe('cron scheduler across a plugin reload', () => {
  it('an adapter torn down mid-tick hands the remaining jobs over instead of running them itself', async () => {
    const dataRoot = freshDataRoot();
    writeTwoDueJobs(dataRoot);
    const delivered: string[] = [];
    const adapter = await loadCron(dataRoot, async (t: string) => { delivered.push(t); });
    const calls: string[] = [];
    const parked = parkingHandler('A', calls);
    adapter.listen(parked.handler);

    const tick = adapter.tick();
    await parked.running; // the tick is inside r1's turn — exactly where a reload lands
    adapter.disconnect(); // the host replaces this generation with a fresh one
    parked.gate.release();
    await tick;

    expect(calls).toEqual(['A:job-r1']); // r2 was left to the live adapter, not run by the orphan
    // The result the orphan already paid for is still delivered — the hand-over must not drop it.
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('done');
  });

  it('does not double-fire a job when the old and new adapter generations overlap', async () => {
    const dataRoot = freshDataRoot();
    writeTwoDueJobs(dataRoot);
    const delivered: string[] = [];
    const notify = async (t: string) => { delivered.push(t); };
    const calls: string[] = [];

    const oldAdapter = await loadCron(dataRoot, notify);
    const parked = parkingHandler('old', calls);
    oldAdapter.listen(parked.handler);
    const oldTick = oldAdapter.tick();
    await parked.running; // parked on r1's turn, holding a snapshot of jobs.json that is about to go stale

    // The reloaded registry's adapter connects and ticks while the old one is still mid-turn.
    const newAdapter = await loadCron(dataRoot, notify);
    newAdapter.listen(async (src: SessionSource) => { calls.push(`new:${src.channelId}`); return 'done'; });
    await newAdapter.tick();

    parked.gate.release();
    await oldTick;

    // r1 was claimed (stamped) by the old generation before its turn, so the new one skipped it; r2 was
    // claimed by the new one, so the old generation's stale snapshot must not fire it a second time.
    expect(calls.filter((c) => c.endsWith('job-r1'))).toEqual(['old:job-r1']);
    expect(calls.filter((c) => c.endsWith('job-r2'))).toEqual(['new:job-r2']);
    expect(delivered).toHaveLength(2);
  });
});
