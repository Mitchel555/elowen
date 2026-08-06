import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  storeChatImages, readChatImage, parseStoredChatImages, sweepChatImages,
  toMessageImages, stripAttachmentMarker, attachmentMarker, externalizeImageBlocks, collectImageFiles,
} from '../../src/brain/chatImages.js';

// A chat attachment has to outlive its turn: the base64 exists only while the turn runs, so unless the
// bytes are written to disk and the message keeps a reference, the bubble is empty after a reload.

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chat-images-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('storeChatImages', () => {
  it('writes the decoded bytes and hands back a reference that reads them back', () => {
    const [ref] = storeChatImages(dir, [{ data: PNG.toString('base64'), mimeType: 'image/png' }]);
    expect(ref.mimeType).toBe('image/png');
    expect(readFileSync(join(dir, ref.file))).toEqual(PNG);
    expect(readChatImage(dir, ref.file)?.body).toEqual(PNG);
  });

  it('skips a type the send schema would never admit rather than guessing an extension', () => {
    expect(storeChatImages(dir, [{ data: PNG.toString('base64'), mimeType: 'image/svg+xml' }])).toEqual([]);
  });

  it('gives every attachment its own name, so two identical pastes stay two files', () => {
    const stored = storeChatImages(dir, [
      { data: PNG.toString('base64'), mimeType: 'image/png' },
      { data: PNG.toString('base64'), mimeType: 'image/png' },
    ]);
    expect(new Set(stored.map((s) => s.file)).size).toBe(2);
  });
});

// A tool's image is the other direction: a browser screenshot arrives as ~2 MB of base64 inside a tool
// result, and until now that base64 went into brain_messages verbatim — against the invariant the module
// states — where it inflated the row and was re-read on every rehydrate.
describe('externalizeImageBlocks', () => {
  const toolResult = (data: string) => ({
    role: 'toolResult', toolCallId: 't1', toolName: 'take_screenshot', isError: false,
    content: [{ type: 'text', text: 'Took a screenshot.' }, { type: 'image', data, mimeType: 'image/png' }],
  });

  it('moves the bytes to disk and leaves a reference the row can carry', () => {
    const stored = externalizeImageBlocks(toolResult(PNG.toString('base64')), dir);
    const blocks = stored.content as { type: string; ref?: { file: string; mimeType: string }; data?: string }[];

    expect(blocks[0]).toEqual({ type: 'text', text: 'Took a screenshot.' });
    expect(blocks[1]!.data).toBeUndefined();
    expect(readChatImage(dir, blocks[1]!.ref!.file)?.body).toEqual(PNG);
    // The whole point: what gets serialised into the row no longer contains the base64.
    expect(JSON.stringify(stored)).not.toContain(PNG.toString('base64'));
  });

  it('names the file after its content, so persisting the same turn twice writes one file', () => {
    // A turn is stored twice — pending rows as each message lands, then again from agent_end once the run
    // order is known. Under a random name the second pass would strand an orphan on every screenshot.
    const first = externalizeImageBlocks(toolResult(PNG.toString('base64')), dir);
    const second = externalizeImageBlocks(toolResult(PNG.toString('base64')), dir);
    const fileOf = (m: typeof first) => (m.content as { ref?: { file: string } }[])[1]!.ref!.file;

    expect(fileOf(second)).toBe(fileOf(first));
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('keeps the message untouched when there is nothing to move', () => {
    const plain = { role: 'toolResult', content: [{ type: 'text', text: 'no images here' }] };
    expect(externalizeImageBlocks(plain, dir)).toBe(plain); // same object, not a copy
    expect(existsSync(dir) ? readdirSync(dir) : []).toHaveLength(0);
  });

  it('keeps the bytes inline rather than losing an image it cannot store', () => {
    // An unservable type has nowhere to go. A fat row is recoverable; a dropped screenshot is not.
    const odd = toolResult(PNG.toString('base64'));
    (odd.content[1] as { mimeType: string }).mimeType = 'image/svg+xml';
    const stored = externalizeImageBlocks(odd, dir);
    expect((stored.content as { data?: string }[])[1]!.data).toBe(PNG.toString('base64'));
  });
});

// Ownership and the sweep both read through this one function: miss a shape in the sweep and live images
// get deleted, miss it in the ownership check and a private image 404s to the person who owns it.
describe('collectImageFiles', () => {
  it('finds every shape a row can reference an image by', () => {
    const [attachment] = storeChatImages(dir, [{ data: PNG.toString('base64'), mimeType: 'image/png' }]);
    const externalized = externalizeImageBlocks({
      role: 'toolResult', content: [{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }],
    }, dir);
    const toolFile = (externalized.content as { ref: { file: string } }[])[0]!.ref.file;

    expect(collectImageFiles({ role: 'user', images: [attachment] })).toEqual([attachment!.file]);
    expect(collectImageFiles(externalized)).toEqual([toolFile]);
    expect(collectImageFiles({ role: 'toolResult', details: { sharedImage: { file: toolFile, mimeType: 'image/png' } } }))
      .toEqual([toolFile]);
  });

  it('refuses a name that is not one we wrote, whatever the row claims', () => {
    // The names reach a filesystem read, so anything the shape of a path must not survive this.
    for (const file of ['../../etc/passwd', '/etc/passwd', 'not-a-uuid.png', 'a'.repeat(64) + '.exe']) {
      expect(collectImageFiles({ images: [{ file, mimeType: 'image/png' }] })).toEqual([]);
      expect(collectImageFiles({ content: [{ type: 'image', ref: { file, mimeType: 'image/png' } }] })).toEqual([]);
    }
  });

  it('reads nothing out of a row that is not an object', () => {
    for (const row of [null, 'text', 42, []]) expect(collectImageFiles(row)).toEqual([]);
  });
});

describe('readChatImage', () => {
  it('refuses anything that is not a name it minted itself', () => {
    writeFileSync(join(dir, 'secret.png'), PNG);
    for (const name of ['../../etc/passwd', 'secret.png', 'a/b.png', '', '9d4363fe.png']) {
      expect(readChatImage(dir, name)).toBeNull();
    }
  });

  it('reports a swept-away file as missing instead of throwing', () => {
    const [ref] = storeChatImages(dir, [{ data: PNG.toString('base64'), mimeType: 'image/png' }]);
    rmSync(join(dir, ref.file));
    expect(readChatImage(dir, ref.file)).toBeNull();
  });
});

describe('parseStoredChatImages', () => {
  it('accepts what storeChatImages produced', () => {
    const stored = storeChatImages(dir, [{ data: PNG.toString('base64'), mimeType: 'image/png' }]);
    expect(parseStoredChatImages(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  it('treats every other shape as no attachments, so one bad row cannot break a transcript', () => {
    for (const value of [undefined, null, 'x', {}, [null], [{ file: 1 }], [{ file: '../x.png', mimeType: 'image/png' }]]) {
      expect(parseStoredChatImages(value)).toEqual([]);
    }
  });
});

describe('sweepChatImages', () => {
  const age = (path: string, ms: number) => {
    const when = (Date.now() - ms) / 1000;
    utimesSync(path, when, when);
  };

  it('removes a file no message references any more', () => {
    const [ref] = storeChatImages(dir, [{ data: PNG.toString('base64'), mimeType: 'image/png' }]);
    age(join(dir, ref.file), 7_200_000);
    expect(sweepChatImages(dir, new Set(), 3_600_000)).toBe(1);
    expect(existsSync(join(dir, ref.file))).toBe(false);
  });

  it('keeps a referenced file however old it is', () => {
    const [ref] = storeChatImages(dir, [{ data: PNG.toString('base64'), mimeType: 'image/png' }]);
    age(join(dir, ref.file), 400 * 86_400_000);
    expect(sweepChatImages(dir, new Set([ref.file]), 3_600_000)).toBe(0);
    expect(existsSync(join(dir, ref.file))).toBe(true);
  });

  it('keeps a just-written file, because its message row may not be committed yet', () => {
    const [ref] = storeChatImages(dir, [{ data: PNG.toString('base64'), mimeType: 'image/png' }]);
    expect(sweepChatImages(dir, new Set(), 3_600_000)).toBe(0);
    expect(existsSync(join(dir, ref.file))).toBe(true);
  });

  it('never touches a file it did not mint, even when unreferenced and old', () => {
    const foreign = join(dir, 'notes.txt');
    writeFileSync(foreign, 'keep me');
    age(foreign, 7_200_000);
    expect(sweepChatImages(dir, new Set(), 3_600_000)).toBe(0);
    expect(existsSync(foreign)).toBe(true);
  });

  it('is a no-op before anything has ever been attached', () => {
    expect(sweepChatImages(join(dir, 'nope'), new Set(), 3_600_000)).toBe(0);
  });
});

describe('the attachment marker', () => {
  it('is stripped from the view when the files are there to render instead', () => {
    expect(stripAttachmentMarker(`Podívej se na tohle${attachmentMarker(2)}`)).toBe('Podívej se na tohle');
  });

  it('leaves prose that merely mentions the marker mid-text alone', () => {
    const text = `co znamená [📎 1× image] v logu?`;
    expect(stripAttachmentMarker(text)).toBe(text);
  });

  it('turns a reference into the path a browser loads', () => {
    expect(toMessageImages([{ file: 'a.png', mimeType: 'image/png' }]))
      .toEqual([{ url: '/brain/chat-images/a.png', mimeType: 'image/png' }]);
  });
});

describe('the directory is created on demand', () => {
  it('writes into a dir that does not exist yet', () => {
    const nested = join(dir, 'deep', 'chat-images');
    mkdirSync(join(dir, 'deep'));
    const [ref] = storeChatImages(nested, [{ data: PNG.toString('base64'), mimeType: 'image/png' }]);
    expect(existsSync(join(nested, ref.file))).toBe(true);
  });
});
