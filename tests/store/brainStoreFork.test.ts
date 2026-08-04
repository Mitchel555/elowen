import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';

/** Forking a conversation: a PEER session seeded with a copy of the source's transcript. */
describe('BrainStore.forkSession', () => {
  let store: BrainStore;
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    store = new BrainStore(db);
    store.createSession({ id: 'src', userId: 7, title: 'Katalog dílů', model: 'anthropic/claude', provider: 'entry-1' });
    store.touchSession('src', 'anthropic/claude', 'entry-1');
    db.prepare("UPDATE brain_sessions SET work_dir = '/w/proj' WHERE id = 'src'").run();
    store.appendMessage({ id: 'm1', sessionId: 'src', parentId: null, role: 'user', content: 'první otázka' });
    store.appendMessage({ id: 'm2', sessionId: 'src', parentId: 'm1', role: 'assistant', content: 'první odpověď' });
    store.appendMessage({ id: 'm3', sessionId: 'src', parentId: 'm2', role: 'user', content: 'druhá otázka' });
  });

  it('copies every message in transcript order under fresh ids', () => {
    const fork = store.forkSession('src', 'fork');

    const copied = store.getMessages('fork');
    expect(copied.map((m) => [m.role, JSON.parse(m.content)])).toEqual(
      store.getMessages('src').map((m) => [m.role, JSON.parse(m.content)]),
    );
    // Fresh ids, all belonging to the fork — the id is the table's primary key, so a verbatim copy is
    // impossible; `parent_id` would only point at the SOURCE's rows and nothing reads it.
    expect(copied.map((m) => m.id)).not.toContain('m1');
    expect(new Set(copied.map((m) => m.id)).size).toBe(3);
    expect(copied.every((m) => m.session_id === 'fork' && m.parent_id === null)).toBe(true);
    expect(fork.id).toBe('fork');
  });

  it('is independent: writing to one conversation never touches the other', () => {
    store.forkSession('src', 'fork');

    store.appendMessage({ id: 'f1', sessionId: 'fork', parentId: null, role: 'user', content: 'jiný směr' });
    store.appendMessage({ id: 's1', sessionId: 'src', parentId: null, role: 'user', content: 'původní směr' });
    store.deleteMessage('fork', store.getMessages('fork')[0]!.id);

    const srcTexts = store.getMessages('src').map((m) => JSON.parse(m.content) as string);
    const forkTexts = store.getMessages('fork').map((m) => JSON.parse(m.content) as string);
    expect(srcTexts).toEqual(['první otázka', 'první odpověď', 'druhá otázka', 'původní směr']);
    expect(forkTexts).toEqual(['první odpověď', 'druhá otázka', 'jiný směr']);
  });

  it('carries what the fork needs to resume and records the origin as a peer, not a delegated child', () => {
    const fork = store.forkSession('src', 'fork');

    expect(fork.user_id).toBe(7);
    expect(fork.title).toBe('Katalog dílů');
    expect(fork.model).toBe('anthropic/claude');
    expect(fork.provider).toBe('entry-1');
    expect(fork.work_dir).toBe('/w/proj');
    expect(fork.forked_from_session_id).toBe('src');
    // The delegation columns stay clear: a fork must never read as a running sub-agent to the usage
    // roll-up, the retention janitor, the sub-agent listing or the eviction guard.
    expect(fork.parent_session_id).toBeNull();
    expect(fork.delegated_access).toBeNull();
    expect(store.staleConversationIds(7, 1)).not.toContain('fork'); // still eligible for retention
  });

  it('starts with a clean slate for sidecar state', () => {
    store.upsertCard('src', { id: 'todo', title: 'Úkoly' });
    store.upsertGoal({ sessionId: 'src', userId: 7, goal: 'dokončit katalog' });
    store.appendSessionEvent('src', 'model', 'anthropic/claude');
    store.createSession({ id: 'brain-ch-subagent-sub1', userId: 7, model: 'm', parentSessionId: 'src' });
    store.upsertSubagentRun('src', { id: 't1', sessionId: 'brain-ch-subagent-sub1', status: 'running', task: 'hledej', tools: 0, seconds: 1 });

    store.forkSession('src', 'fork');

    expect(store.getCards('fork')).toEqual([]);
    expect(store.getGoal('fork')).toBeUndefined();
    expect(store.getSessionEvents('fork')).toEqual([]);
    // The running sub-agent stays the SOURCE's: two conversations must never both claim one child.
    expect(store.getSubagentRuns('fork')).toEqual([]);
    expect(store.getSubagentRuns('src')).toHaveLength(1);
    expect(store.getCards('src')).toHaveLength(1);
    expect(store.getSessionEvents('src')).toHaveLength(1);
  });

  it('rolls the whole copy back when a message insert fails — no orphaned session row', () => {
    // A trigger that aborts the message copy is the only way to fail HALFWAY: the session row is already
    // in, so anything left behind would be an empty conversation in the user's picker.
    db.exec(`CREATE TRIGGER fork_boom BEFORE INSERT ON brain_messages
             WHEN NEW.session_id = 'fork' BEGIN SELECT RAISE(ABORT, 'boom'); END`);

    expect(() => store.forkSession('src', 'fork')).toThrow(/boom/);
    expect(store.getSession('fork')).toBeUndefined();
    expect(store.getMessages('fork')).toEqual([]);
    expect(store.getMessages('src')).toHaveLength(3);
  });

  it('refuses to fork a session that does not exist', () => {
    expect(() => store.forkSession('nope', 'fork')).toThrow(/not found/);
    expect(store.getSession('fork')).toBeUndefined();
  });
});
