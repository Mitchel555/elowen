import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** A SECOND, trailing prompt-cache breakpoint, so a wide fan-out cannot cost the whole conversation.
 *
 *  Anthropic resolves a cache hit by scanning back a limited window of content blocks from each
 *  breakpoint. pi-ai marks exactly one place in the conversation — the last block of the payload's last
 *  user message (`anthropic-messages.js:961-981`) — and that mark MOVES to a different message on every
 *  step of a tool loop, because each step appends a new one.
 *
 *  One round of a wide fan-out adds far more blocks than that window: 18 parallel tool calls come back as
 *  one assistant message plus a single user message carrying 18 `tool_result` blocks. The lookback from
 *  the newly placed mark then never reaches the segment the PREVIOUS request cached, the read falls back
 *  to the system and tools breakpoints, and the entire history is written into the cache again.
 *
 *  Measured on this instance before this existed: reads collapsing from 347k tokens to exactly the
 *  system+tools size, repeatedly, always in turns that had just fanned out — with the conversation itself
 *  provably unmodified.
 *
 *  Leaving a breakpoint on the message that carried the mark LAST time turns that search into an exact
 *  hit, whatever happened in between. Anthropic permits four breakpoints and pi-ai uses three (system,
 *  tools, last user), so this takes the one that is free — and never more, which is what `BREAKPOINT_MAX`
 *  enforces: a fifth would make the API reject the request outright. */

const BREAKPOINT_MAX = 4;

type Block = Record<string, unknown>;

/** Only these block types may carry a marker — mirroring the type test pi-ai itself applies before
 *  marking, so this can never produce a payload shape the provider would refuse. */
const MARKABLE = new Set(['text', 'image', 'tool_result']);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function blocksOf(message: unknown): Block[] | undefined {
  const content = record(message)?.content;
  if (!Array.isArray(content)) return undefined;
  const blocks = content.filter((block): block is Block => record(block) !== undefined);
  return blocks.length === content.length ? blocks : undefined;
}

/** Count every marker already in the payload — system, tools and messages alike. The budget is per
 *  REQUEST, so counting only the messages would let the total pass four whenever the system or tool
 *  markers are present, which is always. */
function countBreakpoints(payload: Record<string, unknown>): number {
  let total = 0;
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    const object = record(value);
    if (!object) return;
    if (object.cache_control !== undefined) total += 1;
    for (const item of Object.values(object)) walk(item);
  };
  walk(payload.system);
  walk(payload.tools);
  walk(payload.messages);
  return total;
}

/** The value pi-ai just used, reused verbatim rather than reconstructed: it encodes the TTL derived from
 *  `PI_CACHE_RETENTION`, and a literal written here would silently disagree with the rest of the payload
 *  the first time that setting changed. Absent marker means pi-ai did not cache this request at all — in
 *  which case adding one of our own would be inventing a policy it deliberately did not apply. */
function existingMarker(messages: readonly unknown[]): { value: unknown; messageIndex: number } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const blocks = blocksOf(messages[index]);
    if (!blocks) continue;
    for (let block = blocks.length - 1; block >= 0; block -= 1) {
      const value = blocks[block]?.cache_control;
      if (value !== undefined) return { value, messageIndex: index };
    }
  }
  return undefined;
}

/** The user message before the marked one — where the mark sat on the previous request, since every step
 *  of a tool loop appends exactly one. */
function previousUserIndex(messages: readonly unknown[], before: number): number {
  for (let index = before - 1; index >= 0; index -= 1) {
    if (record(messages[index])?.role === 'user') return index;
  }
  return -1;
}

/** Exported for tests: the whole decision, as a pure function of the payload. Returns the payload it wants
 *  sent — the same object, mutated in place, or unchanged when there is nothing safe to do. */
export function addTrailingCacheBreakpoint(payload: unknown): unknown {
  const object = record(payload);
  if (!object) return payload;
  const messages = Array.isArray(object.messages) ? object.messages : undefined;
  if (!messages || messages.length === 0) return payload;
  const marker = existingMarker(messages);
  if (!marker) return payload;
  if (countBreakpoints(object) >= BREAKPOINT_MAX) return payload;
  const target = previousUserIndex(messages, marker.messageIndex);
  if (target < 0) return payload;
  const blocks = blocksOf(messages[target]);
  const last = blocks?.[blocks.length - 1];
  if (!last || typeof last.type !== 'string' || !MARKABLE.has(last.type)) return payload;
  // Already marked: this request's trailing breakpoint and pi-ai's own have converged on one message,
  // which happens when a turn sends two requests without appending a user message between them.
  if (last.cache_control !== undefined) return payload;
  last.cache_control = marker.value;
  return payload;
}

export function installCacheBreakpoints(pi: ExtensionAPI): void {
  pi.on('before_provider_request', (event) => addTrailingCacheBreakpoint(event.payload));
}
