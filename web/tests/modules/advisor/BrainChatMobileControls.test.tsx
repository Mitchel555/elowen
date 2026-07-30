import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper, setViewport, watchMounts } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatSurface } from '../../../modules/advisor/BrainChatSurface';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';

// The conversation bar carries different controls on a phone (folded into the ⋯ popover) than on desktop
// (inline). Which set is chosen must wait for the viewport measurement, and the fullscreen view it opens
// onto has to leave Escape to whatever transient UI is on top of it.

class FakeES {
  static instances: FakeES[] = [];
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
}

const STORAGE_KEY = 'elowen.chat.fullscreen';

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.get('*/api/brain/messages', ({ request }) => (new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([]))),
  http.get('*/api/brain/status', () => HttpResponse.json({ running: false, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([{ id: 'brain-1', title: 'Chat', model: 'm', updated_at: '2026-07-08', active: true, attached: 0 }])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; localStorage.clear(); vi.restoreAllMocks(); });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

function renderSurface() {
  const { wrapper: Wrapper } = createWrapper();
  return render(
    <Wrapper><ToastProvider><BrainChatProvider><BrainChatSurface variant="full" /></BrainChatProvider></ToastProvider></Wrapper>,
  );
}

describe('conversation bar controls', () => {
  it('never paints the desktop controls on a phone, not even for one commit', async () => {
    // The boolean-returning useMobile reports `false` before the first measurement, so the phone briefly
    // got the inline desktop bar and then swapped it for the ⋯ popover — a visible rearrangement on load.
    setViewport(true);
    const sawDesktopControls = watchMounts('[aria-label="Fullscreen"],[aria-label="Exit fullscreen"]');
    renderSurface();

    await screen.findByRole('button', { name: 'More options' });
    expect(sawDesktopControls()).toBe(false);
  });

  it('keeps the desktop controls inline off a phone', async () => {
    setViewport(false);
    renderSurface();

    expect(await screen.findByRole('button', { name: 'Fullscreen' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More options' })).toBeNull();
  });

  it('lets Escape close the ⋯ popover without also dropping fullscreen', async () => {
    // Both handlers fire on the same keystroke, so the fullscreen guard has to recognise the popover as
    // transient UI that owns Escape first — it used to look only for listboxes and dialogs.
    setViewport(true);
    renderSurface();
    fireEvent.click(await screen.findByRole('button', { name: 'More options' }));
    await waitFor(() => expect(document.querySelector('[data-chat-popover]')).not.toBeNull());
    // A phone auto-enters fullscreen on mount.
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBe('on'));

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(document.querySelector('[data-chat-popover]')).toBeNull());
    expect(localStorage.getItem(STORAGE_KEY)).toBe('on');
  });

  it('hides the transcript scrollbar in the immersive phone view only', async () => {
    setViewport(true);
    renderSurface();

    const transcript = await screen.findByTestId('chat-transcript');
    await waitFor(() => expect(transcript.className).toContain('chat-scroll-hide'));
  });

  it('keeps the scrollbar in desktop fullscreen, where it is the only position cue', async () => {
    localStorage.setItem(STORAGE_KEY, 'on');
    setViewport(false);
    renderSurface();

    const transcript = await screen.findByTestId('chat-transcript');
    // Still a fullscreen scroll box, just not a hidden-scrollbar one.
    await waitFor(() => expect(transcript.className).toContain('overflow-y-auto'));
    expect(transcript.className).not.toContain('chat-scroll-hide');
  });
});
