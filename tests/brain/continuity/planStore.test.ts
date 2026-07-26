import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PLAN_MAX_CHARS, ensurePlanDir, readPlan } from '../../../src/brain/continuity/planStore.js';
import { isSessionPlanPath } from '../../../src/plugins/pathGuard.js';
import { seedPlan } from '../../helpers/plan.js';
import { planSlug } from '../../../src/shared/planSlug.js';

describe('continuity/planStore', () => {
  let home: string;
  const planFile = (sessionId: string) => join(home, '.config/elowen/plans', `${planSlug(sessionId)}.md`);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'elowen-plans-'));
    vi.stubEnv('HOME', home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('writes a plan and reads it back verbatim', () => {
    seedPlan('s1', '# Ship it\n\nStep one.');
    expect(readPlan('s1')).toBe('# Ship it\n\nStep one.');
  });

  // The model is told to write its plan here, but Write does not create parent directories and plan
  // mode denies `mkdir -p`. Doing this lazily rather than at startup is what makes it survive an
  // instance that UPDATED into the feature without restarting, or someone deleting the directory.
  it('creates the plans directory on demand, and again after it is removed', () => {
    const plans = join(home, '.config/elowen/plans');
    expect(existsSync(plans)).toBe(false);
    expect(ensurePlanDir('s1')).toBe(true);
    expect(existsSync(plans)).toBe(true);
    rmSync(plans, { recursive: true, force: true });
    expect(ensurePlanDir('s1')).toBe(true);
    expect(existsSync(plans)).toBe(true);
  });

  // The cap has to live on the read: the file is written by the model through the clamped Write tool
  // and may be edited by hand, so neither ingress passes through this module.
  it('caps an oversized plan written by something other than this module', () => {
    seedPlan('s1', 'x'.repeat(PLAN_MAX_CHARS + 5_000));
    expect(readPlan('s1')?.length).toBe(PLAN_MAX_CHARS);
  });

  it('creates the plans directory on first write', () => {
    expect(existsSync(join(home, '.config/elowen/plans'))).toBe(false);
    seedPlan('s1', 'anything');
    expect(existsSync(planFile('s1'))).toBe(true);
  });

  // No plan is the common case — it must read as "nothing to say", not as a failure, because every
  // caller is mid-way through assembling a prompt.
  it('reports no plan for a conversation that never proposed one', () => {
    expect(readPlan('never-planned')).toBeUndefined();
  });

  it('replaces the previous plan rather than appending to it', () => {
    seedPlan('s1', 'first');
    seedPlan('s1', 'second');
    expect(readPlan('s1')).toBe('second');
  });

  it('scopes plans per conversation', () => {
    seedPlan('s1', 'mine');
    seedPlan('s2', 'theirs');
    expect(readPlan('s1')).toBe('mine');
    expect(readPlan('s2')).toBe('theirs');
  });

  // The plan is re-injected verbatim after a compaction, so an unbounded document would spend the
  // context the compaction just reclaimed.
  it('truncates an oversized plan', () => {
    seedPlan('s1', 'x'.repeat(PLAN_MAX_CHARS + 500));
    expect(readPlan('s1')).toHaveLength(PLAN_MAX_CHARS);
  });

  it('treats a file that holds only whitespace as no plan', () => {
    mkdirSync(join(home, '.config/elowen/plans'), { recursive: true });
    writeFileSync(planFile('s1'), '  \n  ');
    expect(readPlan('s1')).toBeUndefined();
  });

  // The filename is now a derived slug rather than the id itself, which is what makes an escape
  // impossible; asserted end-to-end here so the guarantee is pinned at the level the caller sees.
  it('keeps an id carrying path separators inside the plans directory', () => {
    seedPlan('brain-ch-a/../../escape', 'contained');
    expect(existsSync(join(home, '.config/elowen/plans'))).toBe(true);
    expect(existsSync(join(home, '.config/elowen/escape.md'))).toBe(false);
    expect(readPlan('brain-ch-a/../../escape')).toBe('contained');
  });

  // This predicate is what makes it safe to hand plan mode a writing tool at all. A false positive does
  // not misplace a file — it turns plan mode into arbitrary write access, so each way of spelling
  // "somewhere else" gets its own case.
  describe('isSessionPlanPath', () => {
    const plansDir = () => join(home, '.config/elowen/plans');
    const planName = `${planSlug('s1')}.md`;

    it('accepts exactly this session\'s plan file', () => {
      seedPlan('s1', 'x');
      expect(isSessionPlanPath('s1', planFile('s1'))).toBe(true);
    });

    it('refuses another session\'s plan, and the directory itself', () => {
      seedPlan('s1', 'x');
      seedPlan('s2', 'y');
      expect(isSessionPlanPath('s1', planFile('s2'))).toBe(false);
      expect(isSessionPlanPath('s1', plansDir())).toBe(false);
    });

    it('refuses a traversal that spells the right name from outside', () => {
      seedPlan('s1', 'x');
      expect(isSessionPlanPath('s1', join(plansDir(), '..', 'plans', planName))).toBe(true); // still the same file
      expect(isSessionPlanPath('s1', join(plansDir(), '..', 'elowen.db'))).toBe(false);
      expect(isSessionPlanPath('s1', join(plansDir(), '..', '..', '..', 'etc', 'passwd'))).toBe(false);
    });

    // The case that makes containment load-bearing: comparing the candidate against the RESOLVED expected
    // path would let a symlinked plan file agree with itself and wave a write through to the target.
    it('refuses when the plan file itself is a symlink out of the directory', () => {
      mkdirSync(plansDir(), { recursive: true });
      const outside = join(home, 'outside.md');
      writeFileSync(outside, 'victim');
      symlinkSync(outside, join(plansDir(), planName));
      expect(isSessionPlanPath('s1', planFile('s1'))).toBe(false);
    });

    it('refuses a symlink in the plans directory pointing at a neighbour', () => {
      mkdirSync(plansDir(), { recursive: true });
      writeFileSync(join(plansDir(), 'other.md'), 'other');
      symlinkSync(join(plansDir(), 'other.md'), join(plansDir(), planName));
      expect(isSessionPlanPath('s1', planFile('s1'))).toBe(false);
    });

    // Reached THROUGH a link but landing on the real file is fine — the resolved path is what counts.
    it('accepts the real file reached through a symlinked directory', () => {
      seedPlan('s1', 'x');
      const link = join(home, 'link-to-plans');
      symlinkSync(plansDir(), link);
      expect(isSessionPlanPath('s1', join(link, planName))).toBe(true);
    });

    it('refuses empty, relative and near-miss paths', () => {
      seedPlan('s1', 'x');
      expect(isSessionPlanPath('s1', '')).toBe(false);
      expect(isSessionPlanPath('s1', planName)).toBe(false);
      expect(isSessionPlanPath('s1', `${planFile('s1')}.bak`)).toBe(false);
      expect(isSessionPlanPath('s1', join(plansDir(), 'sub', planName))).toBe(false);
    });

    // The file need not exist yet: the model writes it for the first time from inside plan mode.
    it('accepts the path before the plan file exists', () => {
      mkdirSync(plansDir(), { recursive: true });
      expect(isSessionPlanPath('s1', planFile('s1'))).toBe(true);
    });
  });
});
