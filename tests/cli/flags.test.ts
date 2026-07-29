import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { flagValue, requireFlagValues } from '../../src/cli/flags.js';

describe('cli/flags.flagValue', () => {
  it('reads the token after the flag', () => {
    expect(flagValue(['--user', 'deploy'], '--user')).toBe('deploy');
    expect(flagValue(['--a', '1', '--user', 'deploy', '--b'], '--user')).toBe('deploy');
  });

  it('reads as absent when the flag is missing or trails the argv', () => {
    expect(flagValue(['--other', 'x'], '--user')).toBeUndefined();
    expect(flagValue(['--user'], '--user')).toBeUndefined();
  });

  it('never swallows a following flag as the value', () => {
    expect(flagValue(['--user', '--agents', 'all'], '--user')).toBeUndefined();
    expect(flagValue(['--admin-user', '--admin-pass', 'secret'], '--admin-user')).toBeUndefined();
    // …and the flag that WAS given a value still reads it
    expect(flagValue(['--admin-user', '--admin-pass', 'secret'], '--admin-pass')).toBe('secret');
  });

  it('keeps a value that merely contains dashes', () => {
    expect(flagValue(['--domain', 'my-host.dev'], '--domain')).toBe('my-host.dev');
    expect(flagValue(['--llm-model', '-mini'], '--llm-model')).toBe('-mini');
  });

  // The swallow guard above makes `--admin-pass --secret` unreadable, so there has to be a form that can
  // express a value starting with `--` at all.
  it('reads the `--name=value` form, including a value that starts with --', () => {
    expect(flagValue(['--admin-pass=--secret'], '--admin-pass')).toBe('--secret');
    expect(flagValue(['--a', '1', '--user=deploy'], '--user')).toBe('deploy');
    expect(flagValue(['--user=a=b'], '--user')).toBe('a=b');
    expect(flagValue(['--user='], '--user')).toBe('');
  });

  it('does not confuse a longer flag that shares a prefix', () => {
    expect(flagValue(['--admin-user=root'], '--admin')).toBeUndefined();
    expect(flagValue(['--user-agent=curl'], '--user')).toBeUndefined();
  });
});

describe('cli/flags.requireFlagValues', () => {
  it('passes when every named flag is absent or carries a value', () => {
    expect(() => requireFlagValues(['--user', 'deploy', '--no-tmux'], ['--user', '--domain'])).not.toThrow();
    expect(() => requireFlagValues(['--user=deploy'], ['--user'])).not.toThrow();
  });

  it('throws for a flag written without a value, naming every offender', () => {
    expect(() => requireFlagValues(['--user', '--agents', 'all'], ['--user', '--agents']))
      .toThrow(/missing value for --user/);
    expect(() => requireFlagValues(['--domain', '--user'], ['--user', '--domain']))
      .toThrow(/missing value for --user, --domain/);
  });

  it('points at the `--flag=value` escape in the message', () => {
    expect(() => requireFlagValues(['--admin-pass'], ['--admin-pass'])).toThrow(/--flag=value/);
  });

  it('ignores flags it was not asked about', () => {
    expect(() => requireFlagValues(['--domain'], ['--user'])).not.toThrow();
  });

  // `--admin-user=x --admin-pass=` passed the pair check in `elowen install` (both flags are present, so
  // neither is undefined) and then read falsy where the admin is built — the install finished with no
  // account and no warning. No value flag on these CLIs means anything as "", so reject it in the parser.
  it('rejects an empty value, which reads as present but means nothing', () => {
    expect(() => requireFlagValues(['--admin-pass='], ['--admin-pass'])).toThrow(/missing value for --admin-pass/);
    expect(() => requireFlagValues(['--admin-user=root', '--admin-pass='], ['--admin-user', '--admin-pass']))
      .toThrow(/missing value for --admin-pass/);
  });
});

// The three flag-list CLIs (`elowen` dispatch, `elowen install`, headless `elowen setup`) each used to
// carry their own copy of this reader, and install's copy had lost the swallow guard — a drift nobody
// noticed because each copy was only exercised through its own command. Pin the single source so a
// fourth copy can't quietly reappear in one of them.
describe('cli flag parsing has a single implementation', () => {
  const source = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

  it('no flag-list CLI defines its own argv-value reader', () => {
    for (const path of ['src/cli/index.ts', 'src/cli/install/index.ts', 'src/cli/setup/headless.ts']) {
      const text = source(path);
      expect(text, `${path} must not redefine the argv-value reader`).not.toMatch(/function (flag|flagValue)\s*\(/);
      expect(text, `${path} must import the shared reader`).toMatch(/from '[^']*\/flags\.js'/);
    }
  });
});
