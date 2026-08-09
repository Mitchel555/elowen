import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy, type TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';
import type { DelegatedChildSummary } from '../../src/store/brainDelegationStore.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const adminPolicy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const owner: TurnIdentity = { platform: 'elowen', userId: '1', elowenUserId: 1, admin: true, owner: true };
const PARENT = 'brain-1';
const JOB_ID = 'dlg-11111111-2222-3333-4444-555555555555';
// The session id the host mints for that job: channelId `sub-<jobId>` under the subagent platform prefix.
const CHILD_SESSION = `brain-ch-subagent-sub-${JOB_ID}`;

// After a daemon restart the delegating plugin's in-memory jobs map is empty, but the child session and
// its result outlived the restart in the store. These tests prove a follow-up by the ORIGINAL job id
// (`dlg-*`) still resolves — the handle the parent naturally kept — rather than forcing it to dig the full
// session id out of DelegateList first. The empty jobs map is simulated by never delegating in-process.
describe('subagent plugin — job-id handles survive a restart', () => {
  let dataRoot: string;
  let continued: { sessionId: string; text: string } | undefined;
  let readFor: string | undefined;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'subagent-restart-'));
    continued = undefined;
    readFor = undefined;
  });
  afterEach(() => rmSync(dataRoot, { recursive: true, force: true }));

  const load = () => loadPlugins({
    dirs: [join(repoRoot, 'plugins')], enabled: ['subagent'], dataRoot,
    logger: { info() {}, warn() {}, error() {} },
    delegatedChildren: {
      // The durable run list the host rebuilds from the store — the child is there after the restart.
      runs: (): DelegatedChildSummary[] => [{
        sessionId: CHILD_SESSION, title: 'hold until released', status: 'done',
        messages: 80, model: 'mock-model', startedAt: '', updatedAt: '',
      }],
      read: (_parent: string, sessionId: string) => { readFor = sessionId; return 'the durable final answer'; },
      continue: async (_parent: string, sessionId: string, text: string) => {
        continued = { sessionId, text };
        return { status: 'reply', reply: 'resumed' } as const;
      },
      stop: async () => ({ stopped: true }),
    },
  });

  const exec = (reg: PluginRegistry, name: string, p: unknown) => {
    const tool = reg.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`${name} not registered`);
    const t = tool as unknown as { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[]; details?: Record<string, unknown> }> };
    return runWithPolicy(adminPolicy, () => t.execute('call-1', p), {
      identity: owner, sessionId: PARENT,
      emitSubagent: () => {}, emitSubagentCompletion: () => {},
    });
  };

  it('DelegateContinue by job id resolves to the child session id, not the raw dlg- handle', async () => {
    const reg = await load();
    await exec(reg, 'DelegateContinue', { id: JOB_ID, message: 'carry on' });
    expect(continued).toEqual({ sessionId: CHILD_SESSION, text: 'carry on' });
  });

  it('DelegateResult by job id reads the durable stored text after the in-memory job is gone', async () => {
    const reg = await load();
    const res = await exec(reg, 'DelegateResult', { id: JOB_ID });
    expect(readFor).toBe(CHILD_SESSION);
    expect(res.content[0]?.text).toBe('the durable final answer');
  });

  it('DelegateStatus by job id reports the run is no longer live rather than "expired"', async () => {
    const reg = await load();
    const res = await exec(reg, 'DelegateStatus', { id: JOB_ID });
    expect(res.content[0]?.text).not.toMatch(/may have expired/);
    expect(res.content[0]?.text).toMatch(/no longer tracked live|DelegateResult/);
    expect(res.details).toMatchObject({ sessionId: CHILD_SESSION });
  });
});
