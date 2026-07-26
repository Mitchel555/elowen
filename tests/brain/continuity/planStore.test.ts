import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PLAN_MAX_CHARS, isSessionPlanPath, readPlan, writePlan } from '../../../src/brain/continuity/planStore.js';

describe('continuity/planStore', () => {
  let home: string;
  const planFile = (sessionId: string) => join(home, '.config/elowen/plans', `${sessionId}.md`);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'elowen-plans-'));
    vi.stubEnv('HOME', home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('writes a plan and reads it back verbatim', () => {
    writePlan('s1', '# Ship it\n\nStep one.');
    expect(readPlan('s1')).toBe('# Ship it\n\nStep one.');
  });

  it('creates the plans directory on first write', () => {
    expect(existsSync(join(home, '.config/elowen/plans'))).toBe(false);
    writePlan('s1', 'anything');
    expect(existsSync(planFile('s1'))).toBe(true);
  });

  // No plan is the common case — it must read as "nothing to say", not as a failure, because every
  // caller is mid-way through assembling a prompt.
  it('reports no plan for a conversation that never proposed one', () => {
    expect(readPlan('never-planned')).toBeUndefined();
  });

  it('replaces the previous plan rather than appending to it', () => {
    writePlan('s1', 'first');
    writePlan('s1', 'second');
    expect(readPlan('s1')).toBe('second');
  });

  it('scopes plans per conversation', () => {
    writePlan('s1', 'mine');
    writePlan('s2', 'theirs');
    expect(readPlan('s1')).toBe('mine');
    expect(readPlan('s2')).toBe('theirs');
  });

  // The plan is re-injected verbatim after a compaction, so an unbounded document would spend the
  // context the compaction just reclaimed.
  it('truncates an oversized plan', () => {
    writePlan('s1', 'x'.repeat(PLAN_MAX_CHARS + 500));
    expect(readPlan('s1')).toHaveLength(PLAN_MAX_CHARS);
  });

  it('ignores an empty or whitespace-only plan instead of storing a blank file', () => {
    writePlan('s1', '   \n\t ');
    expect(existsSync(planFile('s1'))).toBe(false);
    expect(readPlan('s1')).toBeUndefined();
  });

  it('treats a file that holds only whitespace as no plan', () => {
    mkdirSync(join(home, '.config/elowen/plans'), { recursive: true });
    writeFileSync(planFile('s1'), '  \n  ');
    expect(readPlan('s1')).toBeUndefined();
  });

  // A session id becomes a path component, so a separator in it must not escape the plans directory.
  it('keeps an id carrying path separators inside the plans directory', () => {
    writePlan('brain-ch-a/../../escape', 'contained');
    expect(existsSync(join(home, '.config/elowen/plans'))).toBe(true);
    expect(existsSync(join(home, '.config/elowen/escape.md'))).toBe(false);
    expect(readPlan('brain-ch-a/../../escape')).toBe('contained');
  });

  // This predicate is what makes it safe to hand plan mode a writing tool at all. A false positive does
  // not misplace a file — it turns plan mode into arbitrary write access, so each way of spelling
  // "somewhere else" gets its own case.
  describe('isSessionPlanPath', () => {
    const plansDir = () => join(home, '.config/elowen/plans');

    it('accepts exactly this session\'s plan file', () => {
      writePlan('s1', 'x');
      expect(isSessionPlanPath('s1', planFile('s1'))).toBe(true);
    });

    it('refuses another session\'s plan, and the directory itself', () => {
      writePlan('s1', 'x');
      writePlan('s2', 'y');
      expect(isSessionPlanPath('s1', planFile('s2'))).toBe(false);
      expect(isSessionPlanPath('s1', plansDir())).toBe(false);
    });

    it('refuses a traversal that spells the right name from outside', () => {
      writePlan('s1', 'x');
      expect(isSessionPlanPath('s1', join(plansDir(), '..', 'plans', 's1.md'))).toBe(true); // still the same file
      expect(isSessionPlanPath('s1', join(plansDir(), '..', 'elowen.db'))).toBe(false);
      expect(isSessionPlanPath('s1', join(plansDir(), '..', '..', '..', 'etc', 'passwd'))).toBe(false);
    });

    // The case that makes containment load-bearing: comparing the candidate against the RESOLVED expected
    // path would let a symlinked plan file agree with itself and wave a write through to the target.
    it('refuses when the plan file itself is a symlink out of the directory', () => {
      mkdirSync(plansDir(), { recursive: true });
      const outside = join(home, 'outside.md');
      writeFileSync(outside, 'victim');
      symlinkSync(outside, join(plansDir(), 's1.md'));
      expect(isSessionPlanPath('s1', planFile('s1'))).toBe(false);
    });

    it('refuses a symlink in the plans directory pointing at a neighbour', () => {
      mkdirSync(plansDir(), { recursive: true });
      writeFileSync(join(plansDir(), 'other.md'), 'other');
      symlinkSync(join(plansDir(), 'other.md'), join(plansDir(), 's1.md'));
      expect(isSessionPlanPath('s1', planFile('s1'))).toBe(false);
    });

    // Reached THROUGH a link but landing on the real file is fine — the resolved path is what counts.
    it('accepts the real file reached through a symlinked directory', () => {
      writePlan('s1', 'x');
      const link = join(home, 'link-to-plans');
      symlinkSync(plansDir(), link);
      expect(isSessionPlanPath('s1', join(link, 's1.md'))).toBe(true);
    });

    it('refuses empty, relative and near-miss paths', () => {
      writePlan('s1', 'x');
      expect(isSessionPlanPath('s1', '')).toBe(false);
      expect(isSessionPlanPath('s1', 's1.md')).toBe(false);
      expect(isSessionPlanPath('s1', `${planFile('s1')}.bak`)).toBe(false);
      expect(isSessionPlanPath('s1', join(plansDir(), 'sub', 's1.md'))).toBe(false);
    });

    // The file need not exist yet: the model writes it for the first time from inside plan mode.
    it('accepts the path before the plan file exists', () => {
      mkdirSync(plansDir(), { recursive: true });
      expect(isSessionPlanPath('s1', planFile('s1'))).toBe(true);
    });
  });
});
