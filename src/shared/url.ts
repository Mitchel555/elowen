/** Base-URL primitives shared by every endpoint builder (embeddings, chat completions, app identity).
 *  Deliberately TWO primitives, not one combined "normalize" helper: the callers compose them
 *  differently. The openai-completions base must KEEP a trailing `/v1` (pi-ai appends
 *  `/chat/completions` to it), while the embeddings/chat URLs strip `/v1` before appending their own
 *  versioned path — a single normalize-with-flags function would only re-introduce the per-caller
 *  switch this module exists to avoid. */

/** Remove a single trailing slash so a suffix appends cleanly (`${base}/favicon.ico`). One slash only:
 *  `http://x//` keeps its inner slash, exactly like the `/\/$/` pattern it replaces. */
export function trimTrailingSlash(value: string): string {
  return value.replace(/\/$/, '');
}

/** Remove a trailing `/v1` API-version segment the operator may have included, so the caller's own
 *  versioned path is the only one on the URL. Case-sensitive — `/V1` is left alone. */
export function stripTrailingV1(value: string): string {
  return value.replace(/\/v1$/, '');
}
