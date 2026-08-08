import { describe, it, expect } from 'vitest';
import { createTrailingCacheBreakpoint } from '../../../src/brain/session/cacheBreakpoints.js';

const EPHEMERAL = { type: 'ephemeral', ttl: '1h' };

/** A payload shaped the way pi-ai builds one for a non-OAuth token: one marked system block, the last
 *  tool marked, and the marker on the last block of the last user message — three of the four slots. */
function payload(messages: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    system: [{ type: 'text', text: 'system', cache_control: EPHEMERAL }],
    tools: [{ name: 'Read', input_schema: { type: 'object' }, cache_control: EPHEMERAL }],
    messages,
    ...extra,
  };
}

const marked = (text: string): Record<string, unknown> => ({ type: 'text', text, cache_control: EPHEMERAL });
const plain = (text: string): Record<string, unknown> => ({ type: 'text', text });
const userMessage = (...content: unknown[]): Record<string, unknown> => ({ role: 'user', content });
const assistantMessage = (text: string): Record<string, unknown> => ({ role: 'assistant', content: [plain(text)] });

type MarkedPayload = { system?: { cache_control?: unknown }[]; messages: { content: { cache_control?: unknown }[] }[] };

/** Every message-level marker in the payload, in order, so a test can assert WHERE they landed. */
function markerPositions(value: unknown): string[] {
  const out: string[] = [];
  ((value as MarkedPayload).messages ?? []).forEach((message, index) => {
    (message.content ?? []).forEach((block) => {
      if (block.cache_control !== undefined) out.push(`${index}`);
    });
  });
  return out;
}

describe('createTrailingCacheBreakpoint', () => {
  // The whole point: pi-ai's single marker MOVES to the new tail every request, and the previous
  // request's cache write happened exactly where it sat THEN. Re-marking that remembered position makes
  // the next lookup an exact hit, whatever the step appended in between.
  it('marks, on the next request, the message that carried the marker on the previous one', () => {
    const addTrailing = createTrailingCacheBreakpoint();
    addTrailing(payload([userMessage(marked('ask'))]));
    const result = addTrailing(payload([
      userMessage(plain('ask')),
      assistantMessage('calling tools'),
      userMessage({ type: 'tool_result', content: 'a' }, marked('done')),
    ]));
    expect(markerPositions(result)).toEqual(['0', '2']);
    // A single marked system block (non-OAuth) is not a duplicate and must survive untouched.
    expect((result as MarkedPayload).system?.[0]?.cache_control).toEqual(EPHEMERAL);
  });

  // The production incident: a step appended 13 messages (steering mode "all", background delegation
  // deliveries), so "the user message before the marked one" was a NEWLY APPENDED message no request had
  // ever written a cache entry at. Only the remembered position is a real write.
  it('pins the remembered position, not a guess, when a step appended several user messages', () => {
    const addTrailing = createTrailingCacheBreakpoint();
    addTrailing(payload([
      userMessage(plain('ask')),
      assistantMessage('working'),
      userMessage(marked('turn tail')),
    ]));
    const result = addTrailing(payload([
      userMessage(plain('ask')),
      assistantMessage('working'),
      userMessage(plain('turn tail')),
      assistantMessage('fanned out'),
      userMessage(plain('delegation result')), // where "previous user message" would wrongly land
      assistantMessage('kept going'),
      userMessage(marked('newest')),
    ]));
    expect(markerPositions(result)).toEqual(['2', '6']);
  });

  // With an OAuth token pi-ai marks BOTH system blocks (Claude Code identity + system prompt), which
  // together with the tools and last-user markers exhausts all four slots — the configuration this
  // module runs under in production, where the four-slot guard made the first version a silent no-op.
  // The identity entry duplicates the all-tools entry one tiny block later, so it is the one to free.
  it('frees the slot an OAuth payload wastes on the duplicate system marker', () => {
    const oauthSystem = (): Record<string, unknown>[] => [
      { type: 'text', text: 'You are Claude Code', cache_control: EPHEMERAL },
      { type: 'text', text: 'the real system prompt', cache_control: EPHEMERAL },
    ];
    const addTrailing = createTrailingCacheBreakpoint();
    const first = addTrailing(payload([userMessage(marked('ask'))], { system: oauthSystem() }));
    // Deduplicated from the very first request, so cache write positions never flicker.
    expect((first as MarkedPayload).system?.[0]?.cache_control).toBeUndefined();
    expect((first as MarkedPayload).system?.[1]?.cache_control).toEqual(EPHEMERAL);
    const result = addTrailing(payload([
      userMessage(plain('ask')),
      assistantMessage('working'),
      userMessage(marked('next')),
    ], { system: oauthSystem() }));
    expect((result as MarkedPayload).system?.[0]?.cache_control).toBeUndefined();
    expect((result as MarkedPayload).system?.[1]?.cache_control).toEqual(EPHEMERAL);
    // The freed slot is spent on the trailing breakpoint.
    expect(markerPositions(result)).toEqual(['0', '2']);
  });

  // Anthropic rejects a request carrying more than four breakpoints, so a payload already at the limit
  // with nothing to strip must be left exactly as it is — an outage is worse than a cache miss.
  it('never takes the payload past four breakpoints', () => {
    const twoMarkedTools = (): Record<string, unknown>[] => [
      { name: 'Read', input_schema: {}, cache_control: EPHEMERAL },
      { name: 'Write', input_schema: {}, cache_control: EPHEMERAL },
    ];
    const addTrailing = createTrailingCacheBreakpoint();
    addTrailing(payload([userMessage(marked('ask'))], { tools: twoMarkedTools() }));
    const result = addTrailing(payload([
      userMessage(plain('ask')),
      assistantMessage('working'),
      userMessage(marked('next')),
    ], { tools: twoMarkedTools() }));
    expect(markerPositions(result)).toEqual(['2']);
  });

  // Reused verbatim from THIS request rather than remembered or reconstructed: the value encodes the TTL
  // derived from PI_CACHE_RETENTION, and a stale or literal value would silently disagree with the rest
  // of the payload the first time that setting changed.
  it('reuses the exact marker value pi-ai used on this request', () => {
    const FIVE_MINUTE = { type: 'ephemeral' };
    const addTrailing = createTrailingCacheBreakpoint();
    addTrailing(payload([userMessage(marked('ask'))]));
    const result = addTrailing(payload([
      userMessage(plain('ask')),
      assistantMessage('working'),
      userMessage({ type: 'text', text: 'next', cache_control: FIVE_MINUTE }),
    ]));
    expect((result as MarkedPayload).messages[0]?.content[0]?.cache_control).toEqual(FIVE_MINUTE);
  });

  // No marker means pi-ai deliberately did not cache this request. Adding one of our own would be
  // inventing a policy it chose not to apply — and a position remembered from before the gap describes a
  // write that may never have happened, so it must be forgotten, not carried across.
  it('adds nothing across an uncached request, and forgets what it knew before it', () => {
    const bare = { system: [{ type: 'text', text: 'system' }], tools: [{ name: 'Read', input_schema: {} }] };
    const addTrailing = createTrailingCacheBreakpoint();
    addTrailing(payload([userMessage(marked('ask'))]));
    const gap = addTrailing(payload([
      userMessage(plain('ask')),
      assistantMessage('working'),
      userMessage(plain('next')),
    ], bare));
    expect(markerPositions(gap)).toEqual([]);
    const after = addTrailing(payload([
      userMessage(plain('ask')),
      assistantMessage('working'),
      userMessage(plain('next')),
      assistantMessage('more'),
      userMessage(marked('newest')),
    ]));
    expect(markerPositions(after)).toEqual(['4']);
  });

  // Live recall inserts messages mid-history, shifting everything behind them — the remembered INDEX goes
  // stale but the message itself is still in the payload, one position later, and still worth pinning.
  it('finds the remembered message by content after a mid-history insertion shifted it', () => {
    const addTrailing = createTrailingCacheBreakpoint();
    addTrailing(payload([
      userMessage(plain('ask')),
      assistantMessage('working'),
      userMessage(marked('turn tail')),
    ]));
    const result = addTrailing(payload([
      userMessage(plain('ask')),
      userMessage(plain('recalled memory')), // inserted
      assistantMessage('working'),
      userMessage(plain('turn tail')), // shifted from 2 to 3
      assistantMessage('more'),
      userMessage(marked('newest')),
    ]));
    expect(markerPositions(result)).toEqual(['3', '5']);
  });

  // After a compaction the remembered message is simply gone; marking any other position would pin a
  // spot no request ever wrote a cache entry at.
  it('adds nothing when the remembered message no longer exists', () => {
    const addTrailing = createTrailingCacheBreakpoint();
    addTrailing(payload([userMessage(marked('original opening'))]));
    const result = addTrailing(payload([
      userMessage(plain('compaction summary')),
      assistantMessage('working'),
      userMessage(marked('fresh')),
    ]));
    expect(markerPositions(result)).toEqual(['2']);
  });

  // A marker on a block type Anthropic does not accept one on would make the whole request invalid.
  it('refuses to mark a block type that cannot carry a marker', () => {
    const oddTail = { type: 'something_new', value: 1 };
    const addTrailing = createTrailingCacheBreakpoint();
    addTrailing(payload([userMessage(marked('ask'), { ...oddTail })]));
    const result = addTrailing(payload([
      userMessage(plain('ask'), { ...oddTail }),
      assistantMessage('working'),
      userMessage(marked('next')),
    ]));
    expect(markerPositions(result)).toEqual(['2']);
  });

  // A target that already carries a marker is someone else's decision (a doubled handler, a future
  // pi-ai change); overwriting it could silently swap its TTL.
  it('leaves a target that already carries a marker untouched', () => {
    const STALE = { type: 'ephemeral' };
    // Unmarked tools keep the payload below the four-marker budget, so this test exercises the
    // overwrite refusal itself rather than hiding behind the budget guard.
    const bareTools = { tools: [{ name: 'Read', input_schema: {} }] };
    const addTrailing = createTrailingCacheBreakpoint();
    addTrailing(payload([userMessage(marked('ask'))], bareTools));
    const result = addTrailing(payload([
      userMessage({ type: 'text', text: 'ask', cache_control: STALE }),
      assistantMessage('working'),
      userMessage(marked('next')),
    ], bareTools));
    expect((result as MarkedPayload).messages[0]?.content[0]?.cache_control).toEqual(STALE);
  });

  it('survives a payload that is not shaped like one', () => {
    const addTrailing = createTrailingCacheBreakpoint();
    expect(() => addTrailing(undefined)).not.toThrow();
    expect(() => addTrailing({ messages: 'nope' })).not.toThrow();
    expect(() => addTrailing({ messages: [] })).not.toThrow();
  });
});
