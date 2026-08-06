import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildShareImageTool } from '../../src/brain/tools/shareImageTool.js';
import { externalizeImageBlocks, readChatImage } from '../../src/brain/chatImages.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import type { Policy } from '../../src/plugins/policy.js';

// ShareImage is the one path by which bytes the AGENT chose end up served from the app's own origin, to
// whoever opens the conversation. Every check here is about that: what it will read, how big, and whether
// the thing it serves as an image really is one.

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');
const SESSION = 'brain-1';

let home: string;
let images: string;
let repo: string;
let store: BrainStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'share-image-'));
  images = join(home, 'chat-images');
  repo = join(home, 'repo');
  mkdirSync(repo, { recursive: true });
  store = new BrainStore(openDb(':memory:'));
  store.createSession({ id: SESSION, userId: 1, model: 'm' });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** The turn scope the tool reads its session and path policy from. `allowedPaths` is the real boundary a
 *  scoped user gets; `repo` stands in for their one permitted project. */
function call(params: unknown, policy?: Policy): Promise<{ content: { text: string }[]; details?: { sharedImage?: { file: string; mimeType: string; caption?: string } } }> {
  const tool = buildShareImageTool({ store, imagesDir: images });
  return runWithPolicy(
    policy ?? { allowedProjectIds: 'all', allowedPaths: () => [repo] },
    () => tool.execute('call-1', params as never, undefined, undefined, {} as never) as never,
    { sessionId: SESSION },
  );
}

const write = (name: string, bytes: Buffer): string => {
  const path = join(repo, name);
  writeFileSync(path, bytes);
  return path;
};

describe('ShareImage from a file', () => {
  it('stores the file and reports it so the client can render it', async () => {
    const res = await call({ path: write('shot.png', PNG), caption: 'the broken header' });

    const shared = res.details?.sharedImage;
    expect(shared?.mimeType).toBe('image/png');
    expect(shared?.caption).toBe('the broken header');
    expect(readChatImage(images, shared!.file)?.body).toEqual(PNG);
    expect(res.content[0]!.text).toContain('Shared the image');
  });

  it('refuses a path outside a scoped caller\'s own roots', async () => {
    // A user confined to one project must not be able to publish any readable file on the box into their
    // own browser simply by naming it. (An all-access owner may, exactly as `Read` already lets them —
    // sharing adds no reach they did not already have.)
    const outside = join(home, 'secret.png');
    writeFileSync(outside, PNG);
    const res = await call({ path: outside }, { allowedProjectIds: new Set([1]), allowedPaths: () => [repo] });

    expect(res.details?.sharedImage).toBeUndefined();
    expect(res.content[0]!.text).toContain('outside your accessible repositories');
    // Nothing was written at all — the store dir does not even exist, so the refusal came before any read.
    expect(existsSync(images)).toBe(false);
  });

  it('lets a scoped caller share from inside their own root', async () => {
    const res = await call({ path: write('ok.png', PNG) }, { allowedProjectIds: new Set([1]), allowedPaths: () => [repo] });
    expect(res.details?.sharedImage?.mimeType).toBe('image/png');
  });

  it('judges the type by the bytes, not by the name', async () => {
    // `evil.png` holding HTML would be served from the app's own origin — a stored XSS with a picture's
    // file extension. The magic number is the only thing that can tell them apart.
    const res = await call({ path: write('evil.png', Buffer.from('<script>alert(1)</script>')) });

    expect(res.details?.sharedImage).toBeUndefined();
    expect(res.content[0]!.text).toContain('not a png, jpeg, gif or webp');
  });

  it('accepts the other formats it claims to', async () => {
    const res = await call({ path: write('photo.jpg', JPEG) });
    expect(res.details?.sharedImage?.mimeType).toBe('image/jpeg');
  });

  it('refuses a file past the size limit without reading it in', async () => {
    const res = await call({ path: write('huge.png', Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)])) });

    expect(res.details?.sharedImage).toBeUndefined();
    expect(res.content[0]!.text).toMatch(/over the 10 MB limit/);
  });

  it('reports a directory and a missing file rather than throwing', async () => {
    for (const path of [repo, join(repo, 'nope.png')]) {
      const res = await call({ path });
      expect(res.details?.sharedImage).toBeUndefined();
      expect(res.content[0]!.text).toContain('ShareImage:');
    }
  });
});

describe('ShareImage of the last tool image', () => {
  /** A screenshot taken WITHOUT a file path exists only as base64 inside a tool result. Persisting the
   *  turn externalizes it, and that is what `latest` then picks up — the model never handles the bytes. */
  const persistScreenshot = (bytes: Buffer, toolCallId = 't1'): void => {
    const message = externalizeImageBlocks({
      role: 'toolResult', toolCallId, toolName: 'take_screenshot', isError: false,
      content: [{ type: 'text', text: 'Took a screenshot.' }, { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }],
    }, images);
    store.appendMessage({ id: toolCallId, sessionId: SESSION, parentId: null, role: 'toolResult', content: message });
  };

  it('shares the image the last tool returned', async () => {
    persistScreenshot(PNG);
    const res = await call({ latest: true });

    expect(readChatImage(images, res.details!.sharedImage!.file)?.body).toEqual(PNG);
  });

  it('picks the NEWEST when several tools returned images', async () => {
    persistScreenshot(PNG, 't1');
    persistScreenshot(JPEG, 't2');
    const res = await call({ latest: true });

    expect(readChatImage(images, res.details!.sharedImage!.file)?.body).toEqual(JPEG);
  });

  it('says so when no tool has returned an image yet', async () => {
    const res = await call({ latest: true });

    expect(res.details?.sharedImage).toBeUndefined();
    expect(res.content[0]!.text).toContain('no tool has returned an image');
  });

  it('does not reach into another conversation', async () => {
    // The image belongs to the conversation it was taken in; `latest` must not walk out of it.
    store.createSession({ id: 'brain-2', userId: 1, model: 'm' });
    const message = externalizeImageBlocks({
      role: 'toolResult', toolCallId: 'other', content: [{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }],
    }, images);
    store.appendMessage({ id: 'other', sessionId: 'brain-2', parentId: null, role: 'toolResult', content: message });

    const res = await call({ latest: true });
    expect(res.content[0]!.text).toContain('no tool has returned an image');
  });
});

describe('ShareImage argument handling', () => {
  it('insists on exactly one source', async () => {
    for (const params of [{}, { path: '/tmp/a.png', latest: true }, { caption: 'just a caption' }]) {
      const res = await call(params);
      expect(res.content[0]!.text).toContain('exactly one of');
    }
  });

  it('stops after four images in one turn', async () => {
    // A model that decides screenshots are the answer would otherwise turn one reply into a gallery — and
    // on a chat platform, into that many separate uploads.
    const tool = buildShareImageTool({ store, imagesDir: images });
    const share = (name: string, byte: number) => runWithPolicy(
      { allowedProjectIds: 'all', allowedPaths: () => [repo] },
      () => tool.execute('c', { path: write(name, Buffer.concat([PNG, Buffer.of(byte)])) } as never, undefined, undefined, {} as never) as never,
      { sessionId: SESSION },
    ) as Promise<{ content: { text: string }[]; details?: { sharedImage?: unknown } }>;

    for (let i = 0; i < 4; i++) expect((await share(`s${i}.png`, i)).details?.sharedImage).toBeDefined();
    const fifth = await share('s4.png', 4);
    expect(fifth.details?.sharedImage).toBeUndefined();
    expect(fifth.content[0]!.text).toContain('already shared 4 images');
  });

  it('refuses rather than pretending when there is nowhere to store', async () => {
    const tool = buildShareImageTool({ store });
    const res = await runWithPolicy(
      { allowedProjectIds: 'all', allowedPaths: () => [repo] },
      () => tool.execute('c', { path: write('a.png', PNG) } as never, undefined, undefined, {} as never) as never,
      { sessionId: SESSION },
    ) as { content: { text: string }[] };

    expect(res.content[0]!.text).toContain('nowhere to store');
  });
});
