import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChat } from '../../../modules/advisor/BrainChat';
import { BrainChatProvider, useBrainChat } from '../../../modules/advisor/BrainChatProvider';

/** A stream that has been superseded must not be able to touch anything. `close()` does not unschedule a
 *  callback the browser has ALREADY dispatched, so a frame from the previous conversation can still run
 *  after the next one is live — and the handlers share refs with it. Left unguarded, a dead stream could
 *  fold its text into the new conversation, or close the live stream outright through the shared ref. */

class FakeES {
  static instances: FakeES[] = [];
  static OPEN = 1;
  readyState = 1;
  closed = false;
  private listeners = new Map<string, ((e: { data?: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() { this.closed = true; }
  /** Deliver a frame REGARDLESS of `closed` — that is precisely the race being reproduced. */
  emit(type: string, data: unknown) {
    act(() => { for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) }); });
  }
}

let startCalls = 0;

const server = setupServer(
  http.post('*/api/brain/start', () => {
    startCalls += 1;
    return HttpResponse.json({ sessionId: startCalls === 1 ? 'brain-1' : 'brain-2' }, { status: 201 });
  }),
  http.get('*/api/brain/messages', ({ request }) => (new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([]))),
  http.get('*/api/brain/status', () => HttpResponse.json({
    running: false, sessionId: 'brain-2', model: 'm', usage: null, statusline: null, cards: [], queued: [],
  })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; startCalls = 0; localStorage.clear(); });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

/** Drives a real session switch through the provider's own API rather than through the UI. */
function SwitchProbe() {
  const { switchSession } = useBrainChat();
  return (
    <button type="button" onClick={() => void switchSession({ session: 'brain-2' })}>switch session</button>
  );
}

async function renderAndSwitch(): Promise<{ old: FakeES; fresh: FakeES }> {
  const { wrapper: Wrapper } = createWrapper();
  render(
    <Wrapper><ToastProvider><BrainChatProvider>
      <BrainChat />
      <SwitchProbe />
    </BrainChatProvider></ToastProvider></Wrapper>,
  );
  await waitFor(() => expect(FakeES.instances.length).toBe(1));

  fireEvent.click(screen.getByRole('button', { name: 'switch session' }));
  await waitFor(() => expect(FakeES.instances.length).toBe(2));
  return { old: FakeES.instances[0]!, fresh: FakeES.instances[1]! };
}

describe('a superseded stream cannot affect the live one', () => {
  it('folds text from the live stream but ignores it from the dead one', async () => {
    const { old, fresh } = await renderAndSwitch();

    // Prove the mechanism works at all first, so the absence assertion below cannot pass vacuously.
    fresh.emit('text', { delta: 'text from the live stream' });
    expect(await screen.findByText(/text from the live stream/)).toBeInTheDocument();

    old.emit('text', { delta: 'GHOST from the dead stream' });
    await waitFor(() => expect(screen.queryByText(/GHOST from the dead stream/)).toBeNull());
  });

  it('does not let a dead stream close the live one', async () => {
    const { old, fresh } = await renderAndSwitch();

    // The error handler used to close `esRef.current` — the CURRENT stream — rather than its own.
    old.emit('error', { message: 'brain not started' });

    await waitFor(() => expect(fresh.closed).toBe(false));
    // …and the dead stream's message must not surface as this conversation's notice either.
    expect(screen.queryByText(/brain not started/)).toBeNull();
  });

  it('does not let a dead stream rebind the conversation', async () => {
    const { old, fresh } = await renderAndSwitch();

    old.emit('session', { sessionId: 'brain-ROLLED-OVER' });
    old.emit('snapshot', {
      sessionId: 'brain-ROLLED-OVER', hasMore: false, nextBefore: null,
      history: [{ role: 'assistant', text: 'GHOST history', id: 'g1' }], events: [],
      control: { streaming: false, pendingAsk: null },
    });

    await waitFor(() => expect(screen.queryByText(/GHOST history/)).toBeNull());
    expect(fresh.closed).toBe(false);
  });
});
