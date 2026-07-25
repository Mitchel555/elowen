import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isAbsolute, join } from 'node:path';
import { logDir } from '../../src/shared/paths.js';

/** The log directory is read once at module load, so each case needs a fresh module registry. */
async function loadLogDir(env: Record<string, string | undefined>): Promise<string> {
  vi.resetModules();
  const previous = { ...process.env };
  Object.assign(process.env, env);
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key];
  try {
    return (await import('../../src/shared/logger.js')).LOG_DIR;
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

describe('logger log directory', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('honours ELOWEN_LOG_DIR, which is what the systemd units set', async () => {
    await expect(loadLogDir({ ELOWEN_LOG_DIR: '/srv/elowen-logs', HOME: '/home/someone' })).resolves.toBe('/srv/elowen-logs');
  });

  // Regression: the default used to be `<cwd>/logs`. The daemon's WorkingDirectory is the repo root, so a
  // run without ELOWEN_LOG_DIR (any plain dev launch) wrote logs INTO the checkout — leaving a second,
  // rival log folder beside the installed one, which an npm update would silently discard.
  it('falls back to the shared data dir, never the working directory', async () => {
    const dir = await loadLogDir({ ELOWEN_LOG_DIR: undefined, HOME: '/home/someone' });
    expect(dir).toBe(join('/home/someone', '.config', 'elowen', 'logs'));
  });

  // The same bug one directory deeper, and the case the assertion above cannot reach: with HOME unset —
  // or set to '', which `??` happily passed through — join produced a RELATIVE '.config/elowen/logs'
  // that resolves against the process cwd. That is the in-checkout log folder all over again.
  it('stays absolute when HOME is unset or empty', async () => {
    for (const HOME of [undefined, '']) {
      const dir = await loadLogDir({ ELOWEN_LOG_DIR: undefined, HOME });
      expect(isAbsolute(dir), `HOME=${String(HOME)}`).toBe(true);
    }
  });

  // An empty ELOWEN_LOG_DIR meant "the current directory" under `??`, which is never what an operator
  // who left the variable blank intended.
  it('treats an empty ELOWEN_LOG_DIR as unset', async () => {
    const dir = await loadLogDir({ ELOWEN_LOG_DIR: '', HOME: '/home/someone' });
    expect(dir).toBe(join('/home/someone', '.config', 'elowen', 'logs'));
  });

  it('resolves to exactly what the shared paths helper says, so there is one rule', async () => {
    const env = { ELOWEN_LOG_DIR: undefined, HOME: '/home/someone' };
    await expect(loadLogDir(env)).resolves.toBe(logDir({ HOME: '/home/someone' } as NodeJS.ProcessEnv));
  });
});
