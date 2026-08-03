import { describe, it, expect, beforeEach } from 'vitest';
import { installLiveRecall, liveRecallQuery, type LiveRecallMemory } from '../../../src/brain/session/liveRecall.js';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Recall that runs WHILE a turn works. Two properties matter beyond "it recalls something":
 *  the injected block is only ever APPENDED (an insert earlier would invalidate the provider's cached
 *  prefix), and once rendered its bytes never change (a re-render would do the same on the next call).
 *  These tests assert both by comparing successive message arrays byte for byte.
 *
 *  The retrieval is NON-BLOCKING: the pass that starts a search returns immediately, and a later call
 *  consumes the result once it has settled. A memory therefore lands one call after the pass that
 *  searched for it, which is why these tests fire the hook twice where the result is asserted. */

interface Msg { role?: string; content?: unknown }
type Handler = (event: { messages: unknown }) => Promise<{ messages: unknown } | undefined>;

const T0 = Date.parse('2026-08-02T12:00:00Z');

const mem = (id: number, body: string, over: Partial<LiveRecallMemory> = {}): LiveRecallMemory => ({
  id, body, kind: 'fact', importance: 3, updatedAt: '2026-08-02 11:00:00', ...over,
});

/** A promise the test settles by hand, so it can hold a retrieval in flight across hook calls. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve: (v: T) => void = () => {};
  let reject: (e: Error) => void = () => {};
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let a settled retrieval's continuation run before the next hook call observes it. */
const flush = async (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

/** Captures the handler installLiveRecall registers, so a test can drive `context` calls directly. */
function harness(opts: {
  retrieve: (query: string, maxCount: number, charBudget: number) => Promise<LiveRecallMemory[]>;
  passes?: number; count?: number; chars?: number; enabled?: () => boolean; now?: () => number;
}): { fire: (messages: Msg[]) => Promise<Msg[]> } {
  let handler: Handler = async () => undefined;
  const pi = {
    on: (event: string, fn: Handler) => { if (event === 'context') handler = fn; },
  } as unknown as ExtensionAPI;

  installLiveRecall(pi, {
    budget: () => ({ passes: opts.passes ?? 3, count: opts.count ?? 8, chars: opts.chars ?? 6000 }),
    enabled: opts.enabled ?? (() => true),
    retrieve: opts.retrieve,
    now: opts.now ?? (() => T0),
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

    // Call 2: a tool result has landed — NOW there is something to search with. The search is only
    // STARTED here; the hook returns without waiting on the embedding endpoint.
    const working: Msg[] = [
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: 'Looking at the deploy path' },
      { role: 'toolResult', content: 'bash: ./release.sh --dry-run failed with exit 2' },
    ];
    const second = await fire(working);
    expect(second).toHaveLength(3);

    // Call 3: the retrieval has settled and the memory arrives in the middle of the turn — one model
    // call after the pass that searched for it, the deliberate price of not blocking that pass.
    const third = await fire(working);
    expect(third).toHaveLength(4);
    expect(textOf(third[3] as Msg)).toContain('Deployment runs through release.sh');
    expect(third[3]?.role).toBe('user');
  });

  it('leaves the earlier messages byte-identical and only ever appends', async () => {
    const { fire } = harness({ retrieve: async () => [mem(1, 'A durable fact')] });

    const base: Msg[] = [
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: 'working on the deployment pipeline now' },
      { role: 'toolResult', content: 'some tool output about the pipeline' },
    ];
    await fire(base);
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

    const first: Msg[] = [
      { role: 'user', content: 'go' },
      { role: 'toolResult', content: 'output mentioning the deployment pipeline in detail' },
    ];
    await fire(first);
    const a = await fire(first);
    const injectedFirst = textOf(a[a.length - 1] as Msg);

    const grown: Msg[] = [
      ...first,
      { role: 'toolResult', content: 'a second, different tool result about migrations and the database' },
    ];
    await fire(grown);
    const b = await fire(grown);
    const injectedSecond = textOf(b[b.length - 1] as Msg);

    // The second block must CONTAIN the first one unchanged — same bytes, same order, appended to.
    expect(injectedSecond.startsWith(injectedFirst.split('</user_memories>')[0] ?? '')).toBe(true);
    expect(injectedSecond).toContain('First fact');
    expect(injectedSecond).toContain('Second fact');
  });

  it('appends the staleness warning to an old memory but not to a fresh one', async () => {
    const { fire } = harness({
      retrieve: async () => [
        mem(1, 'Fresh fact from an hour ago'),
        mem(2, 'Old claim about the deploy path', { updatedAt: '2026-06-01 12:00:00' }),
      ],
    });

    const base: Msg[] = [
      { role: 'user', content: 'go' },
      { role: 'toolResult', content: 'plenty of tool output about the deployment pipeline' },
    ];
    await fire(base);
    const out = await fire(base);
    const injected = textOf(out[out.length - 1] as Msg);

    // 2026-06-01 → 2026-08-02 is 62 days: old enough that the environment has plausibly moved on.
    expect(injected).toContain('Old claim about the deploy path\nThis memory was last updated 62 days ago');
    expect(injected).toContain('point-in-time observation');
    // The fresh memory must NOT carry the warning — flagging everything trains the model to skim it.
    expect(injected).not.toContain('Fresh fact from an hour ago\nThis memory was last updated');
  });

  it('never injects the same memory twice', async () => {
    const { fire } = harness({ retrieve: async () => [mem(1, 'The one fact')] });

    const first: Msg[] = [{ role: 'user', content: 'go' }, { role: 'toolResult', content: 'first tool output about deployment' }];
    await fire(first);
    await fire(first);
    const grown: Msg[] = [
      ...first,
      { role: 'toolResult', content: 'second tool output, entirely different subject: database migrations' },
    ];
    await fire(grown);
    const out = await fire(grown);

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
    await fire(before);
    const a = await fire(before);
    expect(textOf(a[a.length - 1] as Msg)).toContain('First fact');

    // The user interrupts. Dropping what was already injected would strip memories the model is working
    // with, and searching without the new instruction would answer a question nobody is asking any more.
    const after: Msg[] = [
      ...before,
      { role: 'user', content: 'actually switch to the database migration instead' },
      { role: 'toolResult', content: 'output about the deployment pipeline in some detail' },
    ];
    await fire(after);
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

describe('live recall — the retrieval never blocks the hook', () => {
  it('injects nothing while the retrieval is in flight, then consumes it once settled', async () => {
    const d = deferred<LiveRecallMemory[]>();
    let calls = 0;
    const { fire } = harness({ retrieve: () => { calls += 1; return d.promise; } });
    const base: Msg[] = [{ role: 'user', content: 'go' }, { role: 'toolResult', content: 'plenty of tool output about deployment' }];

    // The issue pass starts the search and returns without waiting on it.
    expect(await fire(base)).toEqual(base);
    // Still in flight: nothing new is injected, and the hook resolves without the retrieval settling.
    expect(await fire(base)).toEqual(base);
    expect(calls).toBe(1);

    d.resolve([mem(1, 'Deployment fact')]);
    await flush();
    const out = await fire(base);
    expect(out).toHaveLength(3);
    expect(textOf(out[2] as Msg)).toContain('Deployment fact');
  });

  it('starts no second retrieval while one is in flight, even when the work has moved on', async () => {
    const d = deferred<LiveRecallMemory[]>();
    let calls = 0;
    const { fire } = harness({ retrieve: () => { calls += 1; return d.promise; } });

    await fire([{ role: 'user', content: 'go' }, { role: 'toolResult', content: 'output about the deployment pipeline' }]);
    // A grown transcript produces a DIFFERENT query, so only the in-flight slot can be what stops
    // a second search from being issued here.
    await fire([
      { role: 'user', content: 'go' },
      { role: 'toolResult', content: 'output about the deployment pipeline' },
      { role: 'toolResult', content: 'entirely new output about database migrations' },
    ]);
    expect(calls).toBe(1);
  });

  it('a rejected retrieval crashes nothing and frees the slot for the next search', async () => {
    const d = deferred<LiveRecallMemory[]>();
    let calls = 0;
    const { fire } = harness({
      retrieve: () => { calls += 1; return calls === 1 ? d.promise : Promise.resolve([mem(2, 'Second search fact')]); },
    });
    const base: Msg[] = [{ role: 'user', content: 'go' }, { role: 'toolResult', content: 'output about the deployment pipeline' }];

    await fire(base);
    d.reject(new Error('embedding endpoint down'));
    await flush();
    // The consume pass takes the failure off the slot and injects nothing.
    expect(await fire(base)).toEqual(base);

    // The slot is free again: new work issues a new search whose result lands normally.
    const grown: Msg[] = [...base, { role: 'toolResult', content: 'entirely new output about database migrations' }];
    await fire(grown);
    expect(calls).toBe(2);
    const out = await fire(grown);
    expect(textOf(out[out.length - 1] as Msg)).toContain('Second search fact');
  });

  it('abandons a retrieval that never settles instead of wedging recall for the session', async () => {
    let clock = T0;
    const d = deferred<LiveRecallMemory[]>();
    let calls = 0;
    const { fire } = harness({
      now: () => clock,
      retrieve: () => { calls += 1; return calls === 1 ? d.promise : Promise.resolve([mem(2, 'Fresh search fact')]); },
    });
    const base: Msg[] = [{ role: 'user', content: 'go' }, { role: 'toolResult', content: 'output about the deployment pipeline' }];
    const grown: Msg[] = [...base, { role: 'toolResult', content: 'entirely new output about database migrations' }];

    await fire(base);
    // Within the abandon window the slot is held and no new search starts.
    await fire(grown);
    expect(calls).toBe(1);

    // Past the embedding client's own 30s deadline the promise is never going to settle; the slot is
    // reclaimed and a new search may start.
    clock += 31_000;
    await fire(grown);
    expect(calls).toBe(2);
    const out = await fire(grown);
    expect(textOf(out[out.length - 1] as Msg)).toContain('Fresh search fact');

    // The abandoned promise settling late must not resurrect its result.
    d.resolve([mem(9, 'Too late fact')]);
    await flush();
    const after = await fire(grown);
    expect(JSON.stringify(after)).not.toContain('Too late fact');
  });

  it('discards a result retrieved for a turn the user has since redirected', async () => {
    const d = deferred<LiveRecallMemory[]>();
    const seen: string[] = [];
    const { fire } = harness({
      retrieve: (q) => { seen.push(q); return seen.length === 1 ? d.promise : Promise.resolve([mem(2, 'Migration fact')]); },
    });
    const before: Msg[] = [{ role: 'user', content: 'go' }, { role: 'toolResult', content: 'output about the deployment pipeline' }];
    await fire(before);

    // Steering resets the turn while search 1 is in flight. Its eventual result answers the
    // pre-steer question and must be dropped, not injected into the redirected turn.
    const after: Msg[] = [
      ...before,
      { role: 'user', content: 'actually switch to the database migration instead' },
      { role: 'toolResult', content: 'output about migrations now' },
    ];
    await fire(after);
    d.resolve([mem(1, 'Stale deployment fact')]);
    await flush();
    const out = await fire(after);
    const injected = textOf(out[out.length - 1] as Msg);

    expect(injected).toContain('Migration fact');
    expect(injected).not.toContain('Stale deployment fact');
    expect(seen[1]).toContain('database migration');
  });

  it('does not re-issue the query it already searched once the slot frees up', async () => {
    let calls = 0;
    const { fire } = harness({ retrieve: async () => { calls += 1; return [mem(1, 'A fact')]; } });
    const base: Msg[] = [{ role: 'user', content: 'go' }, { role: 'toolResult', content: 'output about the deployment pipeline' }];

    await fire(base);
    await fire(base);
    // The work has not moved since the pass that searched, so freeing the slot must not mean
    // searching the identical query again — lastQuery is set when the search is ISSUED.
    await fire(base);
    expect(calls).toBe(1);
  });

  it('resolves promptly on a hanging retrieval instead of holding the turn', async () => {
    // Nothing awaits the retrieval, so even one that takes 20s must not delay the hook at all.
    const { fire } = harness({
      retrieve: () => new Promise((resolve) => { setTimeout(() => resolve([mem(1, 'Too late')]), 20_000); }),
    });
    const base: Msg[] = [{ role: 'user', content: 'go' }, { role: 'toolResult', content: 'plenty of tool output here' }];

    const started = Date.now();
    const out = await fire(base);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(out).toEqual(base);
  }, 15_000);
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

describe('compaction', () => {
  it('re-surfaces a memory after compaction instead of suppressing it forever', async () => {
    // Compaction replaces the history with a summary, so the block this turn injected is GONE from the
    // transcript the model now sees. If the already-injected ids carried across, the memory would be
    // suppressed as a duplicate of something that no longer exists — permanently invisible for the rest
    // of the session. A falling user count is the signal, which is why only a rising one counts as
    // steering. Claude Code reaches the same conclusion: "compact naturally resets both — old
    // attachments are gone from the compacted transcript, so re-surfacing is valid again."
    // The same memory id both times, but the body changes. That is what makes the assertion sharp:
    // if the injected ids carried across the compaction, id 1 is treated as already-seen and the block
    // the model gets is the STALE pre-compaction copy. Comparing bodies is the only way to tell a
    // genuine re-injection from a re-emitted old block, since both leave one block at the end.
    let calls = 0;
    const h = harness({
      retrieve: async () => {
        calls += 1;
        return [mem(1, calls === 1 ? 'Deploy: release.sh, first copy' : 'Deploy: release.sh, refreshed copy')];
      },
    });

    const working: Msg[] = [
      { role: 'user', content: 'fix the deploy' },
      { role: 'assistant', content: 'inspecting the release path in detail' },
      { role: 'toolResult', content: 'bash: ./release.sh --dry-run exited 2' },
      { role: 'assistant', content: 'checking the packaging step next' },
      { role: 'toolResult', content: 'bash: npm pack produced no tarball' },
    ];
    await h.fire(working);
    const before = await h.fire(working);
    expect(calls).toBe(1);
    expect(String(before[before.length - 1]?.content)).toContain('first copy');

    // Post-compaction: a single summary user message replaces the history. Note the user count is
    // UNCHANGED at 1 — only the shrinking length reveals what happened, which is exactly the case a
    // user-message counter alone would miss.
    const summary: Msg[] = [
      { role: 'user', content: 'Summary of the conversation so far: working on the deploy path' },
      { role: 'assistant', content: 'continuing with the release path investigation now' },
      { role: 'toolResult', content: 'bash: ./release.sh --dry-run exited 2 again' },
    ];
    await h.fire(summary);
    expect(calls).toBe(2);
    const after = await h.fire(summary);

    expect(String(after[after.length - 1]?.content)).toContain('refreshed copy');
    expect(String(after[after.length - 1]?.content)).not.toContain('first copy');
  });

  it('treats a compaction that arrives together with steering as a compaction', async () => {
    // A real sequence: the turn compacts, and the user's next instruction lands on top of the summary.
    // The history is now SHORTER than before while the user count has GONE UP, so both signals fire at
    // once. Compaction has to win: steering deliberately carries the injected blocks over, and carrying
    // them across a compaction is precisely what pins a stale block to a transcript that dropped it.
    let calls = 0;
    const h = harness({
      retrieve: async () => {
        calls += 1;
        return [mem(1, calls === 1 ? 'Deploy: release.sh, first copy' : 'Deploy: release.sh, refreshed copy')];
      },
    });

    const working: Msg[] = [
      { role: 'user', content: 'fix the deploy' },
      { role: 'assistant', content: 'inspecting the release path in detail' },
      { role: 'toolResult', content: 'bash: ./release.sh --dry-run exited 2' },
      { role: 'assistant', content: 'checking the packaging step next' },
      { role: 'toolResult', content: 'bash: npm pack produced no tarball' },
    ];
    await h.fire(working);
    await h.fire(working);
    expect(calls).toBe(1);

    const summary: Msg[] = [
      { role: 'user', content: 'Summary of the conversation so far: working on the deploy path' },
      { role: 'user', content: 'actually check the tarball name too' },
      { role: 'toolResult', content: 'bash: ./release.sh --dry-run exited 2 again' },
    ];
    await h.fire(summary);
    expect(calls).toBe(2);
    const after = await h.fire(summary);

    expect(String(after[after.length - 1]?.content)).toContain('refreshed copy');
    expect(String(after[after.length - 1]?.content)).not.toContain('first copy');
  });
});
