import { describe, it, expect } from 'vitest';
import { attachPty } from '../../src/terminal/ptySession.js';
import type { PtyModule } from '../../src/terminal/ptyLoader.js';

function fakePty() {
  const calls = { spawn: [] as unknown[][], write: [] as string[], resize: 0, killed: false, onData: null as null | ((d: string) => void) };
  const ipty = {
    onData: (cb: (d: string) => void) => { calls.onData = cb; },
    write: (d: string) => { calls.write.push(d); },
    resize: () => { calls.resize++; },
    kill: () => { calls.killed = true; },
  };
  const mod: PtyModule = { spawn: (f, a, o) => { calls.spawn.push([f, a, o]); return ipty; } };
  return { mod, calls };
}

describe('attachPty', () => {
  it('attaches to the named tmux session', () => {
    const { mod, calls } = fakePty();
    attachPty(mod, { session: 'elowen-advisor-1', cols: 80, rows: 24 });
    expect(calls.spawn[0][0]).toBe('tmux');
    expect(calls.spawn[0][1]).toEqual(['attach', '-t', '=elowen-advisor-1']); // '=' pins an exact session match (no prefix fallback to another user's pane)
    expect(calls.spawn[0][2]).toMatchObject({ cols: 80, rows: 24, name: 'xterm-256color' });
  });

  // A pane whose character map is not UTF-8 strips or escapes every accented character before it ever
  // reaches the browser, and nothing declares a locale for the daemon — the systemd unit sets only
  // ELOWEN_* and PATH, so today's LANG arrives by inheritance and would be absent on another host.
  describe('locale', () => {
    const LOCALE_KEYS = ['LANG', 'LC_ALL', 'LC_CTYPE'] as const;
    /** Spawn under an exact locale environment and report the env the PTY was actually given. */
    const spawnEnv = (locale: Partial<Record<(typeof LOCALE_KEYS)[number], string>>): NodeJS.ProcessEnv => {
      const saved = LOCALE_KEYS.map((k) => [k, process.env[k]] as const);
      for (const k of LOCALE_KEYS) delete process.env[k];
      Object.assign(process.env, locale);
      try {
        const { mod, calls } = fakePty();
        attachPty(mod, { session: 's', cols: 80, rows: 24 });
        return (calls.spawn[0][2] as { env: NodeJS.ProcessEnv }).env;
      } finally {
        for (const k of LOCALE_KEYS) delete process.env[k];
        for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
      }
    };

    it('forces UTF-8 when the inherited locale is ASCII-only', () => {
      // The exact shape an SSH client sends over `AcceptEnv LANG LC_*`: valid, and ANSI_X3.4-1968.
      const env = spawnEnv({ LC_ALL: 'C' });
      expect(env.LANG).toBe('C.UTF-8');
      // Both have to go: either one outranks LANG, so leaving them keeps the ASCII map.
      expect(env.LC_ALL).toBeUndefined();
      expect(env.LC_CTYPE).toBeUndefined();
    });

    it('forces UTF-8 when LC_CTYPE alone downgrades an otherwise fine locale', () => {
      const env = spawnEnv({ LANG: 'C.UTF-8', LC_CTYPE: 'C' });
      expect(env.LANG).toBe('C.UTF-8');
      expect(env.LC_CTYPE).toBeUndefined();
    });

    it('forces UTF-8 when no locale is inherited at all', () => {
      expect(spawnEnv({}).LANG).toBe('C.UTF-8');
    });

    it('leaves a UTF-8 locale alone, national ones included', () => {
      const env = spawnEnv({ LANG: 'cs_CZ.UTF-8' });
      expect(env.LANG).toBe('cs_CZ.UTF-8');
    });

    it('respects LC_ALL outranking a non-UTF-8 LANG', () => {
      const env = spawnEnv({ LANG: 'C', LC_ALL: 'en_US.UTF-8' });
      expect(env.LC_ALL).toBe('en_US.UTF-8'); // the effective map is already UTF-8 — nothing to correct
      expect(env.LANG).toBe('C');
    });
  });

  it('forwards writes, resize and kill', () => {
    const { mod, calls } = fakePty();
    const s = attachPty(mod, { session: 'elowen-advisor-1', cols: 80, rows: 24 });
    s.write('ls\n');
    s.resize(100, 40);
    s.kill();
    expect(calls.write).toEqual(['ls\n']);
    expect(calls.resize).toBe(1);
    expect(calls.killed).toBe(true);
  });
});
