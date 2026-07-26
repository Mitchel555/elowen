import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { delegateContextChunks } = await import(resolve(repoRoot, 'plugins/subagent/index.mjs')) as {
  delegateContextChunks(raw: unknown, totalChars?: number): string[];
};
const limits = await import(resolve(repoRoot, 'plugins/subagent/lib/limits.mjs')) as {
  MAX_CONTEXT_CHUNK_CHARS: number;
  MAX_CONTEXT_CHUNKS: number;
  resolveContextTotalChars(raw: unknown): number;
};
// The bounds are only reachable through the clamp, so the tests read them the way production does.
const MAX_CONTEXT_TOTAL_CHARS = limits.resolveContextTotalChars(Number.MAX_SAFE_INTEGER);
const DEFAULT_CONTEXT_TOTAL_CHARS = limits.resolveContextTotalChars(undefined);

// The delegated-scope normalizer (src/brain/delegatedScope.ts) rejects the WHOLE scope — the delegation
// then fails closed — when a prompt chunk exceeds 8 000 chars, there are more than 16 of them, or they
// total over 32 000. These are the numbers the plugin's own ceilings must stay under.
const SCOPE_MAX_PROMPT_CHARS = 8_000;
const SCOPE_MAX_PROMPT_CHUNKS = 16;
const SCOPE_MAX_PROMPT_TOTAL_CHARS = 32_000;

describe('delegateContextChunks', () => {
  it('returns nothing for empty, whitespace, or non-string input', () => {
    expect(delegateContextChunks(undefined)).toEqual([]);
    expect(delegateContextChunks('')).toEqual([]);
    expect(delegateContextChunks('   \n  ')).toEqual([]);
    expect(delegateContextChunks(42)).toEqual([]);
    expect(delegateContextChunks(['', '  '])).toEqual([]);
  });

  it('wraps real context in a labelled, self-contained block', () => {
    const chunks = delegateContextChunks('The API base is /v2 and auth uses bearer tokens.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('Context shared by the delegating agent');
    expect(chunks[0]).toContain('The API base is /v2 and auth uses bearer tokens.');
  });

  it('clips oversized context to stay within the delegated-scope per-chunk bound', () => {
    const chunks = delegateContextChunks('x'.repeat(40_000));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.length).toBeLessThan(SCOPE_MAX_PROMPT_CHARS);
    expect(chunks[0]).toContain('[truncated]');
  });

  // The whole point of the change: the context used to travel as ONE string, so the 8 000-char per-chunk
  // bound applied to every dependency result joined together and ~87% of a five-way fan-in was thrown
  // away. Each part must get its own chunk, and only the first carries the header.
  it('gives every part its own chunk, with the header on the first one only', () => {
    const parts = ['briefing', 'result A', 'result B', 'result C'];
    const chunks = delegateContextChunks(parts);
    expect(chunks).toHaveLength(4);
    expect(chunks[0]).toContain('Context shared by the delegating agent');
    expect(chunks[0]).toContain('briefing');
    for (const chunk of chunks.slice(1)) expect(chunk).not.toContain('Context shared by the delegating agent');
    expect(chunks[1]).toBe('result A');
    expect(chunks[3]).toBe('result C');
  });

  // Five dependency results of 5 000 chars are 25 000 chars in total — impossible in one chunk, and today
  // they would arrive as ~1 000 chars each. As separate chunks they fit whole.
  it('delivers five sizeable parts in full when the budget allows', () => {
    const parts = ['a', 'b', 'c', 'd', 'e'].map((id) => `${id}:${id.repeat(4_998)}`);
    const chunks = delegateContextChunks(parts, MAX_CONTEXT_TOTAL_CHARS);
    expect(chunks).toHaveLength(5);
    for (const chunk of chunks) expect(chunk).not.toContain('[truncated]');
    for (const [i, part] of parts.entries()) expect(chunks[i]).toContain(part);
  });

  it('honours the operator-configured total budget', () => {
    const parts = ['a', 'b', 'c', 'd', 'e'].map((id) => `${id}:${id.repeat(4_998)}`);
    const tight = delegateContextChunks(parts, 6_000);
    const total = tight.reduce((n, chunk) => n + chunk.length, 0);
    expect(total).toBeLessThanOrEqual(6_500); // the budget plus the header/marker packaging
    // A tighter budget must not silently swallow parts: whatever survived is marked, whatever did not is counted.
    expect(tight.join('\n')).toContain('[truncated]');
  });

  // A malformed or absent operator value must not disable the bound — it falls back to the default.
  it('falls back to the default budget for a malformed operator value', () => {
    const parts = ['a', 'b', 'c', 'd', 'e'].map((id) => `${id}:${id.repeat(4_998)}`);
    const fallback = delegateContextChunks(parts, Number.NaN);
    const total = fallback.reduce((n, chunk) => n + chunk.length, 0);
    expect(total).toBeLessThanOrEqual(DEFAULT_CONTEXT_TOTAL_CHARS + 500);
  });

  // Fail-closed insurance: a scope over any of these bounds is rejected wholesale by the normalizer, so
  // the child would lose not just the overflow but the entire delegation.
  it('never breaches the delegated-scope bounds, whatever it is handed', () => {
    const parts = Array.from({ length: 40 }, (_, i) => `part-${i}:${'y'.repeat(9_000)}`);
    const chunks = delegateContextChunks(parts, 1_000_000);
    expect(chunks.length).toBeLessThanOrEqual(limits.MAX_CONTEXT_CHUNKS);
    expect(chunks.length).toBeLessThan(SCOPE_MAX_PROMPT_CHUNKS);
    for (const chunk of chunks) expect(chunk.length).toBeLessThan(SCOPE_MAX_PROMPT_CHARS);
    expect(chunks.reduce((n, chunk) => n + chunk.length, 0)).toBeLessThan(SCOPE_MAX_PROMPT_TOTAL_CHARS);
    // And it says so rather than letting parts vanish.
    expect(chunks.at(-1)).toMatch(/further context block/);
  });
});
