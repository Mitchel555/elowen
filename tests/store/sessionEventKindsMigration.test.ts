import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openDb } from '../../src/store/db.js';
import { SESSION_EVENT_KINDS } from '../../src/store/brainStore.js';

/** tests/contract/sessionEventKinds.test.ts pins SESSION_EVENT_KINDS against a FRESH schema.sql, but an
 *  existing database is upgraded by the hand-written table rebuild in src/store/db.ts (widenSessionEventKinds),
 *  which carries its own CHECK list independent of schema.sql. A kind added to SESSION_EVENT_KINDS without a
 *  matching edit to that rebuild would pass the fresh-schema parity test and CI, work on a fresh install, and
 *  still reject the new event on every upgraded production database — the exact failure that forced the
 *  original 'cwd' migration. This test drives the real upgrade path (a legacy DB, not a fresh one) with the
 *  CURRENT SESSION_EVENT_KINDS list, so a future kind added to one side without the other fails here too. */
let dir: string | null = null;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

/** A database as it stood before the v5 rebuild: the real schema, but `brain_session_events` still
 *  carrying the pre-'cwd' CHECK, and user_version parked so only v5 (and later) are armed. Built through
 *  openDb + a hand rebuild (like tests/store/db.test.ts's own pre-v5 fixture) rather than a fully
 *  hand-written schema, so it stays honest about everything except the one table under test. */
function seedLegacyDb(): string {
  dir = mkdtempSync(join(tmpdir(), 'elowen-db-session-event-migration-'));
  const path = join(dir, 'legacy.db');
  const db = openDb(path);
  db.exec('DROP TABLE brain_session_events');
  db.exec(`CREATE TABLE brain_session_events (
    session_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('model', 'mode', 'rename', 'reasoning')),
    detail TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (session_id, event_id)
  )`);
  db.pragma('user_version = 4');
  db.close();
  return path;
}

describe('openDb upgrade path accepts every current SESSION_EVENT_KINDS value', () => {
  it('a legacy database migrated by openDb permits every SESSION_EVENT_KINDS value, not just a fresh schema', () => {
    const db = openDb(seedLegacyDb());
    try {
      for (const kind of SESSION_EVENT_KINDS) {
        expect(() => db.prepare(
          "INSERT INTO brain_session_events (session_id, event_id, kind, detail) VALUES ('s1', ?, ?, 'x')",
        ).run(`evt-${kind}`, kind)).not.toThrow();
      }
      const stored = (db.prepare('SELECT kind FROM brain_session_events ORDER BY event_id').all() as { kind: string }[])
        .map((r) => r.kind);
      expect(stored.sort()).toEqual([...SESSION_EVENT_KINDS].sort());
    } finally {
      db.close();
    }
  });

  it('the migrated CHECK still rejects a kind SESSION_EVENT_KINDS does not define', () => {
    const db = openDb(seedLegacyDb());
    try {
      expect(() => db.prepare(
        "INSERT INTO brain_session_events (session_id, event_id, kind, detail) VALUES ('s1', 'e-bad', 'not-a-real-kind', 'x')",
      ).run()).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });
});

/** Sanity check the fixture itself: without the migration, the legacy schema truly does reject a value
 *  SESSION_EVENT_KINDS now defines — otherwise the tests above would pass for the wrong reason (the old
 *  CHECK happening to already be permissive) rather than because openDb's rebuild widened it. */
describe('sanity: the legacy fixture is a genuine pre-widen CHECK', () => {
  it('rejects a current SESSION_EVENT_KINDS value before openDb runs', () => {
    dir = mkdtempSync(join(tmpdir(), 'elowen-db-session-event-migration-sanity-'));
    const path = join(dir, 'raw.db');
    const raw = new Database(path);
    raw.exec(`CREATE TABLE brain_session_events (
      session_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('model', 'mode', 'rename', 'reasoning')),
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, event_id)
    )`);
    const missing = SESSION_EVENT_KINDS.filter((k) => !(['model', 'mode', 'rename', 'reasoning'] as readonly string[]).includes(k));
    expect(missing.length).toBeGreaterThan(0); // the fixture must actually be missing something to prove
    for (const kind of missing) {
      expect(() => raw.prepare(
        "INSERT INTO brain_session_events (session_id, event_id, kind, detail) VALUES ('s1', ?, ?, 'x')",
      ).run(`evt-${kind}`, kind)).toThrow(/CHECK/i);
    }
    raw.close();
  });
});
