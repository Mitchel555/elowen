import { describe, expect, it } from 'vitest';
import { CURSOR_MARKER, visibleWidth } from '@earendil-works/pi-tui';
import {
  formatDuration,
  padAnsi,
  terminalInlineText,
  terminalPhysicalRow,
  terminalPlainText,
  terminalSafeAnsi,
  terminalSafeComponent,
} from '../../../src/cli/ui/text.js';

describe('terminal text trust boundary', () => {
  it('returns an exact-width styled row byte-for-byte without ANSI truncation work', () => {
    const chunk = `\x1b[31m${'x'.repeat(20)}\x1b[0m${' '.repeat(20)}`;
    const styled = chunk.repeat(4);
    const row = `${styled}${'x'.repeat(180 - visibleWidth(styled))}`;
    expect(padAnsi(row, 180)).toBe(row);
    padAnsi(row, 180); // warm segmenter/JIT
    const startedAt = performance.now();
    for (let index = 0; index < 100; index++) padAnsi(row, 180);
    expect(performance.now() - startedAt).toBeLessThan(30);

    const overflow = padAnsi(`${row}unsafe-tail`, 180);
    expect(visibleWidth(overflow)).toBe(180);
    expect(overflow).not.toContain('unsafe-tail');
  });

  it('normalizes untrusted labels through one shared printable inline projection', () => {
    expect(terminalInlineText('  first\nsecond\t\x1b[2J third  ')).toBe('first second third');
  });

  it('keeps renderer-owned SGR, OSC 8 links, and the PI cursor marker only', () => {
    const input = [
      '\x1b[31mred\x1b[0m',
      '\x1b]8;;https://example.com\x07link\x1b]8;;\x07',
      CURSOR_MARKER,
      '\x1b[2Jclear',
      '\x1b]0;forged title\x07title',
      '\x1b]52;c;Zm9yZ2Vk\x07clipboard',
      '\x1bPdanger\x1b\\dcs',
      '\x1b_forged\x07apc',
    ].join(' ');

    const safe = terminalSafeAnsi(input);
    expect(safe).toContain('\x1b[31mred\x1b[0m');
    expect(safe).toContain('\x1b]8;;https://example.com\x07link\x1b]8;;\x07');
    expect(safe).toContain(CURSOR_MARKER);
    expect(safe).not.toContain('\x1b[2J');
    expect(safe).not.toContain('\x1b]0;');
    expect(safe).not.toContain('\x1b]52;');
    expect(safe).not.toContain('\x1bP');
    expect(safe).not.toContain('\x1b_forged');
    expect(terminalPlainText(safe).replace(/\s+/g, ' ')).toContain('red link clear title clipboard dcs apc');
  });

  it('keeps ANSI sanitization multiline while folding a final physical row boundary', () => {
    expect(terminalSafeAnsi('first\nsecond')).toBe('first\nsecond');
    expect(terminalPhysicalRow('first\r\nsecond\nthird\rfourth')).toBe('first second third fourth');
  });

  it('preserves owned ANSI and the cursor marker while folding an embedded physical newline', () => {
    const source = {
      invalidate: () => {},
      render: () => [`\x1b[31mleft${CURSOR_MARKER}\nright\x1b[0m`],
    };
    const [row] = terminalSafeComponent(source).render(80);

    expect(row).toBe(`\x1b[31mleft${CURSOR_MARKER} right\x1b[0m`);
    expect(row).not.toMatch(/[\r\n]/);
  });

  it('projects overlay rows while preserving focus and input delegation', () => {
    let focused = false;
    let input = '';
    const source = {
      get focused() { return focused; },
      set focused(value: boolean) { focused = value; },
      invalidate: () => {},
      handleInput: (value: string) => { input = value; },
      render: () => ['hostile session\x1b]52;c;Zm9yZ2Vk\x07\x1b[2J\nforged physical row'],
    };
    const safe = terminalSafeComponent(source) as typeof source;
    safe.focused = true;
    safe.handleInput('enter');
    const rendered = safe.render(80).join('\n');
    expect(focused).toBe(true);
    expect(input).toBe('enter');
    expect(rendered).toContain('hostile session');
    expect(rendered).not.toContain('\x1b]52;');
    expect(rendered).not.toContain('\x1b[2J');
    expect(rendered).not.toMatch(/[\r\n]/);
    expect(rendered).toContain('hostile session forged physical row');
  });
});

describe('formatDuration', () => {
  it('shows bare seconds under a minute', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(8)).toBe('8s');
    expect(formatDuration(59)).toBe('59s');
  });

  it('rolls seconds into minutes at 60s', () => {
    expect(formatDuration(60)).toBe('1m 0s');
    expect(formatDuration(61)).toBe('1m 1s');
    expect(formatDuration(72 * 60)).toBe('1h 12m'); // never '72m 0s'
  });

  it('rolls minutes into hours at 3600s and drops now-noise seconds', () => {
    expect(formatDuration(59 * 60 + 59)).toBe('59m 59s');
    expect(formatDuration(3600)).toBe('1h 0m');
    expect(formatDuration(3600 + 59)).toBe('1h 0m'); // sub-minute tail dropped past an hour
    expect(formatDuration(3660)).toBe('1h 1m');
  });

  it('never overflows a unit that should have rolled over', () => {
    expect(formatDuration(90)).toBe('1m 30s'); // not '90s'
    expect(formatDuration(90 * 60)).toBe('1h 30m'); // not '90m 0s'
  });

  it('does not model days: past a day it stays a bare hour count', () => {
    expect(formatDuration(26 * 3600)).toBe('26h 0m');
  });

  it('clamps fractional and negative input', () => {
    expect(formatDuration(0.4)).toBe('0s');
    expect(formatDuration(59.6)).toBe('1m 0s'); // rounds to 60
    expect(formatDuration(-5)).toBe('0s');
    expect(formatDuration(Number.NEGATIVE_INFINITY)).toBe('0s');
  });

  it('stays within 7 visible chars for every value below 100h', () => {
    for (const s of [0, 9, 59, 60, 599, 3599, 3600, 99 * 3600 + 59 * 60]) {
      expect(visibleWidth(formatDuration(s))).toBeLessThanOrEqual(7);
    }
  });
});
