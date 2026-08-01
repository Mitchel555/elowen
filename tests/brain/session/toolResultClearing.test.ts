import { afterEach, describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLEAR_MIN_BYTES,
  SPILL_MAX_RESULT_BYTES,
  SPILL_PREVIEW_CHARS,
  applyToolResultClearing,
  cacheColdAtTurnStart,
  cacheTtlMs,
  clearedToolResultPlaceholder,
  clearingCutIndex,
  idleThresholdMs,
  installToolResultClearing,
  selectClearableToolResults,
  selectOversizedToolResults,
  setSpillMaxResultBytes,
  toolResultSpillPath,
} from '../../../src/brain/session/toolResultClearing.js';
import { toolResultSpillDir } from '../../../src/shared/paths.js';
import { openDb } from '../../../src/store/db.js';
import { BrainStore } from '../../../src/store/brainStore.js';
import type { PiAgentMessage } from '../../../src/brain/session/historyImageStripping.js';

let dirs: string[] = [];
afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

const T0 = 1_000_000;
const IDLE = 60_000;

const user = (text: string, timestamp: number): PiAgentMessage =>
  ({ role: 'user', content: [{ type: 'text', text }], timestamp });

const assistant = (text: string, timestamp: number): PiAgentMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  api: 'anthropic-messages', provider: 'anthropic', model: 'test-model',
  usage: {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop', timestamp,
});

const toolResult = (toolCallId: string, text: string, timestamp: number): PiAgentMessage => ({
  role: 'toolResult', toolCallId, toolName: 'Bash',
  content: [{ type: 'text', text }], isError: false, timestamp,
});

const big = 'x'.repeat(CLEAR_MIN_BYTES + 100);
const small = 'y'.repeat(100);
/** Over the size trigger by one byte — every character is 1 byte, so length is the byte count. */
const oversized = `HEAD-${'z'.repeat(SPILL_MAX_RESULT_BYTES - 3)}-TAIL`;

interface Harness {
  session: { agent: { transformContext?: (m: PiAgentMessage[], s?: AbortSignal) => Promise<PiAgentMessage[]> } };
  transform: (m: PiAgentMessage[]) => Promise<PiAgentMessage[]>;
  writes: Map<string, string>;
}

function harness(options: {
  idleMs?: number;
  writeSpill?: (p: string, t: string) => Promise<void>;
  readSpill?: (p: string) => Promise<string | null>;
} = {}): Harness {
  const writes = new Map<string, string>();
  const session: Harness['session'] = { agent: {} };
  installToolResultClearing(session, 'sess-1', {
    idleMs: options.idleMs ?? IDLE,
    spillDir: '/tmp/spill/sess-1',
    writeSpill: options.writeSpill ?? (async (p, t) => { writes.set(p, t); }),
    readSpill: options.readSpill ?? (async () => null),
  });
  return { session, writes, transform: (m) => session.agent.transformContext!(m) };
}

describe('selectClearableToolResults / clearingCutIndex', () => {
  it('keeps the current and previous user turns, selects only large older results with an id', () => {
    const messages: PiAgentMessage[] = [
      user('one', T0),
      toolResult('old-big', big, T0 + 1),
      toolResult('old-small', small, T0 + 2),
      { role: 'toolResult', toolCallId: '', toolName: 'Bash', content: [{ type: 'text', text: big }], isError: false, timestamp: T0 + 3 } as PiAgentMessage,
      assistant('done', T0 + 4),
      user('two', T0 + 5),
      toolResult('prev-turn-big', big, T0 + 6),
      assistant('done', T0 + 7),
      user('three', T0 + 8),
      toolResult('current-big', big, T0 + 9),
    ];
    const cut = clearingCutIndex(messages);
    expect(messages[cut]).toBe(messages[5]); // the 'two' user message starts the previous turn
    const selected = selectClearableToolResults(messages, new Set());
    expect(selected.map((s) => s.toolCallId)).toEqual(['old-big']);
    expect(selected[0]?.bytes).toBe(big.length);
  });

  it('selects nothing when the conversation has fewer than two user messages', () => {
    const messages: PiAgentMessage[] = [user('one', T0), toolResult('big-1', big, T0 + 1)];
    expect(clearingCutIndex(messages)).toBe(-1);
    expect(selectClearableToolResults(messages, new Set())).toEqual([]);
  });

  it('skips already-latched ids', () => {
    const messages: PiAgentMessage[] = [
      user('one', T0), toolResult('old-big', big, T0 + 1), user('two', T0 + 2), user('three', T0 + 3),
    ];
    expect(selectClearableToolResults(messages, new Set(['old-big']))).toEqual([]);
  });
});

describe('selectOversizedToolResults', () => {
  it('selects only current-run results above the size trigger, with an id and not already latched', () => {
    const messages: PiAgentMessage[] = [
      user('one', T0),
      toolResult('older-oversized', oversized, T0 + 1), // already sent to the provider — time gate's job
      user('two', T0 + 2),
      toolResult('fresh-big-but-under', big, T0 + 3),
      toolResult('fresh-oversized', oversized, T0 + 4),
      { role: 'toolResult', toolCallId: '', toolName: 'Bash', content: [{ type: 'text', text: oversized }], isError: false, timestamp: T0 + 5 } as PiAgentMessage,
    ];
    const selected = selectOversizedToolResults(messages, new Set());
    expect(selected.map((s) => s.toolCallId)).toEqual(['fresh-oversized']);
    expect(selected[0]?.bytes).toBe(oversized.length);
    expect(selectOversizedToolResults(messages, new Set(['fresh-oversized']))).toEqual([]);
  });

  it('does not select a result exactly at the threshold', () => {
    const exact = 'z'.repeat(SPILL_MAX_RESULT_BYTES);
    const messages: PiAgentMessage[] = [user('one', T0), toolResult('exact', exact, T0 + 1)];
    expect(selectOversizedToolResults(messages, new Set())).toEqual([]);
  });

  it('applies the live resolver threshold, not just the default constant', () => {
    // Comfortably UNDER the default trigger — left in context while the default is in force.
    const under = 'z'.repeat(SPILL_MAX_RESULT_BYTES - 10_000);
    const messages: PiAgentMessage[] = [user('one', T0), toolResult('fresh', under, T0 + 1)];
    expect(selectOversizedToolResults(messages, new Set())).toEqual([]);
    // Lower the resolver below that size and the SAME result now spills. If the call site still read the
    // constant this assertion would fail — the resolver would be ignored and nothing selected.
    setSpillMaxResultBytes(() => under.length - 100);
    try {
      const selected = selectOversizedToolResults(messages, new Set());
      expect(selected.map((s) => s.toolCallId)).toEqual(['fresh']);
      expect(selected[0]?.bytes).toBe(under.length);
    } finally {
      setSpillMaxResultBytes(() => SPILL_MAX_RESULT_BYTES);
    }
  });
});

describe('cacheColdAtTurnStart', () => {
  it('is false while the conversation is active and true after an idle gap', () => {
    const active: PiAgentMessage[] = [user('one', T0), assistant('a', T0 + 1_000), user('two', T0 + 5_000)];
    expect(cacheColdAtTurnStart(active, IDLE, T0 + 5_000)).toBe(false);
    const idle: PiAgentMessage[] = [user('one', T0), assistant('a', T0 + 1_000), user('two', T0 + IDLE + 2_000)];
    expect(cacheColdAtTurnStart(idle, IDLE, T0 + IDLE + 2_000)).toBe(true);
  });

  it('is false for the very first user message (nothing to compare against)', () => {
    expect(cacheColdAtTurnStart([user('one', T0)], IDLE, T0)).toBe(false);
  });

  it('bounds a future-stamped prompt by now (clock skew can only close the gate, never open it)', () => {
    // The prompt claims a huge idle gap, but the clock says only 1s has passed — the gap is capped
    // by `now`, so the gate stays closed.
    const skewed: PiAgentMessage[] = [user('one', T0), assistant('a', T0 + 1_000), user('two', T0 + 10 * IDLE)];
    expect(cacheColdAtTurnStart(skewed, IDLE, T0 + 2_000)).toBe(false);
    // With an honest clock the same timestamps open the gate.
    expect(cacheColdAtTurnStart(skewed, IDLE, T0 + 10 * IDLE)).toBe(true);
  });
});

describe('applyToolResultClearing', () => {
  it('replaces content with the placeholder, never mutates input, is idempotent', () => {
    const messages: PiAgentMessage[] = [
      user('one', T0), toolResult('old-big', big, T0 + 1), user('two', T0 + 2), user('three', T0 + 3),
    ];
    const snapshot = structuredClone(messages);
    const placeholder = clearedToolResultPlaceholder(toolResultSpillPath('/tmp/spill/sess-1', 'old-big'), big.length);
    const once = applyToolResultClearing(messages, new Map([['old-big', { index: 1, placeholder }]]));
    expect(messages).toEqual(snapshot);
    expect(once[1]).toEqual({ ...messages[1], content: [{ type: 'text', text: placeholder }] });
    expect(once[0]).toBe(messages[0]);
    expect(applyToolResultClearing(once, new Map([['old-big', { index: 1, placeholder }]]))).toBe(once);
  });
});

describe('installToolResultClearing', () => {
  it('does nothing while the conversation stays active', async () => {
    const h = harness();
    const messages: PiAgentMessage[] = [
      user('one', T0), toolResult('old-big', big, T0 + 1_000),
      user('two', T0 + 2_000), toolResult('prev-big', big, T0 + 3_000),
      user('three', T0 + 4_000),
    ];
    const result = await h.transform(messages);
    expect(result).toEqual(messages);
    expect(h.writes.size).toBe(0);
  });

  it('clears large old results after an idle gap, spills full text first, keeps recent turns', async () => {
    const h = harness();
    const messages: PiAgentMessage[] = [
      user('one', T0), toolResult('old-big', big, T0 + 1_000), toolResult('old-small', small, T0 + 2_000),
      user('two', T0 + 3_000), toolResult('prev-big', big, T0 + 4_000),
      user('three', T0 + IDLE + 5_000),
    ];
    const result = await h.transform(messages);
    const path = toolResultSpillPath('/tmp/spill/sess-1', 'old-big');
    expect(h.writes.get(path)).toBe(big);
    expect(result[1]).toEqual({
      ...messages[1],
      content: [{ type: 'text', text: clearedToolResultPlaceholder(path, big.length) }],
    });
    // Small results and the two trailing turns are untouched.
    expect(result[2]).toBe(messages[2]);
    expect(result[4]).toBe(messages[4]);
  });

  it('latch keeps a cleared result cleared forever, with a byte-identical placeholder', async () => {
    const h = harness();
    const turn3: PiAgentMessage[] = [
      user('one', T0), toolResult('old-big', big, T0 + 1_000),
      user('two', T0 + 2_000),
      user('three', T0 + IDLE + 3_000),
    ];
    const clearedOnce = await h.transform(turn3);
    // The conversation continues actively (small gaps — gate closed): the placeholder must persist.
    const turn4: PiAgentMessage[] = [...turn3, assistant('ok', T0 + IDLE + 4_000), user('four', T0 + IDLE + 5_000)];
    const clearedTwice = await h.transform(turn4);
    expect(clearedTwice[1]).toEqual(clearedOnce[1]);
    const text1 = JSON.stringify(clearedOnce[1]);
    const text2 = JSON.stringify(clearedTwice[1]);
    expect(text2).toBe(text1);
  });

  it('prefix stability: a warm pass never rewrites anything, a cold pass only appends clearings', async () => {
    const h = harness();
    // Turns 1–3 active: outputs must be byte-identical to inputs every single pass.
    const turns: PiAgentMessage[][] = [
      [user('one', T0), toolResult('r1', big, T0 + 1_000)],
      [user('one', T0), toolResult('r1', big, T0 + 1_000), assistant('a1', T0 + 2_000), user('two', T0 + 3_000)],
      [user('one', T0), toolResult('r1', big, T0 + 1_000), assistant('a1', T0 + 2_000), user('two', T0 + 3_000), toolResult('r2', big, T0 + 4_000)],
    ];
    for (const turn of turns) {
      expect(JSON.stringify(await h.transform(turn))).toBe(JSON.stringify(turn));
    }
    // Idle gap, then turn 4: everything before the previous user turn is now cleared, but every pass
    // AFTER that must reproduce the cleared bytes exactly.
    const turn4: PiAgentMessage[] = [...turns[2], user('three', T0 + IDLE + 5_000)];
    const cleared4 = await h.transform(turn4);
    expect(JSON.stringify(cleared4[1])).toContain('Older tool result cleared');
    const turn5: PiAgentMessage[] = [...turn4, assistant('a3', T0 + IDLE + 6_000), user('four', T0 + IDLE + 7_000)];
    const cleared5 = await h.transform(turn5);
    // The shared prefix (turn4's whole array) is byte-identical between the two passes.
    expect(JSON.stringify(cleared5.slice(0, cleared4.length))).toBe(JSON.stringify(cleared4));
  });

  it('does not clear when the spill write fails, and retries only at the NEXT idle epoch', async () => {
    let calls = 0;
    const h = harness({
      writeSpill: async () => { calls += 1; throw Object.assign(new Error('readonly'), { code: 'EACCES' }); },
    });
    const turn3: PiAgentMessage[] = [
      user('one', T0), toolResult('old-big', big, T0 + 1_000),
      user('two', T0 + 2_000),
      user('three', T0 + IDLE + 3_000),
    ];
    const first = await h.transform(turn3);
    expect(JSON.stringify(first[1])).toContain('xxxx'); // still full content
    expect(calls).toBe(1);
    // The gate stays open for the whole turn, but a mid-turn retry would rewrite the prefix this
    // pass just paid to re-cache — so the failed id is skipped until the next gate OPENING.
    await h.transform(turn3);
    expect(calls).toBe(1);
    // The conversation continues actively (gate closes on a fresh user message) and then idles again
    // (gate re-opens): only NOW is the retry allowed.
    const turn4: PiAgentMessage[] = [...turn3, assistant('ok', T0 + IDLE + 4_000), user('four', T0 + IDLE + 5_000)];
    await h.transform(turn4);
    expect(calls).toBe(1);
    const turn5: PiAgentMessage[] = [
      ...turn4, assistant('ok2', T0 + IDLE + 6_000), user('five', T0 + 2 * IDLE + 7_000),
    ];
    await h.transform(turn5);
    expect(calls).toBe(2);
  });

  it('EEXIST latches only when the on-disk spill matches the output byte-for-byte', async () => {
    const matching = harness({
      writeSpill: async () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); },
      readSpill: async () => big, // a genuine pre-respawn spill of this very output
    });
    const messages: PiAgentMessage[] = [
      user('one', T0), toolResult('old-big', big, T0 + 1_000),
      user('two', T0 + 2_000),
      user('three', T0 + IDLE + 3_000),
    ];
    const result = await matching.transform(messages);
    expect(JSON.stringify(result[1])).toContain('Older tool result cleared');

    // A foreign file at the path (e.g. written by the session itself) must NOT be latched: the
    // placeholder would point at text that was never the tool's output.
    let calls = 0;
    const foreign = harness({
      writeSpill: async () => { calls += 1; throw Object.assign(new Error('exists'), { code: 'EEXIST' }); },
      readSpill: async () => 'something else entirely',
    });
    const kept = await foreign.transform(messages);
    expect(JSON.stringify(kept[1])).toContain('xxxx');
    await foreign.transform(messages); // same epoch — no retry spin
    expect(calls).toBe(1);
    // `wx` can never overwrite the foreign file, so retrying is pointless even at the NEXT epoch:
    // the id is skipped permanently (one warn at detection, no log spam every idle).
    const turn4: PiAgentMessage[] = [...messages, assistant('ok', T0 + IDLE + 4_000), user('four', T0 + IDLE + 5_000)];
    await foreign.transform(turn4); // gate closes
    const turn5: PiAgentMessage[] = [...turn4, assistant('ok2', T0 + IDLE + 6_000), user('five', T0 + 2 * IDLE + 7_000)];
    const reopened = await foreign.transform(turn5); // gate re-opens
    expect(calls).toBe(1);
    expect(JSON.stringify(reopened[1])).toContain('xxxx'); // still full content, still not cleared
  });

  it('a throwing readSpill is treated as a mismatch (mismatch handling must never take the turn down)', async () => {
    const h = harness({
      writeSpill: async () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); },
      readSpill: async () => { throw new Error('disk on fire'); },
    });
    const messages: PiAgentMessage[] = [
      user('one', T0), toolResult('old-big', big, T0 + 1_000),
      user('two', T0 + 2_000),
      user('three', T0 + IDLE + 3_000),
    ];
    const result = await h.transform(messages);
    expect(JSON.stringify(result[1])).toContain('xxxx'); // full content kept, no rejection
  });

  it('clears nothing when the cut lands on the first message (exactly two user turns)', async () => {
    const h = harness();
    // Two user messages with the first at index 0 → cut = 0 → nothing is eligible, even when idle.
    const messages: PiAgentMessage[] = [
      user('one', T0), toolResult('old-big', big, T0 + 1_000),
      user('two', T0 + IDLE + 2_000),
    ];
    const result = await h.transform(messages);
    expect(result).toBe(messages);
    expect(h.writes.size).toBe(0);
  });

  it('replaces image blocks too (image stripping already turned history images into text upstream)', async () => {
    const h = harness();
    const withImage: PiAgentMessage = {
      role: 'toolResult', toolCallId: 'old-img', toolName: 'Read', isError: false, timestamp: T0 + 1_000,
      content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'text', text: big }],
    };
    const messages: PiAgentMessage[] = [
      user('one', T0), withImage,
      user('two', T0 + 2_000),
      user('three', T0 + IDLE + 3_000),
    ];
    const result = await h.transform(messages);
    const content = (result[1] as { content: { type: string; text?: string }[] }).content;
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toContain('Older tool result cleared');
    // The spill carries the text blocks; image bytes never hit the spill file (they were stripped
    // upstream in the real pipeline — the factory installs this hook after historyImageStripping).
    expect(h.writes.get(toolResultSpillPath('/tmp/spill/sess-1', 'old-img'))).toBe(big);
  });

  it('composes with a pre-existing transformContext and survives a missing agent seam', async () => {
    const calls: string[] = [];
    const session = {
      agent: {
        transformContext: async (m: PiAgentMessage[]): Promise<PiAgentMessage[]> => { calls.push('previous'); return m; },
      },
    };
    installToolResultClearing(session, 'sess-1', { idleMs: IDLE, writeSpill: async () => undefined });
    const messages: PiAgentMessage[] = [
      user('one', T0), toolResult('old-big', big, T0 + 1_000), user('two', T0 + 2_000), user('three', T0 + IDLE + 3_000),
    ];
    const result = await session.agent.transformContext!(messages);
    expect(calls).toEqual(['previous']);
    expect(JSON.stringify(result[1])).toContain('Older tool result cleared');
    expect(() => installToolResultClearing({}, 'sess-1')).not.toThrow();
  });

  it('leaves a fresh result under the size trigger completely alone', async () => {
    const h = harness();
    const underBy1 = 'z'.repeat(SPILL_MAX_RESULT_BYTES);
    const messages: PiAgentMessage[] = [
      user('one', T0), assistant('calling', T0 + 1_000),
      toolResult('fresh-big', big, T0 + 2_000), toolResult('fresh-at-limit', underBy1, T0 + 3_000),
    ];
    const result = await h.transform(messages);
    expect(result).toBe(messages);
    expect(h.writes.size).toBe(0);
  });

  it('spills an oversized fresh result on delivery, with a path and a bounded preview', async () => {
    const h = harness();
    const messages: PiAgentMessage[] = [
      user('one', T0), assistant('calling', T0 + 1_000), toolResult('fresh', oversized, T0 + 2_000),
    ];
    // No idle gap anywhere: the size trigger fires regardless of the cache gate.
    const result = await h.transform(messages);
    const path = toolResultSpillPath('/tmp/spill/sess-1', 'fresh');
    expect(h.writes.get(path)).toBe(oversized); // the FULL text reaches disk, tail included
    const text = (result[2] as { content: { type: string; text?: string }[] }).content[0]?.text ?? '';
    expect(text).toBe(clearedToolResultPlaceholder(path, oversized.length, oversized.slice(0, SPILL_PREVIEW_CHARS)));
    expect(text).toContain(path);
    expect(text).toContain('HEAD-zzz'); // the preview is really the head of the content
    expect(text).not.toContain('-TAIL'); // …and it is bounded: the end only exists on disk
    expect(text.length).toBeLessThan(SPILL_PREVIEW_CHARS + 500);
    expect(result[0]).toBe(messages[0]); // nothing else in the turn is touched
    expect(result[1]).toBe(messages[1]);
  });

  it('a size-spilled result stays spilled with byte-identical placeholder bytes', async () => {
    const h = harness();
    const turn1: PiAgentMessage[] = [
      user('one', T0), assistant('calling', T0 + 1_000), toolResult('fresh', oversized, T0 + 2_000),
    ];
    const first = await h.transform(turn1);
    const turn2: PiAgentMessage[] = [...turn1, assistant('done', T0 + 3_000), user('two', T0 + 4_000)];
    const second = await h.transform(turn2);
    expect(JSON.stringify(second.slice(0, first.length))).toBe(JSON.stringify(first));
    expect(h.writes.size).toBe(1); // latched: no second write, no second spill file
  });

  it('spills into the real per-session dir, and the existing session cleanup removes it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-size-spill-'));
    dirs.push(home);
    vi.stubEnv('HOME', home);
    try {
      // Real fs writer and real spill dir — no injection, so this exercises the path the daemon uses.
      const session: Harness['session'] = { agent: {} };
      installToolResultClearing(session, 'sess-fs', { idleMs: IDLE });
      const messages: PiAgentMessage[] = [user('one', T0), toolResult('fresh', oversized, T0 + 1_000)];
      const result = await session.agent.transformContext!(messages);
      const text = (result[1] as { content: { type: string; text?: string }[] }).content[0]?.text ?? '';
      const spilled = /Full output at: (\S+) — read it/.exec(text)?.[1];
      expect(spilled).toBe(join(toolResultSpillDir(process.env, 'sess-fs'), 'fresh.txt'));
      expect(readFileSync(spilled!, 'utf8')).toBe(oversized);

      // The spill lands inside the per-session directory the store already sweeps on delete.
      const store = new BrainStore(openDb(':memory:'));
      store.createSession({ id: 'sess-fs', userId: 7, model: 'm' });
      store.deleteSession('sess-fs');
      expect(existsSync(spilled!)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('toolResultSpillPath', () => {
  it('fs-encodes the toolCallId so a hostile id cannot escape the spill dir', () => {
    expect(toolResultSpillPath('/s', 'call-1')).toBe('/s/call-1.txt');
    expect(toolResultSpillPath('/s', 'a/b')).toBe('/s/a%2Fb.txt');
    expect(toolResultSpillPath('/s', '..')).toBe('/s/%...txt');
  });
});

describe('cacheTtlMs / idleThresholdMs', () => {
  it('resolves the TTL from the same env var pi-ai reads: 60 min long, 5 min short', () => {
    expect(cacheTtlMs({ PI_CACHE_RETENTION: 'long' } as NodeJS.ProcessEnv)).toBe(60 * 60_000);
    expect(cacheTtlMs({} as NodeJS.ProcessEnv)).toBe(5 * 60_000);
  });

  it('the gate rounds the TTL UP by a minute: 61 minutes for long retention, 6 otherwise', () => {
    expect(idleThresholdMs({ PI_CACHE_RETENTION: 'long' } as NodeJS.ProcessEnv)).toBe(61 * 60_000);
    expect(idleThresholdMs({} as NodeJS.ProcessEnv)).toBe(6 * 60_000);
  });
});
