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

const STALL_MS = 300;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A delegated turn had no timeout of its own: `run()` is awaited outright, and the collect-phase wait
 *  only bounds background process polling. So a child whose provider never answers held its slot for
 *  ever — sixty-four of those and delegation is locked with no way out but a manual Stop. The plugin now
 *  watches the child's own event stream for signs of life and aborts a turn that has gone quiet.
 *
 *  Real timers on purpose: the plugin is loaded as a native module, so vitest's fake timers do not reach
 *  the setInterval inside it — faking them here would test nothing and pass. The threshold is shortened
 *  through the same override an operator would use. */
describe('subagent plugin — stalled child watchdog', () => {
  let dataRoot: string;
  let warnings: string[];
  let updates: SubagentUpdate[];
  let completions: SubagentCompletion[];
  let stopped: string[];
  let rejectChild: ((e: Error) => void) | undefined;
  let resolveChild: ((reply: string) => void) | undefined;
  let childReply: Promise<string>;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'subagent-stall-'));
    warnings = [];
    updates = [];
    completions = [];
    stopped = [];
    process.env.ELOWEN_SUBAGENT_TURN_STALL_MS = String(STALL_MS);
    childReply = new Promise((res, rej) => { resolveChild = res; rejectChild = rej; });
    childReply.catch(() => {}); // the stall path rejects it; nothing else awaits it
  });

  afterEach(() => {
    delete process.env.ELOWEN_SUBAGENT_TURN_STALL_MS;
    resolveChild?.('');
    rmSync(dataRoot, { recursive: true, force: true });
  });

  const load = () => loadPlugins({
    dirs: [join(repoRoot, 'plugins')], enabled: ['subagent'], dataRoot,
    logger: { info() {}, warn: (msg: string) => warnings.push(msg), error() {} },
    delegatedChildren: {
      runs: () => [],
      read: () => { throw new Error('not used in this suite'); },
      continue: async () => { throw new Error('not used in this suite'); },
      // Stand in for the host's abort: stopping the child session is what makes the awaited run() settle.
      stop: async (_parent: string, sessionId: string) => {
        stopped.push(sessionId);
        rejectChild?.(new Error('delegation aborted'));
        return { stopped: true };
      },
    },
  });

  const delegate = async (reg: PluginRegistry, sessionId: string, onListen?: (emit: (e: unknown) => void) => void) => {
    const platform = reg.platforms.find((p) => p.name === 'subagent');
    if (!platform) throw new Error('subagent platform not registered');
    platform.listen(async (_src, _task, onEvent) => {
      onEvent?.({ type: 'session', sessionId });
      onListen?.((e) => onEvent?.(e as never));
      return childReply;
    });
    const tool = reg.tools.find((t) => t.name === 'Delegate');
    if (!tool) throw new Error('Delegate tool not registered');
    const executor = tool as unknown as {
      execute: (id: string, p: unknown) => Promise<{ details?: Record<string, unknown> }>;
    };
    const res = await runWithPolicy(
      adminPolicy,
      () => executor.execute('call-1', { task: 'a task', background: true }),
      { identity: owner, sessionId: 'brain-1', emitSubagent: (u) => updates.push(u), emitSubagentCompletion: (c) => completions.push(c) },
    );
    return res.details?.jobId as string;
  };

  it('aborts a child that has gone silent and reports the stall as the cause', async () => {
    const reg = await load();
    const child = 'brain-ch-subagent-sub-dlg-silent';
    const jobId = await delegate(reg, child);

    // Comfortably inside the threshold: a slow provider must not be mistaken for a wedged child.
    await settle(STALL_MS / 3);
    expect(stopped).toEqual([]);
    expect(completions).toHaveLength(0);

    await settle(STALL_MS * 2);

    expect(stopped).toEqual([child]);
    // The parent must learn the CAUSE, not the abort text the rejection happens to carry.
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ id: jobId, status: 'error' });
    expect(completions[0].error).toMatch(/stalled/i);
    expect(completions[0].error).not.toMatch(/delegation aborted/);
    expect(warnings.join('\n')).toMatch(/stalled/);
  });

  it('leaves a child that keeps working alone, however long it takes', async () => {
    const reg = await load();
    let emit: ((e: unknown) => void) | undefined;
    await delegate(reg, 'brain-ch-subagent-sub-dlg-busy', (e) => { emit = e; });

    // Several times the stall threshold of genuine work: each tool start renews the turn's liveness.
    for (let i = 0; i < 5; i += 1) {
      await settle(STALL_MS * 0.6);
      emit?.({ type: 'tool', name: 'Read' });
    }
    expect(stopped).toEqual([]);
    expect(completions).toHaveLength(0);

    resolveChild?.('done at last');
    await settle(20);
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ status: 'done', result: 'done at last' });
  });
});
