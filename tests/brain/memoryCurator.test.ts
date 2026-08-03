import { describe, it, expect, vi } from 'vitest';
import { MemoryCurator } from '../../src/brain/memoryCurator.js';
import type { MemoryStore } from '../../src/store/memoryStore.js';
import type { MemoryService } from '../../src/brain/memoryService.js';

/** The extraction prompt IS the curator's behavior — the cheap model does exactly what it says. These
 *  tests pin the instructions that were added deliberately (feedback capture, the hard exclusions), so
 *  a prompt refactor cannot silently drop them. */

function harness(reply: string) {
  const store = {
    add: vi.fn(() => ({ id: 1 })),
    update: vi.fn(),
    softDelete: vi.fn(),
    merge: vi.fn(),
  };
  const service = {
    searchSemantic: vi.fn(async () => []),
    findSimilar: vi.fn(async () => []),
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
