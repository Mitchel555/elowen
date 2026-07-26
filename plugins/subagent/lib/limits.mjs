/** Bound on the context handed to a delegated child as ONE system-prompt chunk.
 *
 *  Well under the delegated-scope per-chunk bound (8k chars) so a shared-context chunk never overflows
 *  and rejects the whole delegation. Oversized context is clipped, never dropped.
 *
 *  It lives in its own module because both the delegate path and the workflow path must size against the
 *  SAME number: the workflow divides this budget between a node's dependencies, and when it sized itself
 *  independently the two disagreed by a factor of six — the workflow cut generous slices that the single
 *  clip here then threw away, so a wide fan-in silently lost every dependency but the first. */
export const MAX_CONTEXT_CHARS = 6_000;
