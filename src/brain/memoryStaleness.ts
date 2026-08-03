import { parseDbTs } from '../shared/time.js';

/** Age past which a recalled memory carries an explicit staleness warning. Claude Code warns after a
 *  single day because its memories cite file:line positions that rot fast; ours are mostly stable
 *  preferences and infrastructure facts, and a warning on nearly every recalled memory would train the
 *  model to skim past it. Two weeks keeps facts touched by current work clean while still flagging
 *  observations old enough that the environment has plausibly moved on. */
export const MEMORY_STALE_AFTER_DAYS = 14;

/** Whole days since the memory's last update, or null when the timestamp is missing, unparseable or in
 *  the future — all treated as "age unknown", because no warning beats a wrong one. */
export function memoryAgeDays(updatedAt: string | null | undefined, nowMs: number): number | null {
  const ts = parseDbTs(updatedAt);
  if (ts === 0 || ts > nowMs) return null;
  return Math.floor((nowMs - ts) / 86_400_000);
}

/** The one staleness warning both recall paths (turn-start block, live mid-turn recall) append past
 *  {@link MEMORY_STALE_AFTER_DAYS}. Returns '' below the threshold so callers can interpolate it
 *  unconditionally. */
export function memoryStalenessNote(ageDays: number | null): string {
  if (ageDays === null || ageDays < MEMORY_STALE_AFTER_DAYS) return '';
  return `This memory was last updated ${ageDays} days ago and records a point-in-time observation, `
    + 'not live state — verify anything it claims about code, paths or configuration against the '
    + 'current environment before asserting it as fact.';
}
