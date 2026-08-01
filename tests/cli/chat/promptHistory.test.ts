import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TUI } from '@earendil-works/pi-tui';
import { getSelectListTheme, initTheme } from '@earendil-works/pi-coding-agent';
import { ChatEditor } from '../../../src/cli/chat/picker.js';
import {
  appendPromptHistory,
  loadPromptHistory,
  MAX_PROMPT_HISTORY,
  MAX_STASH_ENTRIES,
  PromptStash,
} from '../../../src/cli/chat/promptHistory.js';

const dirs: string[] = [];
const makeEnv = (): NodeJS.ProcessEnv => {
  const home = mkdtempSync(join(tmpdir(), 'elowen-history-'));
  dirs.push(home);
  return { HOME: home };
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('prompt history persistence (per project)', () => {
  it('appends and reloads prompts in order, keyed by workDir', () => {
    const env = makeEnv();
    appendPromptHistory('/proj/a', 'first', env);
    appendPromptHistory('/proj/a', 'second', env);
    appendPromptHistory('/proj/b', 'other project', env);
    expect(loadPromptHistory('/proj/a', env)).toEqual(['first', 'second']);
    expect(loadPromptHistory('/proj/b', env)).toEqual(['other project']);
    expect(loadPromptHistory('/proj/c', env)).toEqual([]);
  });

  it('dedupes consecutive prompts but keeps non-adjacent repeats', () => {
    const env = makeEnv();
    appendPromptHistory('/p', 'npm test', env);
    appendPromptHistory('/p', 'npm test', env);
    appendPromptHistory('/p', 'fix it', env);
    appendPromptHistory('/p', 'npm test', env);
    expect(loadPromptHistory('/p', env)).toEqual(['npm test', 'fix it', 'npm test']);
  });

  it('caps the stored history and keeps the newest entries', () => {
    const env = makeEnv();
    for (let i = 0; i < MAX_PROMPT_HISTORY + 20; i++) appendPromptHistory('/p', `prompt ${i}`, env);
    const entries = loadPromptHistory('/p', env);
    expect(entries).toHaveLength(MAX_PROMPT_HISTORY);
    expect(entries[0]).toBe('prompt 20');
    expect(entries[entries.length - 1]).toBe(`prompt ${MAX_PROMPT_HISTORY + 19}`);
  });

  // The depth is a per-user setting (Account → Terminal) the CLI reads at boot, so BOTH ends have to
  // honour it: the writer, which decides what survives in the file, and the reader, which decides what a
  // session recalls out of a file another session may have written at a different depth.
  it('caps the writer at the CONFIGURED depth', () => {
    const env = makeEnv();
    for (let i = 0; i < 40; i++) appendPromptHistory('/p', `prompt ${i}`, env, 25);
    // Read back at a LARGER depth than it was written with, or the reader's own cap would hide whether
    // the writer truncated anything: what is asserted here is the state of the file.
    const entries = loadPromptHistory('/p', env, 1000);
    expect(entries).toHaveLength(25);
    expect(entries[0]).toBe('prompt 15');
    expect(entries[entries.length - 1]).toBe('prompt 39');
  });

  it('caps the reader at the CONFIGURED depth, without touching the stored file', () => {
    const env = makeEnv();
    for (let i = 0; i < 40; i++) appendPromptHistory('/p', `prompt ${i}`, env);
    expect(loadPromptHistory('/p', env, 30)).toHaveLength(30);
    expect(loadPromptHistory('/p', env, 30)[0]).toBe('prompt 10');
    expect(loadPromptHistory('/p', env)).toHaveLength(40); // the file itself still holds all 40
  });

  // The depth arrives over the wire from a daemon whose version the CLI does not control, so the bounds
  // are re-applied here. A depth of 0 would make the next sent prompt truncate the file to nothing.
  it('holds an out-of-range or absent depth inside the CLI-side bounds', () => {
    const env = makeEnv();
    for (let i = 0; i < 40; i++) appendPromptHistory('/p', `prompt ${i}`, env);
    expect(loadPromptHistory('/p', env, 0)).toHaveLength(20);          // floor
    expect(loadPromptHistory('/p', env, 9_999_999)).toHaveLength(40);  // ceiling raised, file is shorter
    expect(loadPromptHistory('/p', env, Number.NaN)).toHaveLength(40); // unusable → built-in default
    appendPromptHistory('/p', 'after a zero depth', env, 0);
    expect(loadPromptHistory('/p', env, 1000)).toHaveLength(20); // floored, never emptied
  });

  it('ignores blank prompts and survives a corrupt or missing file', () => {
    const env = makeEnv();
    appendPromptHistory('/p', '   ', env); // blank → no write at all
    expect(loadPromptHistory('/p', env)).toEqual([]);
    const file = join(env.HOME!, '.config', 'elowen', 'cli-history.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'not json{', 'utf-8');
    expect(loadPromptHistory('/p', env)).toEqual([]);
    appendPromptHistory('/p', 'recovers', env); // overwrites the corrupt file
    expect(loadPromptHistory('/p', env)).toEqual(['recovers']);
    expect(() => JSON.parse(readFileSync(file, 'utf-8'))).not.toThrow();
  });

  it('drops non-string junk from a tampered file instead of recalling it', () => {
    const env = makeEnv();
    const file = join(env.HOME!, '.config', 'elowen', 'cli-history.json');
    appendPromptHistory('/p', 'real', env);
    writeFileSync(file, JSON.stringify({ '/p': ['real', 42, null, ''] }), 'utf-8');
    expect(loadPromptHistory('/p', env)).toEqual(['real']);
  });
});

describe('persisted history feeds the editor ↑-recall across sessions', () => {
  beforeAll(() => { initTheme(); });

  it('walks back through reloaded prompts and forward to the empty draft', () => {
    const env = makeEnv();
    appendPromptHistory('/p', 'oldest', env);
    appendPromptHistory('/p', 'newest', env);
    const tui = { requestRender: () => { /* not rendering */ }, terminal: { rows: 24, columns: 80 } } as unknown as TUI;
    const editor = new ChatEditor(tui, { borderColor: (s) => s, selectList: getSelectListTheme() }, {});
    for (const entry of loadPromptHistory('/p', env)) editor.addToHistory(entry); // the runChat seeding
    const press = (data: string): void => { editor.render(60); editor.handleInput(data); };
    press('\x1b[A');
    expect(editor.getText()).toBe('newest');
    press('\x1b[A');
    expect(editor.getText()).toBe('oldest');
    press('\x1b[B');
    expect(editor.getText()).toBe('newest');
    press('\x1b[B'); // past the newest → the (empty) draft comes back
    expect(editor.getText()).toBe('');
  });
});

describe('PromptStash (ctrl+s)', () => {
  it('is LIFO: the most recently stashed draft pops first', () => {
    const stash = new PromptStash();
    stash.push('first draft');
    stash.push('second draft');
    expect(stash.size).toBe(2);
    expect(stash.pop()).toBe('second draft');
    expect(stash.pop()).toBe('first draft');
    expect(stash.pop()).toBeUndefined();
    expect(stash.size).toBe(0);
  });

  it('ignores blank drafts and caps at the max, dropping the oldest', () => {
    const stash = new PromptStash();
    stash.push('   ');
    expect(stash.size).toBe(0);
    for (let i = 0; i < MAX_STASH_ENTRIES + 3; i++) stash.push(`draft ${i}`);
    expect(stash.size).toBe(MAX_STASH_ENTRIES);
    expect(stash.pop()).toBe(`draft ${MAX_STASH_ENTRIES + 2}`);
    let last: string | undefined;
    for (let i = 0; i < MAX_STASH_ENTRIES - 1; i++) last = stash.pop();
    expect(last).toBe('draft 3'); // drafts 0–2 fell off the bottom
  });
});
