import { describe, it, expect } from 'vitest';
import { parseLogLines, filterLogLines, formatLogSize, type LogLevel } from '../../../modules/settings/logFilter';

const levels = (...v: LogLevel[]) => new Set<LogLevel>(v);
const none = new Set<LogLevel>();

const SAMPLE = [
  '2026-07-25 17:33:34.120  INFO   [brain-stop]  stop s1: last observer gone',
  '2026-07-25 17:33:34.124  ERROR  [deriver]  tick failed — Error: tmux down',
  '    at Object.<anonymous> (/var/www/elowen/src/x.ts:12:5)',
  '    at run (/var/www/elowen/src/y.ts:3:1)',
  '2026-07-25 17:33:35.001  WARN   [discord]  gateway reconnecting',
  '2026-07-25 17:33:36.002  DEBUG  [cron]  tick',
];

describe('parseLogLines', () => {
  it('reads the level and scope off each record and numbers lines from one', () => {
    const parsed = parseLogLines(SAMPLE);
    expect(parsed[0]).toMatchObject({ n: 1, level: 'info', scope: 'brain-stop' });
    expect(parsed[1]).toMatchObject({ n: 2, level: 'error', scope: 'deriver' });
    expect(parsed[4]).toMatchObject({ n: 5, level: 'warn', scope: 'discord' });
    expect(parsed[5]).toMatchObject({ n: 6, level: 'debug', scope: 'cron' });
  });

  it('lets a stack-trace continuation inherit the record it belongs to', () => {
    const parsed = parseLogLines(SAMPLE);
    expect(parsed[2]).toMatchObject({ n: 3, level: 'error', scope: 'deriver' });
    expect(parsed[3]).toMatchObject({ n: 4, level: 'error', scope: 'deriver' });
  });

  it('leaves a leading continuation unattributed rather than guessing', () => {
    const parsed = parseLogLines(['    at boot (/x.ts:1:1)', SAMPLE[0]]);
    expect(parsed[0]).toMatchObject({ n: 1, level: null, scope: null });
    expect(parsed[1]).toMatchObject({ n: 2, level: 'info' });
  });

  it('handles an empty file', () => {
    expect(parseLogLines([])).toEqual([]);
  });
});

describe('filterLogLines', () => {
  const parsed = parseLogLines(SAMPLE);

  it('returns everything when nothing is filtered', () => {
    expect(filterLogLines(parsed, { query: '', levels: none })).toHaveLength(SAMPLE.length);
  });

  it('keeps an error together with its whole stack', () => {
    const out = filterLogLines(parsed, { query: '', levels: levels('error') });
    expect(out.map((l) => l.n)).toEqual([2, 3, 4]);
  });

  it('preserves the ORIGINAL line numbers through a filter', () => {
    const out = filterLogLines(parsed, { query: '', levels: levels('warn', 'debug') });
    expect(out.map((l) => l.n)).toEqual([5, 6]);
  });

  it('matches the query case-insensitively anywhere in the line, including the scope', () => {
    expect(filterLogLines(parsed, { query: 'BRAIN-STOP', levels: none }).map((l) => l.n)).toEqual([1]);
    expect(filterLogLines(parsed, { query: 'tmux', levels: none }).map((l) => l.n)).toEqual([2]);
  });

  it('combines query and levels as AND', () => {
    expect(filterLogLines(parsed, { query: 'tick', levels: levels('debug') }).map((l) => l.n)).toEqual([6]);
    expect(filterLogLines(parsed, { query: 'tick', levels: levels('error') }).map((l) => l.n)).toEqual([2]);
    expect(filterLogLines(parsed, { query: 'nothing here', levels: none })).toEqual([]);
  });

  it('ignores surrounding whitespace in the query', () => {
    expect(filterLogLines(parsed, { query: '  gateway  ', levels: none }).map((l) => l.n)).toEqual([5]);
  });
});

describe('formatLogSize', () => {
  it('scales the unit to the size', () => {
    expect(formatLogSize(512)).toBe('512 B');
    expect(formatLogSize(2048)).toBe('2.0 kB');
    expect(formatLogSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
