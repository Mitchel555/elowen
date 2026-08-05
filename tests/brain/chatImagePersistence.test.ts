import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { shapeBrainMessages } from '../../src/brain/messageView.js';
import { projectUserTurn } from '../../src/brain/persistence.js';
import { storeChatImages, attachmentMarker, sweepChatImages } from '../../src/brain/chatImages.js';

// The reload path. A turn's base64 lives only as long as the turn, so what a user sees after F5 comes
// entirely from the store: the row has to carry a reference, and the view has to turn it back into
// something a browser can load. This is the round trip, end to end.

const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');

let dir: string;
let db: ReturnType<typeof openDb>;
let store: BrainStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chat-persist-'));
  db = openDb(':memory:');
  store = new BrainStore(db);
  store.createSession({ id: 'brain-1', userId: 1, model: 'm' });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** What the daemon does on admission: write the files, then project the row that references them. */
function sendWithImage(text: string, count = 1): string[] {
  const stored = storeChatImages(dir, Array.from({ length: count }, () => ({ data: PNG, mimeType: 'image/png' })));
  projectUserTurn(store, 'brain-1', text + attachmentMarker(count), stored);
  return stored.map((s) => s.file);
}

describe('an attachment survives a reload', () => {
  it('comes back as a loadable url on the user row', () => {
    const [file] = sendWithImage('mrkni na tohle');
    const [view] = shapeBrainMessages(store.getMessages('brain-1'));
    expect(view.role).toBe('user');
    expect(view.images).toEqual([{ url: `/brain/chat-images/${file}`, mimeType: 'image/png' }]);
  });

  it('drops the marker from the view, since the client draws the image instead', () => {
    sendWithImage('mrkni na tohle');
    const [view] = shapeBrainMessages(store.getMessages('brain-1'));
    expect(view.text).toBe('mrkni na tohle');
  });

  it('keeps the marker in the STORED text — it is the model\'s only trace once the bytes are gone', () => {
    sendWithImage('mrkni na tohle');
    expect(store.getMessages('brain-1')[0].content).toContain('📎');
  });

  it('keeps a bubble that was nothing but an image', () => {
    sendWithImage('');
    const [view] = shapeBrainMessages(store.getMessages('brain-1'));
    expect(view).toBeDefined();
    expect(view.images).toHaveLength(1);
  });

  it('carries every attachment of a multi-image turn', () => {
    const files = sendWithImage('tři najednou', 3);
    const [view] = shapeBrainMessages(store.getMessages('brain-1'));
    expect(view.images?.map((i) => i.url)).toEqual(files.map((f) => `/brain/chat-images/${f}`));
  });

  it('leaves a message without attachments exactly as it was', () => {
    projectUserTurn(store, 'brain-1', 'jen text');
    const [view] = shapeBrainMessages(store.getMessages('brain-1'));
    expect(view.text).toBe('jen text');
    expect(view.images).toBeUndefined();
  });
});

describe('an attachment is as private as its conversation', () => {
  it('is readable by the owner of the message that references it', () => {
    const [file] = sendWithImage('moje faktura');
    expect(store.chatImageBelongsTo(1, file)).toBe(true);
  });

  it('is NOT readable by another account that knows the name', () => {
    const [file] = sendWithImage('moje faktura');
    store.createSession({ id: 'brain-2', userId: 2, model: 'm' });
    expect(store.chatImageBelongsTo(2, file)).toBe(false);
  });

  it('is not granted by a message that merely quotes the name in its prose', () => {
    const [file] = sendWithImage('moje faktura');
    store.createSession({ id: 'brain-2', userId: 2, model: 'm' });
    projectUserTurn(store, 'brain-2', `podívej na /brain/chat-images/${file}`);
    expect(store.chatImageBelongsTo(2, file)).toBe(false);
  });

  it('refuses a name nobody ever stored', () => {
    expect(store.chatImageBelongsTo(1, '00000000-0000-4000-8000-000000000000.png')).toBe(false);
  });
});

describe('the sweep and the store agree on what is still in use', () => {
  it('reports a live attachment as referenced, so the sweep spares it', () => {
    const [file] = sendWithImage('drž si mě');
    expect(store.referencedChatImages()).toEqual(new Set([file]));
  });

  it('stops referencing an attachment once its message is deleted, and the file then goes', () => {
    const [file] = sendWithImage('zahoď mě');
    const [row] = store.getMessages('brain-1');
    store.deleteMessage('brain-1', row.id);
    expect(store.referencedChatImages().has(file)).toBe(false);
    expect(sweepChatImages(dir, store.referencedChatImages(), 0)).toBe(1);
  });

  it('does not confuse an assistant row that merely mentions the word', () => {
    store.appendMessage({
      id: 'a1', sessionId: 'brain-1', parentId: null, role: 'assistant',
      content: { role: 'assistant', content: [{ type: 'text', text: 'the "images" field is parsed here' }] },
    });
    expect(store.referencedChatImages().size).toBe(0);
  });
});
