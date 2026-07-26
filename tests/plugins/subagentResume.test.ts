import { describe, it, expect, beforeEach } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy, type TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';
import type { DelegatedChildSummary } from '../../src/store/brainDelegationStore.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const adminPolicy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const owner: TurnIdentity = { platform: 'elowen', userId: '1', elowenUserId: 1, admin: true, owner: true };

const child = (over: Partial<DelegatedChildSummary> & { sessionId: string }): DelegatedChildSummary => ({
  title: 'Some sub-agent', messages: 4, startedAt: '2026-07-26 20:00:00', updatedAt: '2026-07-26 20:05:00', ...over,
});

describe('subagent plugin — listing and continuing past sub-agents', () => {
  let reg: PluginRegistry;
  /** What the HOST would return for each parent session. The plugin never names a parent, so this map
   *  standing in for the store is also the assertion that scoping happens host-side. */
  let byParent: Map<string, DelegatedChildSummary[]>;
  let asked: { parent: string; limit?: number }[];
  let continued: { parent: string; child: string; text: string }[];
  let reply: string | Error;

  beforeEach(async () => {
    byParent = new Map();
    asked = [];
    continued = [];
    reply = 'the sub-agent answered';
    reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['subagent'], logger: log,
      delegatedChildren: {
        runs: (parent, limit) => { asked.push({ parent, limit }); return byParent.get(parent) ?? []; },
        continue: async (parent, childSessionId, text) => {
          continued.push({ parent, child: childSessionId, text });
          if (reply instanceof Error) throw reply;
          return reply;
        },
      },
    });
  });

  const call = (name: string, params: Record<string, unknown>, sessionId?: string) => {
    const tool = reg.tools.find((t) => t.name === name)!;
    return runWithPolicy(
      adminPolicy,
      () => (tool as unknown as { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[]; details?: Record<string, unknown> }> })
        .execute('call', params),
      { identity: owner, ...(sessionId ? { sessionId } : {}) },
    );
  };

  describe('DelegateList', () => {
    it('shows each past sub-agent with its id, task, outcome and transcript size', async () => {
      byParent.set('brain-1', [child({
        sessionId: 'brain-ch-subagent-sub-dlg-abc', task: 'Audit the auth module for missing checks',
        status: 'done', messages: 12, model: 'claude-sonnet',
      })]);
      const res = await call('DelegateList', {}, 'brain-1');
      const text = res.content[0]!.text;
      expect(text).toContain('brain-ch-subagent-sub-dlg-abc');
      expect(text).toContain('Audit the auth module for missing checks');
      expect(text).toContain('done');
      expect(text).toContain('12');
      expect(text).toContain('claude-sonnet');
    });

    // A child the engine never wrote a run row for (a workflow node) is still listable and continuable;
    // the session title is what identifies it.
    it('falls back to the session title when there is no recorded task', async () => {
      byParent.set('brain-1', [child({ sessionId: 'brain-ch-subagent-wf-w1-node', title: 'Ořezávání výsledků' })]);
      const res = await call('DelegateList', {}, 'brain-1');
      expect(res.content[0]!.text).toContain('Ořezávání výsledků');
    });

    it('says so plainly when this conversation has delegated nothing yet', async () => {
      const res = await call('DelegateList', {}, 'brain-1');
      expect(res.content[0]!.text).toMatch(/no sub-agents/i);
    });

    // THE security property: the tool takes no parent parameter, so the only conversation it can ever
    // report on is the one the current turn runs in. Two conversations, two disjoint answers.
    it('is scoped to the current conversation and cannot be pointed at another', async () => {
      byParent.set('brain-1', [child({ sessionId: 'brain-ch-subagent-sub-mine', task: 'mine' })]);
      byParent.set('brain-2', [child({ sessionId: 'brain-ch-subagent-sub-theirs', task: 'theirs' })]);

      const mine = await call('DelegateList', {}, 'brain-1');
      expect(mine.content[0]!.text).toContain('sub-mine');
      expect(mine.content[0]!.text).not.toContain('sub-theirs');

      const theirs = await call('DelegateList', {}, 'brain-2');
      expect(theirs.content[0]!.text).toContain('sub-theirs');
      expect(theirs.content[0]!.text).not.toContain('sub-mine');

      expect(asked.map((a) => a.parent)).toEqual(['brain-1', 'brain-2']);
    });

    it('lists nothing outside a conversation turn rather than falling back to some other parent', async () => {
      byParent.set('brain-1', [child({ sessionId: 'brain-ch-subagent-sub-mine' })]);
      const res = await call('DelegateList', {});
      expect(res.content[0]!.text).toMatch(/no sub-agents/i);
      expect(asked).toEqual([]);
    });
  });

  describe('DelegateContinue', () => {
    it('sends the follow-up to that child and returns what it answered', async () => {
      reply = 'checked the tests too — all green';
      const res = await call('DelegateContinue',
        { id: 'brain-ch-subagent-sub-dlg-abc', message: 'also check the tests' }, 'brain-1');
      expect(continued).toEqual([{
        parent: 'brain-1', child: 'brain-ch-subagent-sub-dlg-abc', text: 'also check the tests',
      }]);
      expect(res.content[0]!.text).toBe('checked the tests too — all green');
    });

    it('anchors the continuation on the CURRENT conversation, never on a caller-supplied parent', async () => {
      await call('DelegateContinue', { id: 'brain-ch-subagent-x', message: 'hi' }, 'brain-2');
      expect(continued[0]!.parent).toBe('brain-2');
    });

    // A refusal (foreign child, still running, scope now too wide) has to come back as a readable result
    // the agent can act on — waiting, or picking another child — not as a thrown tool failure.
    it('reports a host refusal as an actionable error instead of throwing', async () => {
      reply = new Error('that sub-agent is still running — wait for it to finish before sending it more');
      const res = await call('DelegateContinue', { id: 'brain-ch-subagent-busy', message: 'hi' }, 'brain-1');
      expect(res.content[0]!.text).toMatch(/^Error: /);
      expect(res.content[0]!.text).toMatch(/still running/);
    });

    it('refuses outside a conversation turn', async () => {
      const res = await call('DelegateContinue', { id: 'brain-ch-subagent-x', message: 'hi' });
      expect(res.content[0]!.text).toMatch(/^Error: /);
      expect(continued).toEqual([]);
    });

    it('refuses an empty follow-up rather than waking the child with nothing to do', async () => {
      const res = await call('DelegateContinue', { id: 'brain-ch-subagent-x', message: '   ' }, 'brain-1');
      expect(res.content[0]!.text).toMatch(/^Error: /);
      expect(continued).toEqual([]);
    });
  });
});
