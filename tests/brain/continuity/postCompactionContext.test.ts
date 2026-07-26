import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildPostCompactionContext, type PostCompactionStore } from '../../../src/brain/continuity/postCompactionContext.js';
import { writePlan } from '../../../src/brain/continuity/planStore.js';

describe('continuity/postCompactionContext', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'elowen-postcompact-'));
    vi.stubEnv('HOME', home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  /** A store holding just the rows a test cares about. */
  const storeWith = (...rows: { role: string; content: unknown }[]): PostCompactionStore => ({
    getMessages: () => rows.map((r) => ({ role: r.role, content: JSON.stringify(r.content) })),
  });
  const divider = (workingSet: unknown) => ({ role: 'compaction', content: { role: 'compactionSummary', workingSet } });
  const empty = storeWith();

  it('says nothing when there is neither a plan nor a working set', () => {
    expect(buildPostCompactionContext(empty, 's1', [])).toBe('');
  });

  it('carries the plan alone', () => {
    writePlan('s1', '# Ship it');
    const out = buildPostCompactionContext(empty, 's1', []);
    expect(out).toContain('<active-plan>\n# Ship it\n</active-plan>');
    expect(out).not.toContain('<working-set>');
  });

  it('carries the working set alone, labelling reads and edits', () => {
    const store = storeWith(divider([{ path: '/a.ts', wrote: true }, { path: '/b.ts', wrote: false }]));
    const out = buildPostCompactionContext(store, 's1', []);
    expect(out).toContain('- /a.ts (edited)');
    expect(out).toContain('- /b.ts (read)');
    expect(out).not.toContain('<active-plan>');
  });

  it('carries both in one reminder', () => {
    writePlan('s1', '# Ship it');
    const store = storeWith(divider([{ path: '/a.ts', wrote: true }]));
    const out = buildPostCompactionContext(store, 's1', []);
    expect(out).toContain('<active-plan>');
    expect(out).toContain('<working-set>');
    expect(out.startsWith('<system-reminder>')).toBe(true);
    expect(out.endsWith('</system-reminder>')).toBe(true);
  });

  // A compaction that kept the turn holding the plan cost the model nothing — repeating the document
  // would spend the very context the compaction reclaimed.
  it('omits a plan the model can still see in the live context', () => {
    writePlan('s1', '# Ship it');
    const live = [{ role: 'assistant', content: 'here it is <proposed_plan>\n# Ship it\n</proposed_plan>' }];
    expect(buildPostCompactionContext(empty, 's1', live)).toBe('');
  });

  it('still carries the working set when the plan is suppressed', () => {
    writePlan('s1', '# Ship it');
    const store = storeWith(divider([{ path: '/a.ts', wrote: false }]));
    const live = [{ role: 'assistant', content: '<proposed_plan>x</proposed_plan>' }];
    const out = buildPostCompactionContext(store, 's1', live);
    expect(out).not.toContain('<active-plan>');
    expect(out).toContain('- /a.ts (read)');
  });

  // Repeated compactions: orient around the most recent loss, not the first.
  it('reads the working set of the newest divider', () => {
    const store = storeWith(divider([{ path: '/old.ts', wrote: false }]), divider([{ path: '/new.ts', wrote: false }]));
    const out = buildPostCompactionContext(store, 's1', []);
    expect(out).toContain('/new.ts');
    expect(out).not.toContain('/old.ts');
  });

  it('tolerates a divider with no working set, an unparseable one, and a malformed list', () => {
    expect(buildPostCompactionContext(storeWith({ role: 'compaction', content: { role: 'compactionSummary' } }), 's1', [])).toBe('');
    expect(buildPostCompactionContext({ getMessages: () => [{ role: 'compaction', content: '{oops' }] }, 's1', [])).toBe('');
    expect(buildPostCompactionContext(storeWith(divider('not-a-list')), 's1', [])).toBe('');
    expect(buildPostCompactionContext(storeWith(divider([{ nope: 1 }])), 's1', [])).toBe('');
  });

  it('tells the model not to trust the summary about file contents', () => {
    writePlan('s1', 'x');
    expect(buildPostCompactionContext(empty, 's1', [])).toContain('do not assume file contents from the summary');
  });
});
