import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { PluginHookBus } from '../../src/plugins/hookBus.js';
import { runWithPolicy, type TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';
import type { SubagentUpdate, SubagentCompletion } from '../../src/brain/events.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const adminPolicy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const owner: TurnIdentity = { platform: 'elowen', userId: '1', elowenUserId: 1, admin: true, owner: true };

// The job registry lives in a per-instance closure, so a plugin reload — which swaps the closure for a
// fresh one with an empty map — would make DelegateStatus/DelegateResult answer "may have expired" for
// every job the old instance was tracking, even though the child was just torn down by the reload. The
// plugin settles running jobs terminal in a `plugin.reload.before` hook and snapshots the registry to
// ctx.dataDir()/jobs.json; these tests exercise that boundary through the real hook bus.
describe('subagent plugin — job registry across a plugin reload', () => {
  let dataRoot: string;
  let warnings: string[];
  let updates: SubagentUpdate[];
  let completions: SubagentCompletion[];
  let resolveChild: ((reply: string) => void) | undefined;
  let childReply: Promise<string>;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'subagent-reload-'));
    warnings = [];
    updates = [];
    completions = [];
    childReply = new Promise((res) => { resolveChild = res; });
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });

  const load = () => loadPlugins({
    dirs: [join(repoRoot, 'plugins')], enabled: ['subagent'], dataRoot,
    logger: { info() {}, warn: (msg: string) => warnings.push(msg), error() {} },
    delegatedChildren: {
      runs: () => [],
      read: () => { throw new Error('not used in this suite'); },
      continue: async () => { throw new Error('not used in this suite'); },
      stop: async () => ({ stopped: false }),
    },
  });

  /** Start one background delegation whose child stays in flight until the test resolves `childReply` —
   *  the stand-in host hands the plugin the pending promise and reports the child's session up front. */
  const delegateBackground = async (reg: PluginRegistry, sessionId = 'brain-1') => {
    const platform = reg.platforms.find((p) => p.name === 'subagent');
    if (!platform) throw new Error('subagent platform not registered');
    platform.listen(async (_src, _task, onEvent) => {
      onEvent?.({ type: 'session', sessionId: 'brain-ch-subagent-sub-dlg-test' });
      return childReply;
    });
    const tool = reg.tools.find((t) => t.name === 'Delegate');
    if (!tool) throw new Error('Delegate tool not registered');
    const executor = tool as unknown as {
      execute: (id: string, p: unknown) => Promise<{ content: { text: string }[]; details?: Record<string, unknown> }>;
    };
    const res = await runWithPolicy(
      adminPolicy,
      () => executor.execute('call-1', { task: 'background task', background: true }),
      {
        identity: owner, sessionId,
        emitSubagent: (u) => updates.push(u),
        emitSubagentCompletion: (c) => completions.push(c),
      },
    );
    return res.details?.jobId as string;
  };

  const reload = (reg: PluginRegistry) =>
    new PluginHookBus({ hooks: reg.hooks }).emit('plugin.reload.before', {});

  const callTool = async (
    reg: PluginRegistry, name: string, params: Record<string, unknown>, sessionId: string,
  ) => {
    const tool = reg.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`${name} tool not registered`);
    const executor = tool as unknown as {
      execute: (id: string, p: unknown) => Promise<{ content: { text: string }[]; details?: Record<string, unknown> }>;
    };
    return runWithPolicy(
      adminPolicy,
      () => executor.execute('call', params),
      { identity: owner, sessionId },
    );
  };

  it('settles a running background job as interrupted at reload, delivers the completion and answers afterwards', async () => {
    const reg = await load();
    const jobId = await delegateBackground(reg);
    expect(jobId).toMatch(/^dlg-/);

    await reload(reg);

    // The parent is told the real reason through the durable sink, not a later cryptic 'delegation
    // aborted' from the host's abort cascade, and the rail row settles terminal.
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ id: jobId, status: 'error', error: 'interrupted by plugin reload' });
    expect(updates.at(-1)).toMatchObject({ status: 'error' });
    const logged = warnings.join('\n');
    expect(logged).toMatch(/still running at plugin reload/);
    expect(logged).toContain(jobId);

    // A freshly loaded instance (the post-reload one) keeps accounting for the id during the retention
    // window instead of answering "may have expired".
    const reg2 = await load();
    const res = await callTool(reg2, 'DelegateStatus', { id: jobId }, 'brain-1');
    expect(res.content[0]?.text).toContain(jobId);
    expect(res.content[0]?.text).toMatch(/ERROR/);
    expect(res.content[0]?.text).toContain('interrupted by plugin reload');
    expect(res.content[0]?.text).not.toContain('may have expired');

    // The old closure finishing afterwards must not flip the verdict or deliver a second completion.
    resolveChild?.('finished after reload');
    await new Promise((r) => setTimeout(r, 0));
    expect(completions).toHaveLength(1);
    expect(updates.at(-1)).toMatchObject({ status: 'error' });
    const firstError = updates.findIndex((u) => u.status === 'error');
    expect(firstError).toBeGreaterThanOrEqual(0);
    expect(updates.slice(firstError + 1).every((u) => u.status === 'error')).toBe(true);
    const again = await callTool(reg2, 'DelegateStatus', { id: jobId }, 'brain-1');
    expect(again.content[0]?.text).toContain('interrupted by plugin reload');
  });

  it('keeps answering for a job that finished before the reload', async () => {
    const reg = await load();
    const jobId = await delegateBackground(reg);
    resolveChild?.('the final answer');
    await new Promise((r) => setTimeout(r, 0));
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ id: jobId, status: 'done', result: 'the final answer' });

    await reload(reg);
    // A finished job is not settled again and the snapshot still preserves it.
    expect(warnings).toEqual([]);

    const reg2 = await load();
    const res = await callTool(reg2, 'DelegateResult', { id: jobId }, 'brain-1');
    expect(res.content[0]?.text).toBe('the final answer');
    expect(res.content[0]?.text).not.toContain('may have expired');
  });

  it('restores only valid terminal entries and keeps them scoped to their origin conversation', async () => {
    // The snapshot is external data: a hand-edited file must not inject a zombie 'running' row (the new
    // instance has no emitter to ever settle it) or junk, and a restored job stays private to its origin.
    const now = Date.now();
    mkdirSync(join(dataRoot, 'subagent'), { recursive: true });
    writeFileSync(join(dataRoot, 'subagent', 'jobs.json'), JSON.stringify([
      {
        id: 'dlg-kept', toolCallId: 'call-1', status: 'done', task: 'kept', sessionId: '',
        originSessionId: 'brain-1', originPrincipal: 'elowen:1',
        startedAt: now - 1_000, finishedAt: now, result: 'stored answer',
      },
      { id: 'dlg-running', toolCallId: 'call-2', status: 'running', task: 'zombie', originSessionId: 'brain-1', originPrincipal: 'elowen:1', startedAt: now },
      { id: 'dlg-nofin', toolCallId: 'call-3', status: 'done', task: 'no finishedAt', originSessionId: 'brain-1', originPrincipal: 'elowen:1', startedAt: now },
      { id: 'dlg-junk', status: 42 },
    ]));
    const reg = await load();

    const kept = await callTool(reg, 'DelegateResult', { id: 'dlg-kept' }, 'brain-1');
    expect(kept.content[0]?.text).toBe('stored answer');

    const foreign = await callTool(reg, 'DelegateResult', { id: 'dlg-kept' }, 'brain-2');
    expect(foreign.content[0]?.text).toMatch(/may have expired/);

    const zombie = await callTool(reg, 'DelegateStatus', { id: 'dlg-running' }, 'brain-1');
    expect(zombie.content[0]?.text).toMatch(/may have expired/);

    const noFinishedAt = await callTool(reg, 'DelegateStatus', { id: 'dlg-nofin' }, 'brain-1');
    expect(noFinishedAt.content[0]?.text).toMatch(/may have expired/);

    const junk = await callTool(reg, 'DelegateStatus', { id: 'dlg-junk' }, 'brain-1');
    expect(junk.content[0]?.text).toMatch(/may have expired/);
  });
});
