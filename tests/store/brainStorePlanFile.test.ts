import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { planFilePath } from '../../src/shared/paths.js';
import { readPlan } from '../../src/brain/continuity/planStore.js';
import { seedPlan } from '../helpers/plan.js';

/** Channel session ids are DETERMINISTIC and get reused, so a plan file left behind by a delete or a
 *  rollover is not merely orphaned — it is re-injected into the prompt of the next conversation minted
 *  onto that id. These tests pin the behaviour when the filesystem refuses to cooperate. */

const SESSION = 'brain-ch-discord-123';
let home: string;
let planDir: string;

beforeEach(() => {
  home = mkdtempSync(`${tmpdir()}/elowen-plan-`);
  process.env.HOME = home;
  planDir = dirname(planFilePath(process.env, SESSION));
});

afterEach(() => {
  // The directory is made read-only by one of the tests; restore it or the cleanup cannot recurse.
  try { chmodSync(planDir, 0o755); } catch { /* the test may not have created it */ }
  rmSync(home, { recursive: true, force: true });
  delete process.env.HOME;
});

describe('the plan file follows its conversation', () => {
  it('is gone once the conversation is deleted', () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: SESSION, userId: 7, model: 'm' });
    seedPlan(SESSION, '1. read the code\n2. change it');
    expect(readPlan(SESSION)).toContain('read the code');

    store.deleteSession(SESSION);
    expect(existsSync(planFilePath(process.env, SESSION))).toBe(false);
    expect(readPlan(SESSION)).toBeUndefined();
  });

  it('is blanked, not left readable, when it cannot be removed', () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: SESSION, userId: 7, model: 'm' });
    seedPlan(SESSION, 'someone else’s plan');

    // A read-only PARENT directory makes unlink fail (EACCES) while the file itself stays writable — the
    // real shape of "the plan cannot be deleted". Running as root would bypass this, so guard the premise.
    chmodSync(planDir, 0o555);
    const path = planFilePath(process.env, SESSION);
    let removable = false;
    try { rmSync(path, { force: true }); removable = true; } catch { /* expected */ }
    if (removable) {
      seedPlan(SESSION, 'someone else’s plan');
      chmodSync(planDir, 0o555);
    }
    expect(removable, 'the premise failed: the file was deletable, so this test proves nothing').toBe(false);

    store.deleteSession(SESSION);

    // The delete still succeeded, and whatever is left on disk can no longer be read as a plan — which is
    // the only harm a leftover could do to the next session that lands on this deterministic id.
    expect(readFileSync(path, 'utf8')).toBe('');
    expect(readPlan(SESSION)).toBeUndefined();
  });
});
