import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatSurface } from '../../../modules/advisor/BrainChatSurface';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';

/** Fullscreen is a display preference, so it survives a reload like the reasoning toggle and the rail's
 *  width do. Re-entering it on every visit was the chore this guards against. */

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
  http.get('*/api/brain/messages', ({ request }) => new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([])),
  http.get('*/api/brain/status', () => HttpResponse.json({ running: false, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([{ id: 'brain-1', title: 'Chat', model: 'm', updated_at: '2026-07-08', active: true, attached: 0 }])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; localStorage.clear(); });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

function renderSurface() {
  const { wrapper: Wrapper } = createWrapper();
  return render(
    <Wrapper><ToastProvider><BrainChatProvider><BrainChatSurface variant="full" /></BrainChatProvider></ToastProvider></Wrapper>,
  );
}

describe('chat fullscreen preference', () => {
  it('persists entering and leaving fullscreen', async () => {
    renderSurface();

    fireEvent.click(await screen.findByRole('button', { name: 'Fullscreen' }));
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBe('on'));

    fireEvent.click(screen.getByRole('button', { name: 'Exit fullscreen' }));
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBe('off'));
  });

  it('rehydrates a stored "on" so a returning reader is already in fullscreen', async () => {
    localStorage.setItem(STORAGE_KEY, 'on');
    renderSurface();

    // The button flipping to its exit label is the observable proof the stored value was applied — the
    // overlay itself is CSS, which jsdom does not lay out.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Exit fullscreen' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Exit fullscreen' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('ignores a foreign stored value instead of trusting it', async () => {
    localStorage.setItem(STORAGE_KEY, 'maximised');
    renderSurface();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Fullscreen' })).toBeInTheDocument());
  });
});
