import { describe, it, expect } from 'vitest';
import { addTrailingCacheBreakpoint } from '../../../src/brain/session/cacheBreakpoints.js';

const EPHEMERAL = { type: 'ephemeral', ttl: '1h' };

/** A payload shaped the way pi-ai builds one: the marker on the last block of the last user message. */
function payload(messages: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    system: [{ type: 'text', text: 'system' }],
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    messages,
    ...extra,
  };
}

const marked = (text: string): Record<string, unknown> => ({ type: 'text', text, cache_control: EPHEMERAL });
const plain = (text: string): Record<string, unknown> => ({ type: 'text', text });
const userMessage = (...content: unknown[]): Record<string, unknown> => ({ role: 'user', content });
const assistantMessage = (text: string): Record<string, unknown> => ({ role: 'assistant', content: [plain(text)] });

/** Every marker in the payload, in order, so a test can assert WHERE they landed rather than how many. */
function markerPositions(value: unknown): string[] {
  const out: string[] = [];
  const messages = (value as { messages?: unknown[] }).messages ?? [];
  messages.forEach((message, index) => {
    const content = (message as { content?: unknown[] }).content ?? [];
    content.forEach((block) => {
      if ((block as { cache_control?: unknown }).cache_control !== undefined) out.push(`${index}`);
    });
  });
  return out;
}

describe('addTrailingCacheBreakpoint', () => {
  // The whole point: pi-ai's single marker MOVES to the new tail every step, so after a wide fan-out the
  // lookback from it cannot reach what the previous request cached. Pinning the message that carried the
  // marker last time is what makes the next request a hit instead of a search.
  it('marks the user message that carried the marker on the previous request', () => {
    const result = addTrailingCacheBreakpoint(payload([
      userMessage(plain('first ask')),
      assistantMessage('calling tools'),
      userMessage({ type: 'tool_result', content: 'a' }, marked('done')),
    ]));
    expect(markerPositions(result)).toEqual(['0', '2']);
  });

  // Reused verbatim rather than reconstructed: the value carries the TTL derived from PI_CACHE_RETENTION,
  // and a literal written here would silently disagree with the rest of the payload the day that changes.
  it('reuses the exact marker value pi-ai used', () => {
    const result = addTrailingCacheBreakpoint(payload([
      userMessage(plain('first ask')),
      assistantMessage('work'),
      userMessage(marked('second ask')),
    ]));
    const messages = (result as { messages: { content: { cache_control?: unknown }[] }[] }).messages;
    expect(messages[0]?.content[0]?.cache_control).toEqual(EPHEMERAL);
  });

  // Anthropic rejects a request carrying more than four breakpoints, so a payload already at the limit
  // must be left exactly as it is — an outage is a far worse outcome than a cache miss.
  it('adds nothing when the payload already holds four breakpoints', () => {
    const result = addTrailingCacheBreakpoint(payload(
      [userMessage(plain('first')), assistantMessage('x'), userMessage(marked('second'))],
      {
        system: [{ type: 'text', text: 'system', cache_control: EPHEMERAL }],
        tools: [
          { name: 'Read', input_schema: {}, cache_control: EPHEMERAL },
          { name: 'Write', input_schema: {}, cache_control: EPHEMERAL },
        ],
      },
    ));
    expect(markerPositions(result)).toEqual(['2']);
  });

  // No marker means pi-ai deliberately did not cache this request (caching off, or an unsupported model).
  // Adding one of our own would be inventing a policy it chose not to apply.
  it('adds nothing when pi-ai marked nothing', () => {
    const result = addTrailingCacheBreakpoint(payload([
      userMessage(plain('first')),
      assistantMessage('x'),
      userMessage(plain('second')),
    ]));
    expect(markerPositions(result)).toEqual([]);
  });

  // The first turn has no earlier user message to pin, and must not crash reaching for one.
  it('adds nothing when there is no earlier user message', () => {
    const result = addTrailingCacheBreakpoint(payload([userMessage(marked('only ask'))]));
    expect(markerPositions(result)).toEqual(['0']);
  });

  // A block type Anthropic does not accept a marker on would make the request invalid.
  it('refuses to mark a block type that cannot carry one', () => {
    const result = addTrailingCacheBreakpoint(payload([
      userMessage({ type: 'something_new', value: 1 }),
      assistantMessage('x'),
      userMessage(marked('second')),
    ]));
    expect(markerPositions(result)).toEqual(['2']);
  });

  it('survives a payload that is not shaped like one', () => {
    expect(() => addTrailingCacheBreakpoint(undefined)).not.toThrow();
    expect(() => addTrailingCacheBreakpoint({ messages: 'nope' })).not.toThrow();
    expect(() => addTrailingCacheBreakpoint({ messages: [] })).not.toThrow();
  });
});
