import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { newestTurnStart } from '../../src/brain/messageView.js';

// The turn boundary — "the newest turn is everything after the last user row" — exists twice on purpose:
// as SQL in BrainStore.getLatestTurn (rowid > MAX(rowid) over role='user', so the hot poll never loads
// the whole history) and as the TS scan newestTurnStart (the canonical definition consumers import).
// They cannot share code, so this test is what keeps them from drifting: a change to either side that
// the other does not follow cuts a different boundary and fails here.
describe('turn boundary: SQL getLatestTurn vs TS newestTurnStart', () => {
  let db: ReturnType<typeof openDb>;
  let store: BrainStore;
  beforeEach(() => {
    db = openDb(':memory:');
    store = new BrainStore(db);
    store.createSession({ id: 's', userId: 1, model: 'm' });
  });

  // Covers the realistic shapes: empty, user-less, single turn, mid-turn steer, and a trailing user row
  // (the pre-projected prompt of an in-flight turn, which persistAgentRun reorders at agent_end).
  const sequences = [
    [],
    ['assistant'],
    ['assistant', 'toolResult'],
    ['user'],
    ['user', 'assistant'],
    ['user', 'assistant', 'toolResult'],
    ['user', 'assistant', 'user', 'assistant'],
    ['assistant', 'user', 'assistant', 'toolResult', 'assistant'],
    ['user', 'user', 'assistant', 'user'],
    ['user', 'assistant', 'user'],
  ];

  for (const sequence of sequences) {
    it(`agrees on [${sequence.join(', ')}]`, () => {
      const ids = sequence.map((role, i) => {
        const id = `m${i}`;
        store.appendMessage({ id, sessionId: 's', parentId: null, role, content: { text: role } });
        return id;
      });
      const stored = store.getMessages('s');
      expect(store.getLatestTurn('s').map((row) => row.id))
        .toEqual(ids.slice(newestTurnStart(stored)));
    });
  }
});
