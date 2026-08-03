import { describe, it, expect } from 'vitest';
import { MEMORY_STALE_AFTER_DAYS, memoryAgeDays, memoryStalenessNote } from '../../src/brain/memoryStaleness.js';

const NOW = Date.parse('2026-08-03T04:00:00Z');
const daysAgo = (d: number): string => new Date(NOW - d * 86_400_000).toISOString();

describe('memoryAgeDays', () => {
  it('computes whole days from a SQLite space-form UTC timestamp', () => {
    // SQLite's datetime('now') emits this zone-less form; it must be read as UTC, not local time.
    expect(memoryAgeDays('2026-07-04 04:00:00', NOW)).toBe(30);
    expect(memoryAgeDays('2026-08-02 05:00:00', NOW)).toBe(0);
  });

  it('treats a missing, unparseable or future timestamp as unknown age', () => {
    expect(memoryAgeDays(undefined, NOW)).toBeNull();
    expect(memoryAgeDays(null, NOW)).toBeNull();
    expect(memoryAgeDays('', NOW)).toBeNull();
    expect(memoryAgeDays('not a date', NOW)).toBeNull();
    expect(memoryAgeDays(daysAgo(-2), NOW)).toBeNull();
  });
});

describe('memoryStalenessNote', () => {
  it('stays silent below the threshold and warns at it', () => {
    expect(memoryStalenessNote(MEMORY_STALE_AFTER_DAYS - 1)).toBe('');
    expect(memoryStalenessNote(null)).toBe('');
    const note = memoryStalenessNote(MEMORY_STALE_AFTER_DAYS);
    expect(note).toContain(`${MEMORY_STALE_AFTER_DAYS} days ago`);
    expect(note).toContain('point-in-time observation');
  });

  it('names the actual age so an ancient memory reads as ancient', () => {
    expect(memoryStalenessNote(120)).toContain('120 days ago');
  });
});
