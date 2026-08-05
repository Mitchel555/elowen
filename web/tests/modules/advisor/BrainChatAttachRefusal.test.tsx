import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatProvider, useBrainChat } from '../../../modules/advisor/BrainChatProvider';

// Picking a file that cannot be attached has to say WHICH problem it is: too big is fixed by sending a
// smaller file, an unusable format by converting it. Both used to share one message that named neither —
// and a browser that reports no type at all (a drag from some apps, an unknown association) sent an
// ordinary PNG down the text branch, where a NUL byte got it refused as "binary".

class FakeES {
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(public url: string) {}
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
}

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.get('*/api/brain/messages', ({ request }) => (new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([]))),
  http.get('*/api/brain/status', () => HttpResponse.json({ running: false, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([{ id: 'brain-1', title: 'Chat', model: 'm', updated_at: '2026-08-05', active: true, attached: 0 }])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => { server.listen({ onUnhandledRequest }); });
afterEach(() => { server.resetHandlers(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

/** Reaches the provider's own attach entry point and reports what it staged. */
let addFiles: (files: Iterable<File>) => Promise<void>;
let staged: { name: string; kind: string; mimeType: string }[];

function Probe() {
  const chat = useBrainChat();
  addFiles = chat.addFiles;
  staged = chat.attachments.map((a) => ({ name: a.name, kind: a.kind, mimeType: a.mimeType }));
  return null;
}

async function mount() {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><BrainChatProvider><Probe /></BrainChatProvider></ToastProvider></Wrapper>);
  await waitFor(() => expect(addFiles).toBeTypeOf('function'));
}

/** jsdom's File does not implement the read methods the provider uses, so back them with real bytes. */
function fileOf(name: string, type: string, bytes: Uint8Array): File {
  const file = new File([bytes as BlobPart], name, ...(type ? [{ type }] : []));
  Object.defineProperty(file, 'text', { value: async () => new TextDecoder().decode(bytes) });
  return file;
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

describe('attaching a file the browser reports no type for', () => {
  it('still recognises a png by its extension instead of calling it binary', async () => {
    await mount();
    await act(async () => { await addFiles([fileOf('screenshot.png', '', PNG_BYTES)]); });
    expect(staged).toEqual([{ name: 'screenshot.png', kind: 'image', mimeType: 'image/png' }]);
  });

  it('recognises the other three the providers decode', async () => {
    await mount();
    await act(async () => {
      await addFiles([
        fileOf('a.jpg', '', PNG_BYTES), fileOf('b.jpeg', '', PNG_BYTES),
        fileOf('c.gif', '', PNG_BYTES), fileOf('d.webp', '', PNG_BYTES),
      ]);
    });
    expect(staged.map((s) => s.mimeType)).toEqual(['image/jpeg', 'image/jpeg', 'image/gif', 'image/webp']);
  });

  it('leaves a typeless non-image on the text path', async () => {
    await mount();
    const bytes = new TextEncoder().encode('poznamky');
    await act(async () => { await addFiles([fileOf('notes', '', bytes)]); });
    expect(staged).toEqual([{ name: 'notes', kind: 'text', mimeType: 'text/plain' }]);
  });
});

describe('a refusal names its own reason', () => {
  it('says the format is unusable for an image type the providers cannot decode', async () => {
    await mount();
    await act(async () => { await addFiles([fileOf('photo.heic', 'image/heic', PNG_BYTES)]); });
    expect(staged).toEqual([]);
    expect(await screen.findByText(/nepodporovaný formát|unsupported format/i)).toBeTruthy();
  });

  it('says too large — and does not blame the format — for an oversized image', async () => {
    await mount();
    const big = fileOf('huge.png', 'image/png', PNG_BYTES);
    Object.defineProperty(big, 'size', { value: 6 * 1024 * 1024 });
    await act(async () => { await addFiles([big]); });
    expect(staged).toEqual([]);
    expect(await screen.findByText(/příliš velký|too large|príliš veľký/i)).toBeTruthy();
    expect(screen.queryByText(/nepodporovaný formát|unsupported format/i)).toBeNull();
  });

  it('shrinks an oversized photo instead of refusing it, which is all a phone can send', async () => {
    // Stand in for the browser APIs jsdom lacks; the shrink itself is covered in tests/lib/imageDownscale.
    vi.stubGlobal('createImageBitmap', async () => ({ width: 4032, height: 3024, close: () => {} }));
    // Only the canvas is faked; React is rendering real elements through this same call.
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => (tag === 'canvas'
      ? ({
          width: 0, height: 0,
          getContext: () => ({ drawImage: () => {} }),
          toBlob: (cb: (b: Blob) => void, type: string) => cb(new Blob([new Uint8Array([1, 2, 3])], { type })),
        } as unknown as HTMLElement)
      : realCreate(tag)));
    await mount();
    const photo = fileOf('IMG_4821.jpg', 'image/jpeg', PNG_BYTES);
    Object.defineProperty(photo, 'size', { value: 9 * 1024 * 1024 });
    await act(async () => { await addFiles([photo]); });
    expect(staged).toEqual([{ name: 'IMG_4821.jpg', kind: 'image', mimeType: 'image/jpeg' }]);
    expect(screen.queryByText(/příliš velký|too large|príliš veľký/i)).toBeNull();
  });

  it('still refuses genuinely binary content that is not an image', async () => {
    await mount();
    await act(async () => { await addFiles([fileOf('blob.bin', '', new Uint8Array([1, 0, 2]))]); });
    expect(staged).toEqual([]);
    expect(await screen.findByText(/nepodporovaný formát|unsupported format/i)).toBeTruthy();
  });
});
