import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse, delay } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChat } from '../../../modules/advisor/BrainChat';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import { openBrainSession } from '../../../lib/brainDock';

/** Regression for synthesis Tier 1 #10: `openReadOnly()` bumped the generation but never captured it and
 *  never re-checked it after its await, unlike `connect()` in the same file which does. A slow read-only
 *  open whose history fetch resolves AFTER the user has already switched away could inject the old,
 *  foreign transcript into whatever conversation is current by then. */

class FakeES {
  static instances: FakeES[] = [];
  closed = false;
  private listeners = new Map<string, ((e: { data?: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() { this.closed = true; }
}

const server = setupServer(
  http.post('*/api/brain/start', async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    const sessionId = typeof body['session'] === 'string' ? (body['session'] as string) : 'brain-1';
    return HttpResponse.json({ sessionId }, { status: 201 });
  }),
  http.get('*/api/brain/messages', async ({ request }) => {
    const url = new URL(request.url);
    if (url.searchParams.has('limit')) return HttpResponse.json({ items: [], hasMore: false, nextBefore: null });
    const session = url.searchParams.get('session');
    // The read-only preview's history resolves LATE — after the user has already switched away.
    if (session === 'slow-ro') {
      await delay(80);
      return HttpResponse.json([{ role: 'assistant', text: 'OLD READONLY HISTORY', id: 'ro1' }]);
    }
    return HttpResponse.json([]);
  }),
  http.get('*/api/brain/status', () => HttpResponse.json({
    running: false, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [],
  })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

function renderChat() {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider><BrainChatProvider><BrainChat /></BrainChatProvider></ToastProvider></Wrapper>);
}

describe('a late read-only open cannot overwrite the active conversation', () => {
  it('discards the stale history once a newer switch has taken over', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1)); // initial default connect (live)

    // Open a read-only preview whose history fetch is slow, then immediately switch to a live
    // conversation before it resolves — exactly the sequence the finding describes.
    act(() => { openBrainSession('slow-ro', false); });
    act(() => { openBrainSession('brain-2', true); });

    // The switch wins: a second live stream opens for the new conversation.
    await waitFor(() => expect(FakeES.instances.length).toBe(2));
    const textarea = await screen.findByRole('textbox'); // live composer, not the read-only banner
    expect(textarea).toBeInTheDocument();

    // Give the slow read-only fetch time to land — it must be discarded, not clobber the live view.
    await act(async () => { await delay(150); });

    expect(screen.queryByText(/OLD READONLY HISTORY/)).toBeNull();
    expect(screen.getByRole('textbox')).toBeInTheDocument(); // still the live composer, not read-only
  });
});
