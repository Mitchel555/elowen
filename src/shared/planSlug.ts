import { createHash } from 'node:crypto';

/** Word pools for a readable plan filename. Deliberately plain, concrete and neutral: the slug is a
 *  label on a document the user opens, so it has to be easy to say and easy to tell apart at a glance in
 *  a directory listing. 64 × 64 keeps the pools scannable while leaving the combination space wide. */
const ADJECTIVES = [
  'amber', 'ancient', 'autumn', 'bold', 'brave', 'brisk', 'calm', 'candid',
  'clear', 'clever', 'coastal', 'copper', 'crimson', 'curious', 'daring', 'dawn',
  'deep', 'distant', 'eager', 'early', 'eastern', 'even', 'fair', 'fleet',
  'fluent', 'forest', 'frank', 'gentle', 'gilded', 'golden', 'grand', 'green',
  'hidden', 'humble', 'idle', 'iron', 'ivory', 'jade', 'keen', 'lasting',
  'lively', 'lucid', 'lunar', 'mellow', 'mild', 'misty', 'noble', 'northern',
  'patient', 'placid', 'polar', 'prime', 'quiet', 'rapid', 'rustic', 'silent',
  'silver', 'solar', 'steady', 'stone', 'sunny', 'tidal', 'vivid', 'winter',
] as const;

const NOUNS = [
  'anchor', 'arbour', 'aspen', 'basin', 'beacon', 'birch', 'bridge', 'brook',
  'canyon', 'cedar', 'cider', 'cliff', 'comet', 'copse', 'cove', 'crest',
  'delta', 'dune', 'ember', 'estuary', 'falcon', 'fathom', 'fern', 'ford',
  'forge', 'garden', 'glade', 'gorge', 'granite', 'harbour', 'hazel', 'heron',
  'hollow', 'island', 'juniper', 'lantern', 'ledge', 'maple', 'meadow', 'mesa',
  'moor', 'orchard', 'otter', 'peak', 'pebble', 'pine', 'quarry', 'ridge',
  'river', 'sable', 'sandbar', 'shore', 'sparrow', 'spruce', 'summit', 'thicket',
  'tide', 'trail', 'valley', 'vault', 'willow', 'window', 'harbourage', 'yarrow',
] as const;

/** A stable, readable slug for a session's plan file — `brave-otter-3f9a`.
 *
 *  DERIVED from the session id rather than generated at random, which is where this deliberately parts
 *  company with Claude Code. There the slug is random, cached in memory, and recovered from the message
 *  log when the cache is cold — a dance that exists because that CLI has no durable store to put it in.
 *  Deriving it means every caller that needs the path (the write clamp, the ExitPlanMode tool, the
 *  post-compaction re-injection, the lifecycle sweeps) computes the SAME answer from the session id
 *  alone, with nothing to persist, nothing to resume and nothing to drift out of sync after a daemon
 *  restart. A regenerated slug anywhere would silently orphan the file; here there is no second copy to
 *  regenerate.
 *
 *  The hex tail is what keeps it honest: two sessions landing on the same word pair would otherwise share
 *  a plan. 64 × 64 words × 16 bits puts a collision far past the number of sessions any instance will
 *  hold, and a collision would merely mean a shared file, not an escape — the output is `[a-z0-9-]` by
 *  construction, so it can never become a path component that leaves the plans directory. */
export function planSlug(sessionId: string): string {
  const digest = createHash('sha256').update(sessionId).digest();
  const adjective = ADJECTIVES[digest[0]! % ADJECTIVES.length]!;
  const noun = NOUNS[digest[1]! % NOUNS.length]!;
  return `${adjective}-${noun}-${digest.subarray(2, 4).toString('hex')}`;
}
