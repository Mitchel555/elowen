import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { planFilePath } from '../../shared/paths.js';
import { realAbs, realPathWithin } from '../../plugins/pathGuard.js';
import { logger } from '../../shared/logger.js';

/** Is `candidate` exactly this session's plan file?
 *
 *  This is a SECURITY boundary, not a convenience. Plan mode is read-only because it withholds every
 *  writing tool; admitting one back so the model can author its plan is only safe while this predicate
 *  is exact. A false positive here does not misplace a file — it hands plan mode arbitrary write access.
 *
 *  Two properties do the work, and both are needed:
 *
 *  1. The candidate is resolved through symlinks and `..` BEFORE anything is compared, so neither a
 *     traversal nor a link in a parent directory can point somewhere else while spelling the right path.
 *  2. The resolved path must land INSIDE the plans directory. Comparing it against the resolved expected
 *     path alone would look right and be wrong: if the plan file were itself a symlink pointing out of
 *     the directory, both sides would resolve to the same foreign target and agree. Containment is what
 *     refuses that, so it is checked first and the file name is matched inside the RESOLVED directory.
 *
 *  Deny-by-default throughout: anything unresolvable, relative to nowhere, or merely near the plan file
 *  is refused. What this cannot cover is a swap between this check and the write that follows it; the
 *  plans directory lives under the daemon's own config dir and a plan turn has no tool able to create a
 *  link there, so the window is closed by what plan mode withholds rather than by this function. */
export function isSessionPlanPath(sessionId: string, candidate: string): boolean {
  if (!candidate) return false;
  const expected = planFilePath(process.env, sessionId);
  const plansDir = dirname(expected);
  const resolved = realPathWithin(candidate, [plansDir]);
  if (!resolved) return false;
  return resolved === join(realAbs(plansDir), basename(expected));
}

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
