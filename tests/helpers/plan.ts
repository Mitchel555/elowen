import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { planFilePath } from '../../src/shared/paths.js';

/** Put a plan on disk the way a plan-mode turn would, for tests that need one to already exist.
 *
 *  Production has no such helper on purpose: the plan file is written by the MODEL through the clamped
 *  Write/Edit tools, so a `writePlan` in `src/` would be a second ingress that nothing calls and that
 *  tests could drift against — every plan test would be exercising a path production never takes. */
export function seedPlan(sessionId: string, body: string): void {
  const path = planFilePath(process.env, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');
}
