import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';
import { runWithPolicy, type TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import { SubagentDispatch } from '../../src/subagent/dispatch.js';
import type { DelegatedTurnRunner } from '../../src/brain/delegatedTurn.js';

// The REAL chain, end to end: loadPlugins → registry.contextFor → the subagent plugin's workflow engine,
// with ctx.delegatedTurnsOutOfProcess wired to a live SubagentDispatch — the same shape brainCore wires in
// production (predictsRunnerDispatch is shared by both, and loader makes the option required so brainCore
// cannot silently drop it). What the engine-level tests in workflowEngine.test.ts assert against a mocked
// ctx, this file asserts against the loaded plugin and the real dispatcher, so deleting any link of the
// wiring — the loader pass-through, the registry context field, the plugin's read — goes red here.

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const adminPolicy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const owner: TurnIdentity = { platform: 'elowen', userId: '1', elowenUserId: 1, admin: true, owner: true };
const nodeIdentity: TurnIdentity = { platform: 'subagent', userId: 'subagent' };

const filesDir = mkdtempSync(join(tmpdir(), 'elowen-wf-wiring-'));
afterAll(() => { rmSync(filesDir, { recursive: true, force: true }); });
let fileCount = 0;
const workflowFile = (nodes: unknown): string => {
  const path = join(filesDir, `wf-${fileCount++}.json`);
  writeFileSync(path, JSON.stringify(nodes));
  return path;
};

interface CapturedSource { channelId?: string; access?: { context?: string[]; toolPolicy?: { allow?: string[]; deny?: string[] } } }
type RunHandler = (src: CapturedSource, text: string, onEvent: (e: unknown) => void) => Promise<string>;
interface ExecutableTool { name: string; execute(id: string, p: unknown): Promise<{ content: { text: string }[] }> }

/** The operator's live switches, mutated per test — the dispatcher and the plugin both read them live. */
const state = { runnerEnabled: true, poolUsable: true };

const runner: DelegatedTurnRunner = {
  run: async () => 'remote',
  abort: () => {},
  steer: async () => ({ outcome: 'idle' as const }),
  release: async () => ({ busy: false }),
  reset: () => {},
  usable: () => state.poolUsable,
};

const dispatch = new SubagentDispatch({
  runTurn: async () => 'local',
  fenceRemote: (_req, run) => run(),
  runner,
  runnerEnabled: () => state.runnerEnabled,
});

const registry: PluginRegistry = await loadPlugins({
  dirs: [join(repoRoot, 'plugins')],
  enabled: ['subagent'],
  logger: log,
  // Production wiring shape (brainCore): the prediction IS the dispatcher's own answer.
  delegatedTurnsOutOfProcess: () => dispatch.mode() === 'runner',
});

const captured: { sources: CapturedSource[]; tasks: string[] } = { sources: [], tasks: [] };
/** Parks the task named `gate.task` until released — lets a test extend the DAG while a node runs. */
let gate: { task: string; release: Promise<void> } | null = null;
const handler: RunHandler = async (src, task, onEvent) => {
  captured.sources.push(src);
  captured.tasks.push(task);
  const bare = task.split('\n')[0] ?? task;
  onEvent({ type: 'session', sessionId: `s-${bare}` });
  if (gate && bare === gate.task) await gate.release;
  return `done:${bare}`;
};
registry.platforms.find((p) => p.name === 'subagent')!.listen(handler as unknown as Parameters<PluginRegistry['platforms'][number]['listen']>[0]);

const tool = (name: string): ExecutableTool => registry.tools.find((t) => t.name === name) as unknown as ExecutableTool;
const asOwner = <T,>(fn: () => Promise<T>) => runWithPolicy(adminPolicy, fn, { identity: owner, sessionId: 'brain-1' });
const asNode = <T,>(sessionId: string, fn: () => Promise<T>) => runWithPolicy(adminPolicy, fn, { identity: nodeIdentity, sessionId });

beforeEach(() => { captured.sources.length = 0; captured.tasks.length = 0; gate = null; });

describe('workflow expansion contract through the real loader/registry/dispatch wiring', () => {
  it('a node predicted REMOTE gets no invitation and a WorkflowAddNodes deny in its access', async () => {
    state.runnerEnabled = true;
    state.poolUsable = true;
    expect(dispatch.mode()).toBe('runner');
    const res = await asOwner(() => tool('WorkflowStart').execute('t-remote', { nodesFile: workflowFile([{ id: 'n', task: 'remote-node' }]) }));
    expect(res.content[0]?.text).toMatch(/status: done/);
    const access = captured.sources[0]?.access;
    expect((access?.context ?? []).join('\n')).not.toContain('WorkflowAddNodes');
    expect(access?.toolPolicy?.deny).toContain('WorkflowAddNodes');
  });

  it('with the runner switch OFF the node is invited, holds the tool, and can really extend the DAG', async () => {
    state.runnerEnabled = false;
    expect(dispatch.mode()).toBe('in-process');
    let release!: () => void;
    gate = { task: 'root', release: new Promise<void>((r) => { release = r; }) };
    const startP = asOwner(() => tool('WorkflowStart').execute('t-local', { nodesFile: workflowFile([{ id: 'root', task: 'root' }]) }));
    await new Promise((r) => setTimeout(r, 10)); // let root launch and park on the gate
    const access = captured.sources[0]?.access;
    expect(access?.toolPolicy?.deny ?? []).not.toContain('WorkflowAddNodes');
    const invitation = (access?.context ?? []).join('\n');
    expect(invitation).toContain('WorkflowAddNodes');
    // The invitation names the workflow id — the node uses exactly that handle to expand, from its own
    // child session, against the REAL engine the loaded plugin registered.
    const wfId = /workflow \(id "(wf-[^"]+)"\)/.exec(invitation)?.[1];
    expect(wfId).toBeDefined();
    const added = await asNode('s-root', () => tool('WorkflowAddNodes').execute('a1', {
      workflowId: wfId, nodes: [{ id: 'leaf', task: 'leaf', deps: ['root'] }],
    }));
    expect(added.content[0]?.text).toMatch(/Added 1 node/);
    release();
    const res = await startP;
    expect(res.content[0]?.text).toMatch(/status: done/);
    expect(res.content[0]?.text).toContain('done:leaf');
  });

  // The reviewer's combined case: a runner that cannot take work AT ALL (pool sized to zero) routes
  // in-process — and because prediction and routing share one predicate, the node is correctly invited
  // and keeps the tool, instead of losing the feature exactly when the pool degrades.
  it('a runner reporting unusable routes in-process AND the node may still expand', async () => {
    state.runnerEnabled = true;
    state.poolUsable = false;
    expect(dispatch.mode()).toBe('in-process');
    await asOwner(() => tool('WorkflowStart').execute('t-degraded', { nodesFile: workflowFile([{ id: 'n', task: 'degraded-node' }]) }));
    const access = captured.sources[0]?.access;
    expect((access?.context ?? []).join('\n')).toContain('WorkflowAddNodes');
    expect(access?.toolPolicy?.deny ?? []).not.toContain('WorkflowAddNodes');
  });
});
