import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChat } from '../../../modules/advisor/BrainChat';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';

// The provider is mounted once above EVERY route, so the reconnect overlay it owns must be tied to a chat
// actually being on screen. Owning the overlay there is deliberate — two surfaces (dock + /chat) share one
// provider and a per-surface overlay would double up — but without this check a dropped stream blurred and
// froze the dashboard, tasks and settings too, where there is no conversation to protect.

class FakeES {
  static instances: FakeES[] = [];
  static OPEN = 1;
  readyState = FakeES.OPEN;
  closed = false;
  listeners = new Map<string, ((e: unknown) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() { this.closed = true; }
  emit(type: string, data: unknown) {
    act(() => { for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) }); });
  }
}

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.get('*/api/brain/messages', ({ request }) => (new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([]))),
  http.get('*/api/brain/status', () => HttpResponse.json({
    running: true, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [],
  })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; localStorage.clear(); vi.restoreAllMocks(); });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

/** The chat can be navigated away from while the provider above it stays mounted — exactly what happens
 *  when the reader leaves /chat for the dashboard. */
function Harness() {
  const [onChat, setOnChat] = useState(true);
  return (
    <BrainChatProvider>
      <button type="button" onClick={() => setOnChat(false)}>leave chat</button>
      {onChat ? <BrainChat /> : <p>dashboard</p>}
    </BrainChatProvider>
  );
}

async function renderChat(): Promise<FakeES> {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><Harness /></ToastProvider></Wrapper>);
  await waitFor(() => expect(FakeES.instances.length).toBe(1));
  return FakeES.instances[0]!;
}

/** Drop the stream the way the daemon does after an error frame, and keep the reconnect failing so the
 *  overlay stays up for the assertion instead of racing a successful retry. */
function dropStream(es: FakeES) {
  server.use(http.post('*/api/brain/start', () => HttpResponse.json({ error: 'brain down' }, { status: 500 })));
  es.emit('error', { message: 'brain not started' });
}

describe('reconnect overlay', () => {
  it('covers the app while a chat is on screen', async () => {
    const es = await renderChat();
    dropStream(es);

    expect(await screen.findByText('Connecting…')).toBeInTheDocument();
  });

  it('lifts as soon as the reader leaves the chat, even though the stream is still down', async () => {
    const es = await renderChat();
    dropStream(es);
    await screen.findByText('Connecting…');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'leave chat' })); });

    // The provider outlives the route, so the reconnect keeps running — but with no conversation on
    // screen there is nothing to shield, and the dashboard must not sit behind a blur.
    await screen.findByText('dashboard');
    await waitFor(() => expect(screen.queryByText('Connecting…')).toBeNull());
  });
});
