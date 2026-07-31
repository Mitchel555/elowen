/** Bounds on the context handed to a delegated child as system-prompt chunks.
 *
 *  The context travels as a LIST of chunks (one per dependency result, plus the node briefing), so the
 *  per-chunk ceiling below applies to a single result rather than to all of them joined — which is what
 *  used to cost a wide fan-in most of its input.
 *
 *  It lives in its own module because both the delegate path and the workflow path must size against the
 *  SAME numbers: the workflow slices a node's dependency results, and when it sized itself independently
 *  the two disagreed by a factor of six — the workflow cut generous slices that the single clip then threw
 *  away, so a wide fan-in silently lost every dependency but the first.
 *
 *  Every ceiling here is a hard invariant against the delegated-scope normalizer (src/brain/
 *  delegatedScope.ts): a chunk over MAX_PROMPT_CHARS (8 000), more than MAX_PROMPT_CHUNKS (16) chunks or
 *  a total over MAX_PROMPT_TOTAL_CHARS (32 000) makes the whole scope invalid and the delegation fails
 *  closed. Staying under them is not a preference. */

/** One chunk, before the block header and the truncation marker are added — both fit in the gap to 8 000. */
export const MAX_CONTEXT_CHUNK_CHARS = 7_000;

/** The exact packaging delegateContextChunks applies: the label on the FIRST chunk, and the marker whose
 *  room is reserved on EVERY chunk. They live here because the workflow engine has to size its dependency
 *  blocks against the real thing — budgeting against a rounded guess of them is what let a wide fan-in
 *  overrun the total and lose whole dependency groups at the end of the list. */
export const CONTEXT_HEADER = 'Context shared by the delegating agent — background for your task, treat as given and do not re-derive it:';
export const TRUNCATION_MARKER = '\n[truncated]';
/** Chunks the context may occupy, leaving slots for the child's role prompt and channel fragment. */
export const MAX_CONTEXT_CHUNKS = 12;

/** Total context budget across all chunks. The operator tunes it in Settings → Elowen AI → Limits
 *  (`brain.limits.delegateContextChars`), where core clamps it to the same range; the ceiling here is the
 *  plugin's own guard for a host that wires nothing (unit tests, an older daemon), not a second policy.
 *  The maximum must track core's own ceiling (BRAIN_LIMIT_BOUNDS.delegateContextChars in
 *  src/store/configStore.ts) — a lower value here would silently undo an operator's setting, since this
 *  clamp runs last. Both are sized against MAX_PROMPT_TOTAL_CHARS in src/brain/delegatedScope.ts, which
 *  is shared with the child's role prompt.
 *
 *  Deliberately not exported: the bounds are reachable through resolveContextTotalChars(), so a caller
 *  cannot read one and apply it by hand without the clamp that gives it meaning. */
const DEFAULT_CONTEXT_TOTAL_CHARS = 20_000;
const MIN_CONTEXT_TOTAL_CHARS = 2_000;
const MAX_CONTEXT_TOTAL_CHARS = 80_000;

/** Clamp an operator-supplied total budget; anything missing or malformed falls back to the default. */
export function resolveContextTotalChars(raw) {
  return typeof raw === 'number' && Number.isFinite(raw)
    ? Math.min(MAX_CONTEXT_TOTAL_CHARS, Math.max(MIN_CONTEXT_TOTAL_CHARS, Math.round(raw)))
    : DEFAULT_CONTEXT_TOTAL_CHARS;
}
