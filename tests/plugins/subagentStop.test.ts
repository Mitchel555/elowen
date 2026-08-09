import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy, type TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';
import type { SubagentUpdate, SubagentCompletion } from '../../src/brain/events.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const adminPolicy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const owner: TurnIdentity = { platform: 'elowen', userId: '1', elowenUserId: 1, admin: true, owner: true };
const CHILD_SESSION = 'brain-ch-subagent-sub-dlg-test';

// DelegateStop delivers the abort and returns at once, while the child unwinds a moment later. Everything
// that asks about the job in that window — the stopping agent's very next tool call included — must already
// see it as stopped, or the stop reads as a no-op and gets retried. These tests drive the real plugin
// through the real tool surface, because the window only exists between two separate tool calls.
describe('subagent plugin — DelegateStop settles the job it stopped', () => {
  let dataRoot: string;
  let updates: SubagentUpdate[];
  let completions: SubagentCompletion[];
  let resolveChild: ((reply: string) => void) | undefined;
  let rejectChild: ((error: Error) => void) | undefined;
  let childReply: Promise<string>;
  let stopCalls: string[];

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'subagent-stop-'));
    updates = [];
    completions = [];
    stopCalls = [];
    childReply = new Promise((res, rej) => { resolveChild = res; rejectChild = rej; });
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });

  const load = () => loadPlugins({
    dirs: [join(repoRoot, 'plugins')], enabled: ['subagent'], dataRoot,
    logger: { info() {}, warn() {}, error() {} },
    delegatedChildren: {
      runs: () => [],
      read: () => { throw new Error('not used in this suite'); },
      continue: async () => { throw new Error('not used in this suite'); },
      // The real host aborts the child session; the child's own run rejects a moment later, which this
      // suite drives explicitly so the ordering under test is not a race.
      stop: async (_parentSessionId: string, childSessionId: string) => { stopCalls.push(childSessionId); return { stopped: true }; },
    },
  });

  const toolExecutor = (reg: PluginRegistry, name: string) => {
    const tool = reg.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`${name} tool not registered`);
    return tool as unknown as {
      execute: (id: string, p: unknown) => Promise<{ content: { text: string }[]; details?: Record<string, unknown> }>;
    };
  };

  const inTurn = async <T>(fn: () => Promise<T>, sessionId = 'brain-1'): Promise<T> => runWithPolicy(
    adminPolicy,
    fn,
    {
      identity: owner, sessionId,
      emitSubagent: (u: SubagentUpdate) => updates.push(u),
      emitSubagentCompletion: (c: SubagentCompletion) => completions.push(c),
    },
  );

  const delegateBackground = async (reg: PluginRegistry) => {
    const platform = reg.platforms.find((p) => p.name === 'subagent');
    if (!platform) throw new Error('subagent platform not registered');
    platform.listen(async (_src, _task, onEvent) => {
      onEvent?.({ type: 'session', sessionId: CHILD_SESSION });
      return childReply;
    });
    const res = await inTurn(() => toolExecutor(reg, 'Delegate')
      .execute('call-1', { task: 'hold until released', background: true }));
    return res.details?.jobId as string;
  };

  it('reports the job as stopped to the very next status call, before the child has unwound', async () => {
    const reg = await load();
    const jobId = await delegateBackground(reg);

    const stop = await inTurn(() => toolExecutor(reg, 'DelegateStop').execute('call-2', { id: jobId }));
    expect(stop.content[0]?.text).toMatch(/^Stopped\./);
    expect(stopCalls).toEqual([CHILD_SESSION]);

    // The child is deliberately still in flight here — this is exactly the window the stopping agent's next
    // tool call lands in.
    const status = await inTurn(() => toolExecutor(reg, 'DelegateStatus').execute('call-3', { id: jobId }));
    expect(status.details).toMatchObject({ status: 'error' });
    expect(status.content[0]?.text).not.toMatch(/RUNNING/);
    expect(status.content[0]?.text).toContain('stopped by DelegateStop');
  });

  it('leaves the delivery to the unwinding child, so the stopping turn is not interrupted by its own stop', async () => {
    const reg = await load();
    const jobId = await delegateBackground(reg);

    await inTurn(() => toolExecutor(reg, 'DelegateStop').execute('call-2', { id: jobId }));
    // Waking the parent here would cut into the turn that issued the stop — it already has "Stopped." as
    // that tool call's answer.
    expect(completions).toHaveLength(0);

    rejectChild?.(new Error('aborted'));
    await new Promise((r) => setTimeout(r, 0));

    // Once the child is done unwinding the result travels the normal durable path, exactly once, and still
    // carries the stop's verdict rather than the raw abort text.
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ id: jobId, status: 'error', error: 'stopped by DelegateStop' });
    expect(updates.at(-1)).toMatchObject({ status: 'error' });
  });

  it('does not settle a job that already finished on its own', async () => {
    const reg = await load();
    const jobId = await delegateBackground(reg);
    resolveChild?.('the final answer');
    await new Promise((r) => setTimeout(r, 0));
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ id: jobId, status: 'done', result: 'the final answer' });

    const stop = await inTurn(() => toolExecutor(reg, 'DelegateStop').execute('call-2', { id: jobId }));
    // The host answers "nothing to stop" for a child that is gone; the finished verdict must survive it.
    expect(stop.content[0]?.text).toMatch(/^Stopped\.|^Nothing to stop/);
    expect(completions).toHaveLength(1);
    const status = await inTurn(() => toolExecutor(reg, 'DelegateStatus').execute('call-3', { id: jobId }));
    expect(status.details).toMatchObject({ status: 'done' });
  });
});
