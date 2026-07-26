import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { planFilePath } from '../../shared/paths.js';
import { logger } from '../../shared/logger.js';

/** Upper bound on a stored plan. The plan is re-injected VERBATIM into the prompt after a compaction,
 *  so an unbounded document would trade one context problem for another — a 200 KB "plan" would blow
 *  the budget the compaction just reclaimed. Generous enough for a decision-complete plan; anything
 *  past it is being used as something other than a plan. */
export const PLAN_MAX_CHARS = 16_000;

/** Persist a conversation's active plan, replacing any previous one — a new proposal supersedes the
 *  old, so there is exactly one plan per conversation and no history to reconcile.
 *
 *  Best-effort by design: this runs from the persistence projector while a turn settles, and a plan we
 *  failed to save is a degraded next turn, not a reason to fail the turn the user is waiting on. The
 *  failure is logged rather than swallowed so a permanently unwritable data dir stays visible. */
export function writePlan(sessionId: string, body: string): void {
  const trimmed = body.trim();
  if (!trimmed) return;
  const path = planFilePath(process.env, sessionId);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, trimmed.slice(0, PLAN_MAX_CHARS), 'utf8');
  } catch (e) {
    logger('continuity').warn(`failed to write plan for ${sessionId}`, e);
  }
}

/** The conversation's active plan, or undefined when none was captured (the common case) or the file
 *  is unreadable. A missing plan must read as "no plan", never as an error: every caller is assembling
 *  a prompt, and a throw there would cost the turn far more than the missing orientation. */
export function readPlan(sessionId: string): string | undefined {
  try {
    const body = readFileSync(planFilePath(process.env, sessionId), 'utf8').trim();
    return body || undefined;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger('continuity').warn(`failed to read plan for ${sessionId}`, e);
    }
    return undefined;
  }
}
