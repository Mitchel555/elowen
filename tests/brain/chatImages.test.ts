import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  storeChatImages, readChatImage, parseStoredChatImages, sweepChatImages,
  toMessageImages, stripAttachmentMarker, attachmentMarker,
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
