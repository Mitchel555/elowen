import { describe, it, expect, beforeEach } from 'vitest';
import { installLiveRecall, liveRecallQuery, type LiveRecallMemory } from '../../../src/brain/session/liveRecall.js';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Recall that runs WHILE a turn works. Two properties matter beyond "it recalls something":
 *  the injected block is only ever APPENDED (an insert earlier would invalidate the provider's cached
 *  prefix), and once rendered its bytes never change (a re-render would do the same on the next call).
 *  These tests assert both by comparing successive message arrays byte for byte. */

interface Msg { role?: string; content?: unknown }
type Handler = (event: { messages: unknown }) => Promise<{ messages: unknown } | undefined>;

const T0 = Date.parse('2026-08-02T12:00:00Z');

const mem = (id: number, body: string, over: Partial<LiveRecallMemory> = {}): LiveRecallMemory => ({
  id, body, kind: 'fact', importance: 3, updatedAt: '2026-08-02 11:00:00', ...over,
});

/** Captures the handler installLiveRecall registers, so a test can drive `context` calls directly. */
function harness(opts: {
  retrieve: (query: string, maxCount: number, charBudget: number) => Promise<LiveRecallMemory[]>;
  passes?: number; count?: number; chars?: number; enabled?: () => boolean;
}): { fire: (messages: Msg[]) => Promise<Msg[]> } {
  let handler: Handler = async () => undefined;
  const pi = {
    on: (event: string, fn: Handler) => { if (event === 'context') handler = fn; },
  } as unknown as ExtensionAPI;

  installLiveRecall(pi, {
    budget: () => ({ passes: opts.passes ?? 3, count: opts.count ?? 8, chars: opts.chars ?? 6000 }),
    enabled: opts.enabled ?? (() => true),
    retrieve: opts.retrieve,
    now: () => T0,
  });

  return {
    fire: async (messages: Msg[]) => {
      const out = await handler({ messages });
      return (out?.messages as Msg[] | undefined) ?? messages;
    },
  };
}

const textOf = (m: Msg): string => (typeof m.content === 'string' ? m.content : '');

describe('live recall — memories arrive mid-turn', () => {
  let queries: string[];
  beforeEach(() => { queries = []; });

  it('injects nothing on the first call but recalls once the work has produced tool output', async () => {
    const { fire } = harness({
      retrieve: async (q) => {
        queries.push(q);
        return q.includes('release.sh') ? [mem(1, 'Deployment runs through release.sh')] : [];
      },
    });

    // Call 1: only the user's message exists. Its text is deliberately excluded from the query (turn-start
    // recall already used it), so there is nothing to search with and nothing is added.
    const first = await fire([{ role: 'user', content: 'fix it' }]);
    expect(first).toHaveLength(1);

    // Call 2: a tool result has landed. NOW there is something to search with, and the memory arrives
    // in the middle of the turn — which is the whole point of the feature.
    const second = await fire([
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: 'Looking at the deploy path' },
      { role: 'toolResult', content: 'bash: ./release.sh --dry-run failed with exit 2' },
    ]);

    expect(second).toHaveLength(4);
    expect(textOf(second[3] as Msg)).toContain('Deployment runs through release.sh');
    expect(second[3]?.role).toBe('user');
  });

  it('leaves the earlier messages byte-identical and only ever appends', async () => {
    const { fire } = harness({ retrieve: async () => [mem(1, 'A durable fact')] });

    const base: Msg[] = [
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: 'working on the deployment pipeline now' },
      { role: 'toolResult', content: 'some tool output about the pipeline' },
    ];
    const out = await fire(base);

    // The cached prefix is everything before the appended block. If any of it moved or was rewritten,
    // the provider would match a shorter prefix and the cache would drop — the exact failure this
    // feature must not cause.
    expect(JSON.stringify(out.slice(0, base.length))).toBe(JSON.stringify(base));
    expect(out).toHaveLength(base.length + 1);
  });

  it('re-emits an already injected block verbatim instead of re-rendering it', async () => {
    let call = 0;
    const { fire } = harness({
      retrieve: async () => { call += 1; return call === 1 ? [mem(1, 'First fact')] : [mem(2, 'Second fact')]; },
    });

    const a = await fire([
      { role: 'user', content: 'go' },
      { role: 'toolResult', content: 'output mentioning the deployment pipeline in detail' },
    ]);
    const injectedFirst = textOf(a[a.length - 1] as Msg);

    const b = await fire([
      { role: 'user', content: 'go' },
      { role: 'toolResult', content: 'output mentioning the deployment pipeline in detail' },
      { role: 'toolResult', content: 'a second, different tool result about migrations and the database' },
    ]);
    const injectedSecond = textOf(b[b.length - 1] as Msg);

    // The second block must CONTAIN the first one unchanged — same bytes, same order, appended to.
    expect(injectedSecond.startsWith(injectedFirst.split('</user_memories>')[0] ?? '')).toBe(true);
    expect(injectedSecond).toContain('First fact');
    expect(injectedSecond).toContain('Second fact');
  });

  it('never injects the same memory twice', async () => {
    const { fire } = harness({ retrieve: async () => [mem(1, 'The one fact')] });

    await fire([{ role: 'user', content: 'go' }, { role: 'toolResult', content: 'first tool output about deployment' }]);
    const out = await fire([
      { role: 'user', content: 'go' },
      { role: 'toolResult', content: 'first tool output about deployment' },
      { role: 'toolResult', content: 'second tool output, entirely different subject: database migrations' },
    ]);

    const injected = textOf(out[out.length - 1] as Msg);
    expect(injected.match(/The one fact/g)).toHaveLength(1);
  });
});

describe('live recall — budget and switches', () => {
  it('stops searching once the pass budget is spent', async () => {
    let calls = 0;
    const { fire } = harness({ passes: 2, retrieve: async () => { calls += 1; return []; } });

    for (let i = 0; i < 5; i += 1) {
      await fire([
        { role: 'user', content: 'go' },
        { role: 'toolResult', content: `distinct tool output number ${i} about a completely different subject each time` },
      ]);
    }
    expect(calls).toBe(2);
  });

  it('adds nothing when the owner has the feature switched off', async () => {
    const { fire } = harness({ enabled: () => false, retrieve: async () => [mem(1, 'Never seen')] });
    const base: Msg[] = [{ role: 'user', content: 'go' }, { role: 'toolResult', content: 'plenty of tool output here' }];
    expect(await fire(base)).toEqual(base);
  });

  it('adds nothing when the operator set the pass budget to zero', async () => {
    const { fire } = harness({ passes: 0, retrieve: async () => [mem(1, 'Never seen')] });
    const base: Msg[] = [{ role: 'user', content: 'go' }, { role: 'toolResult', content: 'plenty of tool output here' }];
    expect(await fire(base)).toEqual(base);
  });

  it('resets its budget when a new user message starts a fresh turn', async () => {
    let calls = 0;
    const { fire } = harness({ passes: 1, retrieve: async () => { calls += 1; return []; } });

    await fire([{ role: 'user', content: 'first' }, { role: 'toolResult', content: 'output about the first subject entirely' }]);
    expect(calls).toBe(1);

    // Same session, second turn: the budget must be available again, otherwise one long conversation
    // would permanently exhaust recall after its first turn.
    await fire([
      { role: 'user', content: 'first' },
      { role: 'toolResult', content: 'output about the first subject entirely' },
      { role: 'user', content: 'second' },
      { role: 'toolResult', content: 'output about a totally separate second subject' },
    ]);
    expect(calls).toBe(2);
  });

  it('gives up on a hanging retrieval instead of holding the turn', async () => {
    // Recall is awaited on the model's critical path, and the embedding client's own deadline is 30s.
    // Waiting that long for a best-effort lookup would stall every pass of every turn, so this must
    // resolve well before the retrieval does.
    const { fire } = harness({
      retrieve: () => new Promise((resolve) => { setTimeout(() => resolve([mem(1, 'Too late')]), 20_000); }),
    });
    const base: Msg[] = [{ role: 'user', content: 'go' }, { role: 'toolResult', content: 'plenty of tool output here' }];

    const started = Date.now();
    const out = await fire(base);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(out).toEqual(base);
  }, 15_000);

  it('keeps already injected memories when the user steers mid-turn, and searches with the new instruction', async () => {
    const seen: string[] = [];
    let call = 0;
    const { fire } = harness({
      retrieve: async (q) => { seen.push(q); call += 1; return call === 1 ? [mem(1, 'First fact')] : [mem(2, 'Second fact')]; },
    });

    const before: Msg[] = [
      { role: 'user', content: 'start the deployment work' },
      { role: 'toolResult', content: 'output about the deployment pipeline in some detail' },
    ];
    const a = await fire(before);
    expect(textOf(a[a.length - 1] as Msg)).toContain('First fact');

    // The user interrupts. Dropping what was already injected would strip memories the model is working
    // with, and searching without the new instruction would answer a question nobody is asking any more.
    const after: Msg[] = [
      ...before,
      { role: 'user', content: 'actually switch to the database migration instead' },
      { role: 'toolResult', content: 'output about the deployment pipeline in some detail' },
    ];
    const b = await fire(after);
    const injected = textOf(b[b.length - 1] as Msg);

    expect(injected).toContain('First fact');
    expect(injected).toContain('Second fact');
    expect(seen[seen.length - 1]).toContain('database migration');
  });

  it('survives a failing retrieval without taking the turn down', async () => {
    const { fire } = harness({ retrieve: async () => { throw new Error('embedding endpoint down'); } });
    const base: Msg[] = [{ role: 'user', content: 'go' }, { role: 'toolResult', content: 'plenty of tool output here' }];
    expect(await fire(base)).toEqual(base);
  });
});

describe('liveRecallQuery', () => {
  it('searches from the work, not from the user message the turn already searched with', () => {
    const q = liveRecallQuery([
      { role: 'user', content: 'oprav to' },
      { role: 'assistant', content: 'checking the migration' },
      { role: 'toolResult', content: 'error in migrations/007.sql' },
    ]);
    expect(q).not.toContain('oprav to');
    expect(q).toContain('migrations/007.sql');
    expect(q).toContain('checking the migration');
  });
});
