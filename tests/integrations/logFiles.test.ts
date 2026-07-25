import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listLogFiles,
  readLogFile,
  deleteLogFile,
  deleteAllLogFiles,
  isLogFileName,
  DEFAULT_LOG_TAIL_LINES,
  MAX_LOG_TAIL_LINES,
} from '../../src/integrations/logFiles.js';

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'elowen-logs-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const write = (name: string, body: string): void => writeFileSync(join(dir, name), body);
/** Pin a file's mtime (seconds since epoch) so ordering assertions don't race the filesystem clock. */
const touch = (name: string, seconds: number): void => utimesSync(join(dir, name), seconds, seconds);

describe('log file names', () => {
  it('accepts exactly the two daily shapes the loggers produce', () => {
    expect(isLogFileName('daemon-2026-07-25.log')).toBe(true);
    expect(isLogFileName('web-2026-07-25.log')).toBe(true);
  });

  it('rejects anything else, including the traversal and absolute forms a caller could try', () => {
    for (const name of [
      '../../etc/passwd', '/etc/passwd', 'daemon-2026-07-25.log/../../x',
      '.env', 'elowen.db', 'daemon.log', 'daemon-2026-7-5.log', 'DAEMON-2026-07-25.LOG',
      'daemon-2026-07-25.log.bak', '', '.', '..',
    ]) {
      expect(isLogFileName(name), name).toBe(false);
    }
  });
});

describe('listLogFiles', () => {
  it('returns only daily logs, tagged by source and newest first', () => {
    write('daemon-2026-07-24.log', 'a\n');
    write('web-2026-07-25.log', 'b\n');
    write('elowen.db', 'not a log');
    write('notes.txt', 'not a log');
    mkdirSync(join(dir, 'daemon-2026-07-23.log')); // a directory wearing a log's name
    // Both files land in the same millisecond, which would make the sort a coin flip — stamp them apart
    // so the assertion tests the ordering rule rather than the filesystem clock.
    touch('daemon-2026-07-24.log', 1_000);
    touch('web-2026-07-25.log', 2_000);

    const files = listLogFiles(dir);
    expect(files.map((f) => f.name)).toEqual(['web-2026-07-25.log', 'daemon-2026-07-24.log']);
    expect(files.map((f) => f.source)).toEqual(['web', 'daemon']);
    expect(files[0].bytes).toBe(2);
  });

  it('never follows a symlink planted in the log directory', () => {
    const secret = join(dir, 'secret.txt');
    writeFileSync(secret, 'password');
    symlinkSync(secret, join(dir, 'daemon-2026-07-25.log'));
    expect(listLogFiles(dir)).toEqual([]);
    expect(readLogFile('daemon-2026-07-25.log', 10, dir)).toEqual({ ok: false, reason: 'missing' });
  });

  it('treats a missing log directory as empty rather than an error', () => {
    expect(listLogFiles(join(dir, 'nope'))).toEqual([]);
  });
});

describe('readLogFile', () => {
  it('returns the whole file untruncated when it fits', () => {
    write('daemon-2026-07-25.log', 'one\ntwo\nthree\n');
    const result = readLogFile('daemon-2026-07-25.log', 10, dir);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('expected a read');
    expect(result.content.lines).toEqual(['one', 'two', 'three']);
    expect(result.content.totalLines).toBe(3);
    expect(result.content.truncated).toBe(false);
  });

  it('keeps the NEWEST lines when the file is longer than the limit', () => {
    write('daemon-2026-07-25.log', Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n') + '\n');
    const result = readLogFile('daemon-2026-07-25.log', 3, dir);
    if (!result.ok) throw new Error('expected a read');
    expect(result.content.lines).toEqual(['line 97', 'line 98', 'line 99']);
    expect(result.content.totalLines).toBe(100);
    expect(result.content.truncated).toBe(true);
  });

  // The previous version of this test ran against a 2-line file and only asserted `ok`, so every hostile
  // value passed trivially — including the one that was actually broken. The file must be LONGER than the
  // clamp for the clamp to be observable at all.
  it('clamps a hostile limit instead of trusting it', () => {
    const total = DEFAULT_LOG_TAIL_LINES + 1;
    write('daemon-2026-07-25.log', `${Array.from({ length: total }, (_, i) => `line ${i}`).join('\n')}\n`);
    const read = (limit: number) => {
      const result = readLogFile('daemon-2026-07-25.log', limit, dir);
      if (!result.ok) throw new Error(`expected a read for ${limit}`);
      return result.content;
    };
    // Below the floor clamps up to a single line — the last one, since this is a tail — never to zero
    // or a negative slice.
    expect(read(0).lines).toEqual([`line ${total - 1}`]);
    expect(read(-5).lines).toEqual([`line ${total - 1}`]);
    // A float is floored, not passed to slice() as-is.
    expect(read(2.7).lines).toEqual([`line ${total - 2}`, `line ${total - 1}`]);
    // Non-finite is the case that regressed: Math.floor(NaN) is NaN, every comparison against it is
    // false, and the read silently returned the WHOLE file. It must fall back to the default bound.
    expect(read(Number.NaN).lines).toHaveLength(DEFAULT_LOG_TAIL_LINES);
    expect(read(Number.NaN).truncated).toBe(true);
    expect(read(Number.POSITIVE_INFINITY).lines).toHaveLength(DEFAULT_LOG_TAIL_LINES);
    // Above the ceiling is capped, but the cap is far above this file, so it reads whole.
    expect(read(MAX_LOG_TAIL_LINES * 10).lines).toHaveLength(total);
  });

  it('reads an empty file as no lines, not one blank one', () => {
    write('daemon-2026-07-25.log', '');
    const result = readLogFile('daemon-2026-07-25.log', 10, dir);
    if (!result.ok) throw new Error('expected a read');
    expect(result.content.lines).toEqual([]);
    expect(result.content.totalLines).toBe(0);
  });

  it('refuses an illegal name and reports a missing file distinctly', () => {
    expect(readLogFile('../../etc/passwd', 10, dir)).toEqual({ ok: false, reason: 'invalid' });
    expect(readLogFile('daemon-2026-01-01.log', 10, dir)).toEqual({ ok: false, reason: 'missing' });
  });

  it('defaults to a bounded tail so a huge file cannot be pulled in whole by accident', () => {
    expect(DEFAULT_LOG_TAIL_LINES).toBeLessThanOrEqual(MAX_LOG_TAIL_LINES);
    write('daemon-2026-07-25.log', Array.from({ length: DEFAULT_LOG_TAIL_LINES + 50 }, () => 'x').join('\n'));
    const result = readLogFile('daemon-2026-07-25.log', undefined, dir);
    if (!result.ok) throw new Error('expected a read');
    expect(result.content.lines).toHaveLength(DEFAULT_LOG_TAIL_LINES);
    expect(result.content.truncated).toBe(true);
  });
});

describe('deleting logs', () => {
  it('deletes one file and refuses an illegal or absent name', () => {
    write('daemon-2026-07-25.log', 'x\n');
    expect(deleteLogFile('daemon-2026-07-25.log', dir)).toEqual({ ok: true });
    expect(existsSync(join(dir, 'daemon-2026-07-25.log'))).toBe(false);
    expect(deleteLogFile('daemon-2026-07-25.log', dir)).toEqual({ ok: false, reason: 'missing' });
    expect(deleteLogFile('../../etc/passwd', dir)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('sweeps every log while leaving non-log files in the directory alone', () => {
    write('daemon-2026-07-24.log', 'a\n');
    write('daemon-2026-07-25.log', 'b\n');
    write('web-2026-07-25.log', 'c\n');
    write('elowen.db', 'precious');

    expect(deleteAllLogFiles(dir)).toBe(3);
    expect(listLogFiles(dir)).toEqual([]);
    expect(existsSync(join(dir, 'elowen.db'))).toBe(true);
  });
});
