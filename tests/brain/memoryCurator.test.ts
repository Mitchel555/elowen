import { describe, it, expect, vi } from 'vitest';
import { MemoryCurator } from '../../src/brain/memoryCurator.js';
import type { MemoryStore } from '../../src/store/memoryStore.js';
import type { MemoryService } from '../../src/brain/memoryService.js';

/** The extraction prompt IS the curator's behavior — the cheap model does exactly what it says. These
 *  tests pin the instructions that were added deliberately (feedback capture, the hard exclusions), so
 *  a prompt refactor cannot silently drop them. */

interface SimilarHit { memory: { id: number; body: string } }

function harness(reply: string, similar: SimilarHit[] = []) {
  const store = {
    add: vi.fn(() => ({ id: 1 })),
    update: vi.fn(),
    softDelete: vi.fn(),
    merge: vi.fn(),
  };
  const service = {
    searchSemantic: vi.fn(async () => []),
    findSimilar: vi.fn(async () => similar),
  };
  const decide = vi.fn(async () => ({ text: reply }));
  const curator = new MemoryCurator({
    store: store as unknown as MemoryStore,
    service: service as unknown as MemoryService,
    inference: () => ({ model: 'test-model', decide }),
  });
  const lastPrompt = (): string => {
    const call = decide.mock.calls.at(-1) as unknown as [string] | undefined;
    return call?.[0] ?? '';
  };
  return { curator, store, decide, lastPrompt };
}

describe('memory curator extraction prompt', () => {
  it('asks for how-to-work feedback from corrections AND quiet confirmations', async () => {
    const h = harness('[]');
    await h.curator.run(1, 'no, not like that', 'understood');
    const prompt = h.lastPrompt();
    expect(prompt).toContain('BOTH corrections');
    expect(prompt).toContain('confirmations that a non-obvious approach worked');
    // The asymmetry is the point: confirmations are the half a naive extractor misses.
    expect(prompt).toContain('quieter than corrections and easy to miss');
  });

  it('requires the Why / How-to-apply structure for feedback memories', async () => {
    const h = harness('[]');
    await h.curator.run(1, 'stop doing that', 'ok');
    const prompt = h.lastPrompt();
    expect(prompt).toContain('Why: …');
    expect(prompt).toContain('How to apply: …');
    expect(prompt).toContain('judge an edge case instead of blindly following the rule');
  });

  it('keeps the exclusions in force even when the user asks to save, and bans judgemental memories', async () => {
    const h = harness('[]');
    await h.curator.run(1, 'save this: hi!', 'hello');
    const prompt = h.lastPrompt();
    expect(prompt).toContain('These exclusions apply even when the user explicitly asks you to save something.');
    expect(prompt).toContain('negative judgement of the user');
  });

  // The store filled up with self-descriptions of Elowen's own code and incident write-ups: 480 memories
  // written in 14 days against 690 the user deleted by hand. Anything readable from the repo is a
  // snapshot that rots, while an external system's behaviour genuinely cannot be looked up.
  it('excludes what the assistant could read from the repo, but keeps external systems', async () => {
    const h = harness('[]');
    await h.curator.run(1, 'the retry lives in src/queue.ts', 'noted');
    const prompt = h.lastPrompt();
    expect(prompt).toContain('ANYTHING THE ASSISTANT COULD LOOK UP INSTEAD');
    expect(prompt).toContain('commit hashes and who-changed-what');
    expect(prompt).toContain('a supplier API\'s behaviour cannot be read from the repo');
    expect(prompt).toContain('external systems the assistant CANNOT simply read');
  });

  it('asks for the RULE an incident left behind, not the story of the incident', async () => {
    const h = harness('[]');
    await h.curator.run(1, 'that cache bug cost a fortune', 'fixed it');
    const prompt = h.lastPrompt();
    expect(prompt).toContain('The story of a debugging session or an incident');
    expect(prompt).toContain('save that rule');
    expect(prompt).toContain('one sentence, not the narrative');
  });

  it('caps a memory body at one fact and states the budget for writing at all', async () => {
    const h = harness('[]');
    await h.curator.run(1, 'anything', 'anything');
    const prompt = h.lastPrompt();
    expect(prompt).toContain('ONE fact');
    expect(prompt).toContain('800 is the hard ceiling');
    expect(prompt).toContain('a future session would get the answer WRONG');
  });

  it('advertises feedback as a storable kind and stores a feedback op as one', async () => {
    const h = harness('[{"action":"add","body":"Rule. Why: reason. How to apply: always.","kind":"feedback","importance":4}]');
    await h.curator.run(1, 'no, do it the other way', 'understood');
    expect(h.lastPrompt()).toContain('"kind":"fact|preference|decision|feedback"');
    expect(h.store.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ kind: 'feedback' }),
      'agent',
      expect.any(String),
      'test-model',
    );
  });
});

describe('memory curator near-duplicate refresh', () => {
  const LONG = 'Supplier coraHB reports quantity on the way as a running total, not a delta; the field '
    + 'resets at month end and the API returns the pre-reset value for up to an hour afterwards, so an '
    + 'order placed in that window double-counts unless the timestamp is checked against the reset hour.';

  it('refreshes a matched memory when the replacement carries comparable content', async () => {
    const replacement = LONG.replace('up to an hour', 'up to two hours');
    const h = harness(`[{"action":"add","body":${JSON.stringify(replacement)},"kind":"fact","importance":4}]`,
      [{ memory: { id: 42, body: LONG } }]);
    await h.curator.run(1, 'coraHB reset window is two hours', 'noted');
    expect(h.store.update).toHaveBeenCalledWith(1, 42, expect.objectContaining({ body: replacement }),
      'agent', expect.any(String), 'test-model');
    expect(h.store.add).not.toHaveBeenCalled();
  });

  // Lowering the near-duplicate threshold to a value that actually fires makes this branch reachable for
  // the first time. A short new fact matching a long existing one must not silently delete the long one.
  it('adds a separate memory instead of overwriting a much richer one', async () => {
    const h = harness('[{"action":"add","body":"coraHB resets the counter monthly.","kind":"fact","importance":3}]',
      [{ memory: { id: 42, body: LONG } }]);
    await h.curator.run(1, 'coraHB resets monthly', 'noted');
    expect(h.store.update).not.toHaveBeenCalled();
    expect(h.store.add).toHaveBeenCalledWith(1, expect.objectContaining({ body: 'coraHB resets the counter monthly.' }),
      'agent', expect.any(String), 'test-model');
  });

  it('applies at most two operations from one exchange', async () => {
    const op = (n: number) => `{"action":"add","body":"Fact number ${n} about the user.","kind":"fact","importance":3}`;
    const h = harness(`[${op(1)},${op(2)},${op(3)},${op(4)}]`);
    await h.curator.run(1, 'lots happened', 'indeed');
    expect(h.store.add).toHaveBeenCalledTimes(2);
  });
});
