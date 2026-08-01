import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadPlugins } from '../../src/plugins/loader.js';
import type { SessionSource } from '../../src/plugins/api.js';

// `cronLookbackMs` decides how far back a 5-field cron job hunts for a run it missed while the daemon was
// down. It is only observable as a job that DOES or DOES NOT fire after downtime, so that is what these
// tests drive — a real tick against a real job file, with the clock parked at a fixed instant.
const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pluginsDir = join(repoRoot, 'plugins');

interface CronAdapterUnderTest {
  listen(fn: (src: SessionSource, text: string) => Promise<string | undefined>): void;
  tick(): Promise<void>;
  cronLookbackMs: number;
}

let dirs: string[] = [];
const freshDataRoot = (): string => { const p = mkdtempSync(join(tmpdir(), 'elowen-cron-lookback-')); dirs.push(p); return p; };

// Only Date is faked: the adapter's own tick is driven by hand, so the interval timers must stay real —
// faking them would freeze the promise plumbing the tick awaits.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // A Thursday. The job below fires at 09:00, so "now" sits three hours past a missed occurrence.
  vi.setSystemTime(new Date('2026-05-14T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  for (const p of dirs) rmSync(p, { recursive: true, force: true });
  dirs = [];
});

async function loadCron(dataRoot: string, config?: Record<string, unknown>): Promise<CronAdapterUnderTest> {
  const reg = await loadPlugins({
    dirs: [pluginsDir], enabled: ['cronjob'], dataRoot, logger: log,
    timezone: () => 'UTC',
    config: config ? { cronjob: config } : undefined,
  });
  return reg.platforms[0] as unknown as CronAdapterUnderTest;
}

/** A daily 09:00 cron job whose last run was two weeks ago — i.e. it missed today's 09:00 while down. */
function writeMissedCronJob(dataRoot: string): void {
  mkdirSync(join(dataRoot, 'cronjob'), { recursive: true });
  writeFileSync(join(dataRoot, 'cronjob/jobs.json'), JSON.stringify([{
    id: 'c1', name: 'nightly', schedule: '0 9 * * *', prompt: 'run the report',
    lastRun: '2026-04-30T09:00:00.000Z', createdAt: '2026-04-01T00:00:00.000Z',
  }]));
}

/** Tick once and report whether the job's prompt was actually handed to the brain. */
async function tickFired(adapter: CronAdapterUnderTest): Promise<boolean> {
  let fired = false;
  adapter.listen(async () => { fired = true; return 'ok'; });
  await adapter.tick();
  return fired;
}

describe('cron catch-up window (cronLookbackMs)', () => {
  it('the default 24 h window still replays a run missed earlier today', async () => {
    const dataRoot = freshDataRoot();
    writeMissedCronJob(dataRoot);
    const adapter = await loadCron(dataRoot);
    expect(adapter.cronLookbackMs).toBe(86_400_000);
    expect(await tickFired(adapter)).toBe(true);
  });

  it('a narrowed window stops looking before the missed occurrence, so the job does NOT fire', async () => {
    const dataRoot = freshDataRoot();
    writeMissedCronJob(dataRoot);
    // One hour back from 12:00 UTC never reaches the 09:00 slot the daemon slept through.
    const adapter = await loadCron(dataRoot, { cronLookbackMs: 3_600_000 });
    expect(adapter.cronLookbackMs).toBe(3_600_000);
    expect(await tickFired(adapter)).toBe(false);
  });

  it('a widened window reaches a run missed days ago that the default would have dropped', async () => {
    const dataRoot = freshDataRoot();
    mkdirSync(join(dataRoot, 'cronjob'), { recursive: true });
    // Weekly-ish: Monday 09:00. The most recent occurrence was 2026-05-11, three days before "now".
    writeFileSync(join(dataRoot, 'cronjob/jobs.json'), JSON.stringify([{
      id: 'c2', name: 'weekly', schedule: '0 9 * * mon', prompt: 'run the weekly report',
      lastRun: '2026-04-06T09:00:00.000Z', createdAt: '2026-04-01T00:00:00.000Z',
    }]));

    expect(await tickFired(await loadCron(dataRoot))).toBe(false); // 24 h cannot reach Monday

    const wide = await loadCron(dataRoot, { cronLookbackMs: 7 * 86_400_000 });
    expect(await tickFired(wide)).toBe(true);
  });

  it('clamps an out-of-range value to the manifest bounds instead of honouring it verbatim', async () => {
    expect((await loadCron(freshDataRoot(), { cronLookbackMs: 1_000 })).cronLookbackMs).toBe(3_600_000);
    expect((await loadCron(freshDataRoot(), { cronLookbackMs: 99 * 86_400_000 })).cronLookbackMs).toBe(604_800_000);
  });
});
