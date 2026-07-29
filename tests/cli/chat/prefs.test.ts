import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadPrefs, resolveLocale, savePrefs } from '../../../src/cli/chat/prefs.js';

const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars as NodeJS.ProcessEnv;

describe('resolveLocale', () => {
  it('honors an explicit language pref (en, cs, sk)', () => {
    expect(resolveLocale({ language: 'en' }, env({}))).toBe('en');
    expect(resolveLocale({ language: 'cs' }, env({}))).toBe('cs');
    expect(resolveLocale({ language: 'sk' }, env({}))).toBe('sk');
  });

  it('auto-detects Czech and Slovak from the POSIX locale environment', () => {
    expect(resolveLocale({}, env({ LANG: 'cs_CZ.UTF-8' }))).toBe('cs');
    expect(resolveLocale({}, env({ LANG: 'sk_SK.UTF-8' }))).toBe('sk');
    expect(resolveLocale({}, env({ LC_ALL: 'sk' }))).toBe('sk');
    expect(resolveLocale({}, env({ LC_MESSAGES: 'cs' }))).toBe('cs');
  });

  it('prefers LC_ALL over LC_MESSAGES over LANG', () => {
    expect(resolveLocale({}, env({ LC_ALL: 'sk_SK', LC_MESSAGES: 'cs_CZ', LANG: 'en_US' }))).toBe('sk');
    expect(resolveLocale({}, env({ LC_MESSAGES: 'cs_CZ', LANG: 'en_US' }))).toBe('cs');
  });

  it('falls back to English for an unset or unrelated locale', () => {
    expect(resolveLocale({}, env({}))).toBe('en');
    expect(resolveLocale({}, env({ LANG: 'de_DE.UTF-8' }))).toBe('en');
    expect(resolveLocale({}, env({ LANG: 'en_US.UTF-8' }))).toBe('en');
  });
});

describe('showMascot persistence', () => {
  it('round-trips through cli-prefs.json and merges without clobbering other prefs', () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-mascot-pref-'));
    try {
      const e = env({ HOME: home });
      expect(loadPrefs(e).showMascot).toBeUndefined(); // unset → the caller treats it as shown

      savePrefs({ theme: 'nord' }, e);
      savePrefs({ showMascot: false }, e);
      const prefs = loadPrefs(e);
      expect(prefs.showMascot).toBe(false); // survives a fresh load == a CLI restart
      expect(prefs.theme).toBe('nord');     // the earlier pref is not clobbered by the merge

      savePrefs({ showMascot: true }, e);
      expect(loadPrefs(e).showMascot).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
