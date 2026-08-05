/** Conversations whose attached image the PROVIDER refused to decode.
 *
 * Such an image is permanent poison. It lives in the live PI session's in-memory history and is
 * re-serialized into every subsequent provider request, so once one lands the conversation returns the
 * same 400 forever — every later turn fails, whatever the user types, and each failure still costs a
 * full request. The egress stripper in historyImageStripping.ts already knows how to collapse it, but it
 * may only rewrite history once the prompt cache is DEFINITELY cold (TTL + 1 min = 61 minutes on the
 * daemon's default `PI_CACHE_RETENTION=long`). A conversation in active use never reaches that gate, so
 * it never recovers on its own.
 *
 * Marking the conversation here opens that gate for it immediately: the next request strips the images
 * that have scrolled into history, so the turn after the failure goes through. It deliberately does NOT
 * strip the current turn's own images, so attaching a new, decodable image still works afterwards.
 *
 * The mark is intentionally sticky and needs no teardown: image bytes are never persisted (only the
 * `[📎 N× image]` marker text is), so a disposed-and-resumed conversation has no image blocks left for a
 * stale mark to act on. */
const rejected = new Set<string>();

/** The provider refused an image in this conversation — open the egress strip gate for it. */
export function markImagesRejected(sessionId: string): void {
  rejected.add(sessionId);
}

/** Whether this conversation is carrying an image the provider has already refused. */
export function imagesRejected(sessionId: string): boolean {
  return rejected.has(sessionId);
}

/** Test seam: forget every mark. */
export function resetImageRejections(): void {
  rejected.clear();
}
