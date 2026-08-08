import { describe, it, expect } from 'vitest';
import { dataDir, dbPath, fsSafeSegment, logDir, runFile, sessionToolResultSpillDir, setSpillNamespaceResolver, toolResultSpillDir } from '../../src/shared/paths.js';

describe('shared/paths', () => {
  const env = { HOME: '/h' } as NodeJS.ProcessEnv;

  it('defaults the data dir to ~/.config/elowen', () => {
    expect(dataDir(env)).toBe('/h/.config/elowen');
  });
  it('derives the db path under the data dir', () => {
    expect(dbPath(env)).toBe('/h/.config/elowen/elowen.db');
  });
  it('lets ELOWEN_DB override the db path verbatim', () => {
    expect(dbPath({ HOME: '/h', ELOWEN_DB: '/tmp/x.db' } as NodeJS.ProcessEnv)).toBe('/tmp/x.db');
  });
  it('defaults logs under the data dir but honors ELOWEN_LOG_DIR', () => {
    expect(logDir(env)).toBe('/h/.config/elowen/logs');
    expect(logDir({ HOME: '/h', ELOWEN_LOG_DIR: '/var/log/o' } as NodeJS.ProcessEnv)).toBe('/var/log/o');
  });
  it('puts run.json in the data dir', () => {
    expect(runFile(env)).toBe('/h/.config/elowen/run.json');
  });
  it('spill dirs are per-session and path-safe for hostile ids', () => {
    expect(toolResultSpillDir(env, 'sess-1')).toBe('/h/.config/elowen/tool-results/sess-1');
    // Separators and dot segments in a minted id must never escape tool-results/.
    expect(toolResultSpillDir(env, 'a/b')).toBe('/h/.config/elowen/tool-results/a%2Fb');
    expect(toolResultSpillDir(env, '..')).toBe('/h/.config/elowen/tool-results/%..');
    expect(toolResultSpillDir(env, 'x%y')).toBe('/h/.config/elowen/tool-results/x%25y');
  });

  it('sessionToolResultSpillDir resolves the immutable namespace, falling back to the id', () => {
    try {
      // Unwired (tests, standalone processes): the id itself, the pre-namespace layout.
      expect(sessionToolResultSpillDir(env, 'sess-1')).toBe('/h/.config/elowen/tool-results/sess-1');
      setSpillNamespaceResolver((id) => (id === 'sess-1' ? 'sess-1-abc12345' : undefined));
      expect(sessionToolResultSpillDir(env, 'sess-1')).toBe('/h/.config/elowen/tool-results/sess-1-abc12345');
      // A session the resolver does not know keeps the id fallback rather than losing its dir.
      expect(sessionToolResultSpillDir(env, 'other')).toBe('/h/.config/elowen/tool-results/other');
      // An empty resolution (a pre-backfill row) falls back too — '' would collapse every such
      // session onto one shared directory.
      setSpillNamespaceResolver(() => '');
      expect(sessionToolResultSpillDir(env, 'legacy')).toBe('/h/.config/elowen/tool-results/legacy');
    } finally {
      setSpillNamespaceResolver(undefined);
    }
  });

  it('fsSafeSegment is injective even at the guard boundary', () => {
    // '.'/'..' get a '%' prefix no legitimate encoding can produce ('%' itself encodes to '%25'),
    // so a literal id like '_..' or '%..' can never collide with the guarded form.
    const ids = ['', '.', '..', '...', '_..', '%..', 'a', 'a/b', '%', 'a b'];
    const encoded = new Set(ids.map(fsSafeSegment));
    expect(encoded.size).toBe(ids.length);
    expect(fsSafeSegment('..')).toBe('%..');
    expect(fsSafeSegment('_..')).toBe('_..');
  });
});
