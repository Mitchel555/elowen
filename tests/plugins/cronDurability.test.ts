import { describe, it, expect, vi, afterEach } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { SessionSource } from '../../src/plugins/api.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pluginsDir = join(repoRoot, 'plugins');
const ADMIN: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const OWNER: TurnIdentity = { platform: 'elowen', userId: '1', elowenUserId: 1, admin: true, owner: true };
const asText = (r: { content: { text?: string }[] }) => (r.content[0] as { text: string }).text;

interface CronTurnEvent { type: string; sessionId?: string }
interface CronAdapterUnderTest {
  listen(fn: (src: SessionSource, text: string, onEvent?: (e: CronTurnEvent) => void) => Promise<string | undefined>): void;
  tick(): Promise<void>;
}

let dirs: string[] = [];
function freshDataRoot(): string { const p = mkdtempSync(join(tmpdir(), 'elowen-pdata-')); dirs.push(p); return p; }
afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

function fakeLogger() { return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }; }

async function loadCron(dataRoot: string, notify: (text: string, channelId?: string) => Promise<void>, logger = fakeLogger()) {
  const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['cronjob'], dataRoot, logger, notify });
  return { reg, adapter: reg.platforms[0] as unknown as CronAdapterUnderTest, logger };
}

const jobsFile = (dataRoot: string) => join(dataRoot, 'cronjob/jobs.json');
const pendingFile = (dataRoot: string) => join(dataRoot, 'cronjob/pending-deliveries.json');

function writeJobs(dataRoot: string, jobs: Record<string, unknown>[]): void {
  mkdirSync(join(dataRoot, 'cronjob'), { recursive: true });
  writeFileSync(jobsFile(dataRoot), JSON.stringify(jobs));
}

describe('cron delivery durability (Tier 1 #6)', () => {
  it('a recurring job whose delivery fails is retried on the NEXT tick WITHOUT re-running the model turn', async () => {
    const dataRoot = freshDataRoot();
    writeJobs(dataRoot, [{
      id: 'r1', name: 'report', schedule: 'every 5m', prompt: 'do it',
      lastRun: new Date(Date.now() - 10 * 60_000).toISOString(), createdAt: new Date().toISOString(),
    }]);
    let deliveryShouldFail = true;
    const delivered: string[] = [];
    const notify = async (t: string) => { if (deliveryShouldFail) throw new Error('discord 500'); delivered.push(t); };
    const { adapter, logger } = await loadCron(dataRoot, notify);
    let turnCalls = 0;
    adapter.listen(async () => { turnCalls += 1; return 'the report'; });

    await adapter.tick(); // delivery fails
    expect(turnCalls).toBe(1);
    expect(delivered).toEqual([]);
    expect(logger.error.mock.calls.some((c) => String(c[0]).includes('cron delivery failed'))).toBe(true);
    // The result survived the failed delivery, on disk, independent of the job record.
    const pendingAfterFail = JSON.parse(readFileSync(pendingFile(dataRoot), 'utf-8')) as { jobId: string; body: string }[];
    expect(pendingAfterFail).toHaveLength(1);
    expect(pendingAfterFail[0]!.body).toContain('the report');

    deliveryShouldFail = false;
    await adapter.tick(); // the job itself is not due again yet — only the pending delivery is retried
    expect(turnCalls).toBe(1); // the model turn did NOT run again
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('the report');
    expect(JSON.parse(readFileSync(pendingFile(dataRoot), 'utf-8'))).toEqual([]); // cleared once delivered
  });

  it('a ONE-SHOT job\'s result survives a delivery failure even though the job record is already gone', async () => {
    const dataRoot = freshDataRoot();
    writeJobs(dataRoot, [{
      id: 'j1', name: 'ping', schedule: 'in 30s', prompt: 'say hi',
      runAt: new Date(Date.now() - 1_000).toISOString(), createdAt: new Date().toISOString(),
    }]);
    let deliveryShouldFail = true;
    const delivered: string[] = [];
    const notify = async (t: string) => { if (deliveryShouldFail) throw new Error('discord 500'); delivered.push(t); };
    const { adapter } = await loadCron(dataRoot, notify);
    let turnCalls = 0;
    adapter.listen(async () => { turnCalls += 1; return 'wake-up done'; });

    await adapter.tick();
    expect(turnCalls).toBe(1);
    expect(JSON.parse(readFileSync(jobsFile(dataRoot), 'utf-8'))).toEqual([]); // one-shot consumed, as before
    const pending = JSON.parse(readFileSync(pendingFile(dataRoot), 'utf-8')) as { body: string }[];
    expect(pending).toHaveLength(1);
    expect(pending[0]!.body).toContain('wake-up done'); // the result is NOT lost even though the job is gone

    deliveryShouldFail = false;
    await adapter.tick(); // nothing due — this tick only flushes the pending delivery
    expect(turnCalls).toBe(1); // never re-ran the turn
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('wake-up done');
  });

  // The claim that stops two adapter generations from sending the same result must not become a permanent
  // hold: a generation can die mid-send (daemon crash, kill), and its entry would then sit claimed forever.
  it('retries a delivery whose claim has expired, but leaves one still held by a live owner', async () => {
    const dataRoot = freshDataRoot();
    mkdirSync(join(dataRoot, 'cronjob'), { recursive: true });
    writeJobs(dataRoot, []);
    const now = Date.now();
    writeFileSync(pendingFile(dataRoot), JSON.stringify([
      { id: 'stale', jobId: 'j1', jobName: 'crashed', body: 'orphaned result', createdAt: new Date(now - 600_000).toISOString(), leaseOwner: 'dead-generation', leaseUntil: now - 60_000 },
      { id: 'busy', jobId: 'j2', jobName: 'in flight', body: 'someone else is sending this', createdAt: new Date(now).toISOString(), leaseOwner: 'live-generation', leaseUntil: now + 300_000 },
    ]));
    const delivered: string[] = [];
    const { adapter } = await loadCron(dataRoot, async (t: string) => { delivered.push(t); });
    adapter.listen(async () => 'unused');

    await adapter.tick(); // nothing due — this tick only flushes the queue

    expect(delivered).toEqual(['orphaned result']); // the abandoned result is recovered, the held one is not
    const pending = JSON.parse(readFileSync(pendingFile(dataRoot), 'utf-8')) as { id: string }[];
    expect(pending.map((e) => e.id)).toEqual(['busy']);
  });

  it('the pending-delivery queue is bounded — the oldest entry is dropped, not accumulated forever', async () => {
    const dataRoot = freshDataRoot();
    mkdirSync(join(dataRoot, 'cronjob'), { recursive: true });
    const seeded = Array.from({ length: 50 }, (_, i) => ({
      id: `seed-${i}`, jobId: `seed-job-${i}`, jobName: `seed ${i}`, channelId: undefined,
      body: `old result ${i}`, createdAt: new Date(Date.now() - (50 - i) * 1000).toISOString(),
    }));
    writeFileSync(pendingFile(dataRoot), JSON.stringify(seeded));
    writeJobs(dataRoot, [{
      id: 'r1', name: 'report', schedule: 'every 5m', prompt: 'do it',
      lastRun: new Date(Date.now() - 10 * 60_000).toISOString(), createdAt: new Date().toISOString(),
    }]);
    const notify = async () => { throw new Error('sink still down'); }; // every delivery (old + new) fails
    const { adapter, logger } = await loadCron(dataRoot, notify);
    adapter.listen(async () => 'new result');

    await adapter.tick();
    const pending = JSON.parse(readFileSync(pendingFile(dataRoot), 'utf-8')) as { id: string; body: string }[];
    expect(pending).toHaveLength(50); // capped, not 51
    expect(pending.some((e) => e.id === 'seed-0')).toBe(false); // the oldest was evicted
    expect(pending.some((e) => e.body.includes('new result'))).toBe(true); // the new one made it in
    expect(logger.error.mock.calls.some((c) => String(c[0]).includes('pending delivery queue full'))).toBe(true);
  });
});

describe('cron state durability (Tier 2 #22)', () => {
  it('a corrupt jobs.json is reported to the logger and treated as empty, not left unexplained', async () => {
    const dataRoot = freshDataRoot();
    mkdirSync(join(dataRoot, 'cronjob'), { recursive: true });
    writeFileSync(jobsFile(dataRoot), '{not valid json');
    const { reg, logger } = await loadCron(dataRoot, async () => {});
    const list = reg.tools.find((t) => t.name === 'CronList')!;
    const text = await runWithPolicy(ADMIN, async () =>
      asText(await list.execute('t', {}, undefined as never, undefined as never)),
    { identity: OWNER, sessionId: 'brain-1' });
    expect(text).toBe('No scheduled jobs.'); // corruption is recoverable, not fatal
    expect(logger.error.mock.calls.some((c) => String(c[0]).includes('corrupt jobs file'))).toBe(true);
  });

  // Valid JSON of the WRONG SHAPE used to reach the tick untouched: iterating `{}` (or a null entry)
  // threw, and because the corruption sits on disk every following tick threw again — one bad file
  // silently stopped the whole scheduler.
  it('a jobs.json of the wrong shape does not stop the scheduler — malformed entries are skipped', async () => {
    const dataRoot = freshDataRoot();
    mkdirSync(join(dataRoot, 'cronjob'), { recursive: true });
    writeFileSync(jobsFile(dataRoot), JSON.stringify([null, {
      id: 'r1', name: 'report', schedule: 'every 5m', prompt: 'do it',
      lastRun: new Date(Date.now() - 10 * 60_000).toISOString(), createdAt: new Date().toISOString(),
    }]));
    const delivered: string[] = [];
    const { adapter, logger } = await loadCron(dataRoot, async (t: string) => { delivered.push(t); });
    adapter.listen(async () => 'the report');

    await adapter.tick();
    expect(delivered).toHaveLength(1); // the healthy job still ran
    expect(delivered[0]).toContain('the report');
    expect(logger.error.mock.calls.some((c) => String(c[0]).includes('skipping malformed job'))).toBe(true);
  });

  it('a pending-deliveries.json that is not an array is reported and treated as empty', async () => {
    const dataRoot = freshDataRoot();
    mkdirSync(join(dataRoot, 'cronjob'), { recursive: true });
    writeFileSync(pendingFile(dataRoot), '{}'); // valid JSON, wrong shape
    writeJobs(dataRoot, [{
      id: 'r1', name: 'report', schedule: 'every 5m', prompt: 'do it',
      lastRun: new Date(Date.now() - 10 * 60_000).toISOString(), createdAt: new Date().toISOString(),
    }]);
    const delivered: string[] = [];
    const { adapter, logger } = await loadCron(dataRoot, async (t: string) => { delivered.push(t); });
    adapter.listen(async () => 'the report');

    await adapter.tick(); // queueing the new result must not trip over the corrupt queue file
    expect(delivered).toHaveLength(1);
    expect(logger.error.mock.calls.some((c) => String(c[0]).includes('skipping malformed pending delivery'))).toBe(true);
    expect(JSON.parse(readFileSync(pendingFile(dataRoot), 'utf-8'))).toEqual([]); // delivered, so nothing left pending
  });

  it('jobs.json is written atomically: CronAdd never leaves a half-written file behind', async () => {
    const dataRoot = freshDataRoot();
    const { reg } = await loadCron(dataRoot, async () => {});
    const add = reg.tools.find((t) => t.name === 'CronAdd')!;
    await runWithPolicy(ADMIN, async () =>
      add.execute('t', { name: 'daily', schedule: 'daily 07:30', prompt: 'go' }, undefined as never, undefined as never),
    { identity: OWNER, sessionId: 'brain-1' });
    const jobs = JSON.parse(readFileSync(jobsFile(dataRoot), 'utf-8')) as { name: string }[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.name).toBe('daily');
  });
});
