import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { shapeBrainMessages } from '../../src/brain/messageView.js';
import {
  createSessionPersistenceProjector, projectEvent, projectUserTurn, rehydrate,
} from '../../src/brain/persistence.js';
import { HISTORY_IMAGE_PLACEHOLDER } from '../../src/brain/session/historyImageStripping.js';
import { readChatImage, storeChatImages, attachmentMarker, sweepChatImages } from '../../src/brain/chatImages.js';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';

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

/** Big enough that its base64 is unmistakable in a row, and PNG-headed like the real thing. */
const SCREENSHOT = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(1024, 0x2a)]);
const OTHER_SCREENSHOT = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(1024, 0x5b)]);
const base64 = (bytes: Buffer): string => bytes.toString('base64');

const assistantCalling = (callId: string) => ({
  role: 'assistant', content: [{ type: 'toolCall', id: callId, name: 'take_screenshot', arguments: {} }],
});
/** What a browser tool hands back: a line of text and ~megabytes of base64 next to it. */
const screenshotResult = (callId: string, bytes: Buffer) => ({
  role: 'toolResult', toolCallId: callId, toolName: 'take_screenshot', isError: false,
  content: [{ type: 'text', text: 'Took a screenshot.' }, { type: 'image', data: base64(bytes), mimeType: 'image/png' }],
});

/** One settled turn that produced a screenshot, persisted the way the daemon persists it. */
function screenshotTurn(sessionId: string, callId: string, bytes: Buffer, imagesDir?: string): void {
  projectUserTurn(store, sessionId, 'udělej screenshot');
  projectEvent(store, sessionId, {
    type: 'agent_end', willRetry: false,
    messages: [{ role: 'user', content: '<ephemeral framing>udělej screenshot' }, assistantCalling(callId), screenshotResult(callId, bytes)],
  } as never, imagesDir);
}

/** The stored toolResult row's image reference, read back the way every consumer reads it. */
function storedRefFile(sessionId: string): string {
  const row = store.getMessages(sessionId).filter((r) => r.role === 'toolResult').at(-1);
  const content = (JSON.parse(row!.content) as { content?: unknown }).content;
  for (const part of Array.isArray(content) ? content : []) {
    const ref = (part as { type?: unknown; ref?: { file?: unknown } }).ref;
    if (typeof ref?.file === 'string') return ref.file;
  }
  throw new Error('the stored toolResult row carries no image reference');
}

const rawRow = (id: string, sessionId: string, role: string, content: unknown): void => {
  db.prepare('INSERT INTO brain_messages (id, session_id, parent_id, role, content) VALUES (?, ?, NULL, ?, ?)')
    .run(id, sessionId, role, typeof content === 'string' ? content : JSON.stringify(content));
};

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

  it('reports a tool image whose bytes were moved to disk, which is the only thing keeping it alive', () => {
    // The sweep deletes what this does NOT return. A screenshot lives on a toolResult row under `ref`, a
    // shape the user-attachment scan never sees — missing it here silently deletes a live picture.
    const [attachment] = sendWithImage('a k tomu screenshot');
    screenshotTurn('brain-1', 'call-1', SCREENSHOT, dir);
    expect(store.referencedChatImages()).toEqual(new Set([attachment, storedRefFile('brain-1')]));
  });

  it('stops referencing a tool image once its message is gone, and the file then goes', () => {
    screenshotTurn('brain-1', 'call-1', SCREENSHOT, dir);
    const file = storedRefFile('brain-1');
    for (const row of store.getMessages('brain-1')) store.deleteMessage('brain-1', row.id);
    expect(store.referencedChatImages().has(file)).toBe(false);
    // Explicit `now` a second ahead: Date.now() is whole ms while mtimeMs carries a fraction, so a zero
    // grace window can come out NEGATIVE and skip the file — a real flake, not a hypothetical one.
    expect(sweepChatImages(dir, store.referencedChatImages(), 0, Date.now() + 1000)).toBe(1);
  });

  it('stops referencing an attachment once its message is deleted, and the file then goes', () => {
    const [file] = sendWithImage('zahoď mě');
    const [row] = store.getMessages('brain-1');
    store.deleteMessage('brain-1', row.id);
    expect(store.referencedChatImages().has(file)).toBe(false);
    // Explicit `now` a second ahead: Date.now() is whole ms while mtimeMs carries a fraction, so a zero
    // grace window can come out NEGATIVE and skip the file — a real flake, not a hypothetical one.
    expect(sweepChatImages(dir, store.referencedChatImages(), 0, Date.now() + 1000)).toBe(1);
  });

  it('does not confuse an assistant row that merely mentions the word', () => {
    store.appendMessage({
      id: 'a1', sessionId: 'brain-1', parentId: null, role: 'assistant',
      content: { role: 'assistant', content: [{ type: 'text', text: 'the "images" field is parsed here' }] },
    });
    expect(store.referencedChatImages().size).toBe(0);
  });
});

// The other direction: an image a TOOL produced. A single browser screenshot used to put ~2 MB of base64
// into brain_messages verbatim, where it stayed forever — re-read on every rehydrate, inflating the row,
// and breaking the invariant chatImages.ts states about that table.
describe('a tool screenshot is stored as a reference, never as base64', () => {
  it('keeps the bytes out of the row and puts them on disk instead', () => {
    screenshotTurn('brain-1', 'call-1', SCREENSHOT, dir);
    const row = store.getMessages('brain-1').filter((r) => r.role === 'toolResult').at(-1)!;

    expect(row.content).not.toContain(base64(SCREENSHOT));
    const file = storedRefFile('brain-1');
    expect(row.content).toContain(file);
    expect(readChatImage(dir, file)?.body).toEqual(SCREENSHOT);
  });

  it('keeps the text the tool wrote next to the image', () => {
    screenshotTurn('brain-1', 'call-1', SCREENSHOT, dir);
    const row = store.getMessages('brain-1').filter((r) => r.role === 'toolResult').at(-1)!;
    expect(row.content).toContain('Took a screenshot.');
  });

  it('leaves the bytes inline when no directory is configured, exactly as before', () => {
    // An in-memory store has nowhere to put files. The turn must still persist in full.
    screenshotTurn('brain-1', 'call-1', SCREENSHOT);
    const row = store.getMessages('brain-1').filter((r) => r.role === 'toolResult').at(-1)!;
    expect(row.content).toContain(base64(SCREENSHOT));
    expect(readdirSync(dir)).toHaveLength(0);
  });

  // A turn reaches the store twice: as pending rows the moment each message lands, then again from
  // agent_end once the real run order is known. A per-write random name would strand an orphan file on
  // every single screenshot, so the second write has to land on the first one's file.
  it('writes ONE file even though the turn is persisted twice', () => {
    const project = createSessionPersistenceProjector(store, { messages: [] } as unknown as AgentSession, 'brain-1', 200_000, dir);
    projectUserTurn(store, 'brain-1', 'udělej screenshot');
    const call = assistantCalling('call-1');
    const result = screenshotResult('call-1', SCREENSHOT);

    project({ type: 'message_end', message: call } as unknown as AgentSessionEvent);
    project({ type: 'message_end', message: result } as unknown as AgentSessionEvent);
    expect(store.pendingMessages('brain-1')).toHaveLength(2);
    expect(readdirSync(dir)).toHaveLength(1);

    project({
      type: 'agent_end', willRetry: false,
      messages: [{ role: 'user', content: '<ephemeral framing>udělej screenshot' }, call, result],
    } as unknown as AgentSessionEvent);

    expect(readdirSync(dir)).toEqual([storedRefFile('brain-1')]);
    expect(store.getMessages('brain-1').map((r) => r.role)).toEqual(['user', 'assistant', 'toolResult']);
  });
});

// What a respawn (restart, model switch, LRU revival) hands back to the provider.
describe('a rehydrated screenshot row', () => {
  const contentOfToolResult = (): unknown => {
    const messages = rehydrate(store, 'brain-1', process.cwd()).buildSessionContext().messages as { role: string; content: unknown }[];
    return messages.find((m) => m.role === 'toolResult')?.content;
  };

  it('comes back as the placeholder — not as bytes, and not as an empty message', () => {
    screenshotTurn('brain-1', 'call-1', SCREENSHOT, dir);
    const content = contentOfToolResult() as { type: string; text?: string }[];

    expect(content.map((block) => block.type)).toEqual(['text', 'text']);
    expect(content[1]!.text).toBe(HISTORY_IMAGE_PLACEHOLDER);
    expect(content[0]!.text).toBe('Took a screenshot.');
    // The file is deliberately NOT read back: a replayed prefix must not depend on it still being there.
    expect(JSON.stringify(content)).not.toContain(base64(SCREENSHOT));
    expect(JSON.stringify(content)).not.toContain(storedRefFile('brain-1'));
  });

  it('still replays a pre-existing row that carries its bytes inline', () => {
    // Rows an older build wrote keep their base64, and must keep working exactly as they did.
    rawRow('old-call', 'brain-1', 'assistant', assistantCalling('old-1'));
    rawRow('old-result', 'brain-1', 'toolResult', screenshotResult('old-1', SCREENSHOT));

    const content = contentOfToolResult() as { type: string; data?: string; mimeType?: string }[];
    expect(content.map((block) => block.type)).toEqual(['text', 'image']);
    expect(content[1]!.data).toBe(base64(SCREENSHOT));
    expect(content[1]!.mimeType).toBe('image/png');
  });
});

// `ShareImage({latest})` reads this to find the screenshot the agent took seconds ago, so it answers from
// the store rather than from live state — that is what makes it survive a restart.
describe('latestToolImage', () => {
  it('has nothing to offer before any tool produced an image', () => {
    projectUserTurn(store, 'brain-1', 'jen si povídáme');
    expect(store.latestToolImage('brain-1')).toBeUndefined();
  });

  it('returns the newest one when a conversation has several', () => {
    screenshotTurn('brain-1', 'call-1', SCREENSHOT, dir);
    const first = storedRefFile('brain-1');
    screenshotTurn('brain-1', 'call-2', OTHER_SCREENSHOT, dir);
    const second = storedRefFile('brain-1');

    expect(second).not.toBe(first);
    expect(store.latestToolImage('brain-1')).toEqual({ file: second, mimeType: 'image/png' });
  });

  it('never reaches into another conversation', () => {
    store.createSession({ id: 'brain-2', userId: 2, model: 'm' });
    screenshotTurn('brain-2', 'call-1', SCREENSHOT, dir);
    projectUserTurn(store, 'brain-1', 'a co ty?');
    expect(store.latestToolImage('brain-1')).toBeUndefined();
  });

  it('skips a corrupt row instead of giving up on the healthy ones behind it', () => {
    screenshotTurn('brain-1', 'call-1', SCREENSHOT, dir);
    const file = storedRefFile('brain-1');
    rawRow('corrupt', 'brain-1', 'toolResult', '{"role":"toolResult","content":[{"type":"image","ref":');
    expect(store.latestToolImage('brain-1')).toEqual({ file, mimeType: 'image/png' });
  });
});

describe('a tool image is as private as the conversation it was taken in', () => {
  it('is readable by the owner of the conversation whose tool produced it', () => {
    screenshotTurn('brain-1', 'call-1', SCREENSHOT, dir);
    expect(store.chatImageBelongsTo(1, storedRefFile('brain-1'))).toBe(true);
  });

  it('is NOT readable by another account that knows the name', () => {
    screenshotTurn('brain-1', 'call-1', SCREENSHOT, dir);
    store.createSession({ id: 'brain-2', userId: 2, model: 'm' });
    expect(store.chatImageBelongsTo(2, storedRefFile('brain-1'))).toBe(false);
  });
});
