import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PLAN_MAX_CHARS, readPlan, writePlan } from '../../../src/brain/continuity/planStore.js';

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
});
