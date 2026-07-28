import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { flagValue } from '../../src/cli/flags.js';

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
