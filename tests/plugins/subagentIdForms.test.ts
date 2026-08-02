import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy, type TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const log = { info() {}, warn() {}, error() {} };
const adminPolicy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const owner: TurnIdentity = { platform: 'elowen', userId: '1', elowenUserId: 1, admin: true, owner: true };

interface ToolResult { content: { text: string }[]; details?: Record<string, unknown> }
interface Executable { execute(id: string, p: unknown): Promise<ToolResult> }

const CHILD_SESSION = 'brain-ch-subagent-sub-dlg-known';
const flush = (): Promise<void> => new Promise<void>((r) => { setImmediate(r); });

/** Delegate hands back a JOB id while DelegateList shows the child's SESSION id. Both name the same
 *  sub-agent, so every tool that takes "which sub-agent" has to accept either — a caller holding the id
 *  its own delegate call returned should never be told the sub-agent is unknown. */
describe('subagent plugin — job id and session id both address the same child', () => {
  let dataRoot: string;
  let reg: PluginRegistry;
  let stopped: { parent: string; child: string }[];
  let read: { parent: string; child: string }[];

  const tool = (name: string): Executable => {
    const found = reg.tools.find((t) => t.name === name);
    if (!found) throw new Error(`${name} not registered`);
    return found as unknown as Executable;
  };

  const call = (name: string, params: Record<string, unknown>): Promise<ToolResult> => runWithPolicy(
    adminPolicy,
    () => tool(name).execute('call', params),
    { identity: owner, sessionId: 'brain-1', emitSubagent: () => {}, emitSubagentCompletion: () => {} },
  );

  /** Run one background delegation to completion and return the job id the caller is left holding. */
  const delegatedJobId = async (): Promise<string> => {
    const platform = reg.platforms.find((p) => p.name === 'subagent');
    if (!platform) throw new Error('subagent platform not registered');
    platform.listen(async (_src, _task, onEvent) => {
      onEvent?.({ type: 'session', sessionId: CHILD_SESSION });
      return 'the child conclusion';
    });
    const res = await call('Delegate', { task: 'some self-contained task', background: true });
    const jobId = res.details?.jobId;
    if (typeof jobId !== 'string') throw new Error('Delegate returned no jobId');
    for (let i = 0; i < 50 && stopped.length === 0 && read.length === 0; i += 1) await flush();
    return jobId;
  };

  beforeEach(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), 'subagent-id-forms-'));
    stopped = [];
    read = [];
    reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['subagent'], dataRoot, logger: log,
      delegatedChildren: {
        runs: () => [],
        read: (parent, childSessionId) => { read.push({ parent, child: childSessionId }); return 'the stored answer'; },
        continue: async () => { throw new Error('not used in this suite'); },
        stop: async (parent, childSessionId) => { stopped.push({ parent, child: childSessionId }); return { stopped: true }; },
      },
    });
  });

  afterEach(() => { rmSync(dataRoot, { recursive: true, force: true }); });

  it('translates the job id Delegate returned into the child session id the host expects', async () => {
    const jobId = await delegatedJobId();
    expect(jobId.startsWith('dlg-')).toBe(true);

    await call('DelegateStop', { id: jobId });

    // The host only ever knows session ids; handing it the raw `dlg-…` is what made a stop of one's own
    // sub-agent fail with "unknown sub-agent for this conversation".
    expect(stopped).toEqual([{ parent: 'brain-1', child: CHILD_SESSION }]);
  });

  it('accepts the session id form unchanged, so DelegateList ids keep working', async () => {
    await delegatedJobId();
    await call('DelegateStop', { id: CHILD_SESSION });
    expect(stopped).toEqual([{ parent: 'brain-1', child: CHILD_SESSION }]);
  });

  it('applies the same translation to DelegateRead', async () => {
    const jobId = await delegatedJobId();
    await call('DelegateRead', { id: jobId });
    expect(read).toEqual([{ parent: 'brain-1', child: CHILD_SESSION }]);
  });

  it('passes an id it cannot resolve straight through, leaving the host guard to answer', async () => {
    await call('DelegateStop', { id: 'dlg-never-started' });
    // Not rewritten into a plausible-looking session id: inventing one would turn "no such sub-agent"
    // into a lookup for a child that never existed, and could collide with a real one.
    expect(stopped).toEqual([{ parent: 'brain-1', child: 'dlg-never-started' }]);
  });
});
