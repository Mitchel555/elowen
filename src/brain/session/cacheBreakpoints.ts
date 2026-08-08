import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { hashCanonical } from './cacheWatch.js';

/** A SECOND, trailing prompt-cache breakpoint, so a wide fan-out cannot cost the whole conversation.
 *
 *  Anthropic's prefix checking tests at most 20 positions per breakpoint, counting the breakpoint itself
 *  as the first; when nothing matches it stops, or resumes from the next explicit breakpoint
 *  (docs.anthropic.com, "How automatic prefix checking works"). pi-ai marks exactly one place in the
 *  conversation — the last block of the payload's last user message (`anthropic-messages.js:961-981`) —
 *  and that mark MOVES every request. A step that appends more than 20 blocks (a wide fan-out's
 *  tool_results, a batch of queued steering messages) therefore pushes the previous request's write out
 *  of the new mark's window, the read falls back to the system and tools entries, and the entire history
 *  is written into the cache again. Measured here: reads collapsing from 347k tokens to exactly the
 *  system+tools size, 267k-token rewrites, in turns that had just fanned out.
 *
 *  The documented remedy is a second breakpoint at a position a prior request actually WROTE — the
 *  lookback finds prior writes, not stable content, so a guessed position is worthless. The only such
 *  position below the moving mark is wherever that mark sat on the PREVIOUS request of this session,
 *  which this extension remembers (index + content hash) and re-marks: an exact hit at the first
 *  position of that breakpoint's window, whatever the step appended in between. The first deployment of
 *  this idea guessed "the user message before the marked one" instead of remembering, which is only
 *  right when a step appends a single user message — steering mode "all" and background delegation
 *  deliveries routinely append several.
 *
 *  Anthropic allows four breakpoints per request and rejects a fifth outright. With an OAuth token
 *  pi-ai already spends all four (Claude Code identity block, system prompt, last tool, last user —
 *  `anthropic-messages.js:718-731,1012,969`), which made the first deployment a silent no-op in
 *  production. The identity-block entry is strictly redundant — it sits one tiny block after the
 *  all-tools entry — so this module keeps only the LAST marked system block and uses the freed slot.
 *  Markers are caching metadata outside the prefix hash (the docs' growing-conversation example depends
 *  on that: turn 2 hits an entry at a position its own payload no longer marks), so stripping one never
 *  invalidates entries earlier requests wrote. */

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

/** Keep only the LAST marked system block. An OAuth payload marks both the Claude Code identity block and
 *  the system prompt; together with the tools and last-user markers that exhausts the four-slot budget
 *  and starves the trailing breakpoint of the slot it needs. The dropped entry covered the same prefix as
 *  the all-tools entry plus one ~15-token block, and a system-prompt change still recovers the tools
 *  prefix through the lookback, two positions back. Run unconditionally so write positions stay identical
 *  from request to request instead of flickering with the marker count. */
function stripDuplicateSystemMarkers(payload: Record<string, unknown>): void {
  const system = Array.isArray(payload.system) ? payload.system : undefined;
  if (!system) return;
  const marked = system
    .map(record)
    .filter((block): block is Record<string, unknown> => block?.cache_control !== undefined);
  for (const block of marked.slice(0, -1)) delete block.cache_control;
}

/** Count every marker in the payload — system, tools and messages alike. The budget is per REQUEST, so
 *  counting only the messages would let the total pass four whenever the system or tool markers are
 *  present, which is always. */
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

/** The message pi-ai marked on THIS request, and the marker value it used. The value is reused verbatim
 *  rather than reconstructed: it encodes the TTL derived from `PI_CACHE_RETENTION`, and a literal written
 *  here would silently disagree with the rest of the payload the first time that setting changed. Absent
 *  marker means pi-ai did not cache this request at all — in which case adding one of our own would be
 *  inventing a policy it deliberately did not apply. */
function currentMarker(messages: readonly unknown[]): { value: unknown; messageIndex: number } | undefined {
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

/** Where the previous request's marked message sat, so the next request can pin the exact position its
 *  write landed on. Identified by canonical content, not index alone: live recall inserts messages
 *  mid-history and shifts everything after them. */
interface PreviousWrite { index: number; hash: string }

/** Find the remembered message in this payload. The remembered index is the append-only fast path; on a
 *  mismatch the scan walks forward toward the current mark, which is where an insertion pushes it. A
 *  message the cold-cache egress rewrote (image stripping, tool-result clearing) matches nothing — and
 *  should not, because its cache entry no longer matches either. A retry (nothing appended) and a
 *  compacted, shorter history leave the scan range empty, which is the correct answer for both. */
function locatePreviousWrite(messages: readonly unknown[], previous: PreviousWrite, before: number): number | undefined {
  const limit = Math.min(before, messages.length);
  for (let index = previous.index; index < limit; index += 1) {
    if (hashCanonical(messages[index]) === previous.hash) return index;
  }
  return undefined;
}

/** One per session — the memory of where the previous request's mark sat IS the mechanism, so a shared
 *  instance would cross-wire sessions. Returns the payload it wants sent: the same object, mutated in
 *  place, or unchanged when there is nothing safe to do. Exported for tests. */
export function createTrailingCacheBreakpoint(): (payload: unknown) => unknown {
  let previous: PreviousWrite | undefined;
  return (payload) => {
    const object = record(payload);
    if (!object) return payload;
    stripDuplicateSystemMarkers(object);
    const messages = Array.isArray(object.messages) ? object.messages : undefined;
    if (!messages || messages.length === 0) return payload;
    const marker = currentMarker(messages);
    if (!marker) {
      // A remembered position from before a no-cache request describes a write that may never have
      // happened; carrying it across the gap would pin a position nothing wrote.
      previous = undefined;
      return payload;
    }
    const remembered = previous;
    previous = { index: marker.messageIndex, hash: hashCanonical(messages[marker.messageIndex]) };
    if (!remembered) return payload;
    if (countBreakpoints(object) >= BREAKPOINT_MAX) return payload;
    const target = locatePreviousWrite(messages, remembered, marker.messageIndex);
    if (target === undefined) return payload;
    const blocks = blocksOf(messages[target]);
    const last = blocks?.[blocks.length - 1];
    if (!last || typeof last.type !== 'string' || !MARKABLE.has(last.type)) return payload;
    if (last.cache_control !== undefined) return payload;
    last.cache_control = marker.value;
    return payload;
  };
}

export function installCacheBreakpoints(pi: ExtensionAPI): void {
  const addTrailingBreakpoint = createTrailingCacheBreakpoint();
  pi.on('before_provider_request', (event) => addTrailingBreakpoint(event.payload));
}
