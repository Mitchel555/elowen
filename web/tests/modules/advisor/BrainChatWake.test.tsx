import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChat } from '../../../modules/advisor/BrainChat';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';

// A locked phone must not look like a closed tab. iOS freezes the page into the bfcache and fires
// `pagehide` with `persisted: true`; the beacon that followed it stopped the conversation server-side and
// killed the running agent. And on the way back the native EventSource reconnect is not enough — it
// reopens with the OLD generation, which the daemon's stop tombstone refuses — so waking must run the
// FULL connect (a fresh brainStart), the only path that legitimately clears that tombstone.
//
// What jsdom cannot reproduce (a real bfcache freeze/restore, iOS suspending timers and sockets) is
// device-only; these tests pin the logic the browser drives.

/** EventSource stand-in with a controllable readyState (the real one is what decides "reopen or reconnect"). */
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
  emit(type: string, data: unknown) {
    act(() => { for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) }); });
  }
}

let stopBodies: Record<string, unknown>[] = [];
let startBodies: Record<string, unknown>[] = [];

const server = setupServer(
  http.post('*/api/brain/start', async ({ request }) => {
    startBodies.push((await request.json()) as Record<string, unknown>);
    return HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 });
  }),
  http.post('*/api/brain/session/stop', async ({ request }) => {
    stopBodies.push((await request.json()) as Record<string, unknown>);
    return HttpResponse.json({ stopped: false, disposed: false });
  }),
  http.get('*/api/brain/messages', ({ request }) => new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([])),
  http.get('*/api/brain/status', () => HttpResponse.json({ running: true, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

let clock = 1_800_000_000_000;

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; stopBodies = []; startBodies = []; vi.restoreAllMocks(); });
afterAll(() => server.close());
beforeEach(() => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES;
  clock += 3_600_000; // the shared revive emitter coalesces per wall clock — keep tests far apart
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});

function renderChat() {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider><BrainChatProvider><BrainChat /></BrainChatProvider></ToastProvider></Wrapper>);
}

/** `pagehide`, as the browser fires it — `persisted` tells a bfcache freeze from a real unload. */
function firePageHide(persisted: boolean): void {
  const event = new Event('pagehide') as Event & { persisted: boolean };
  Object.defineProperty(event, 'persisted', { value: persisted });
  act(() => { window.dispatchEvent(event); });
}

describe('BrainChat wake-up handling', () => {
  it('sends NO stop beacon when the page is only frozen into the bfcache', async () => {
    const beacon = vi.fn((_url: string, _body?: BodyInit | null) => true);
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: beacon });
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));

    firePageHide(true);

    // Nothing may STOP the conversation — that is what used to kill the running agent. Reporting the tab
    // as off screen is the opposite and must still happen: a frozen page is a phone whose owner is not
    // reading, which is exactly the case the "turn finished" push exists to serve.
    expect(beacon.mock.calls.some(([url]) => String(url).includes('/brain/session/stop'))).toBe(false);
    expect(stopBodies).toEqual([]);
    expect(beacon.mock.calls.some(([url]) => String(url).includes('/brain/visibility'))).toBe(true);
  });

  it('sends a detachOnly stop exactly once on a real unload', async () => {
    // A Blob body cannot be read synchronously in jsdom, so drop sendBeacon and let the client's
    // keepalive-fetch fallback carry the payload — the same JSON either way.
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: undefined });
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));

    firePageHide(false);
    firePageHide(false); // a second unload event must not double-send

    await waitFor(() => expect(stopBodies.length).toBe(1));
    expect(stopBodies[0]).toMatchObject({ session: 'brain-1', detachOnly: true });
  });

  it('runs a FULL reconnect (fresh brainStart) when the page wakes after being hidden', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    expect(startBodies.length).toBe(1);

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    clock += 30_000; // the phone was locked for half a minute
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });

    // A new generation is claimed — that is what clears the daemon's stop tombstone; a bare EventSource
    // reopen would have retried the old one forever.
    await waitFor(() => expect(startBodies.length).toBe(2));
    expect(startBodies[1]?.['generation']).toBe(2);
    await waitFor(() => expect(FakeES.instances.length).toBe(2));
  });

  it('does not reconnect on a brief hide while the stream is healthy', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    clock += 500; // a glance at another tab
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });

    await new Promise((r) => setTimeout(r, 20));
    expect(startBodies.length).toBe(1);
    expect(FakeES.instances.length).toBe(1);
  });

  it('asks the daemon for a keep-alive the browser can actually see', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    // Without this the keep-alive stays an SSE comment, which an EventSource never surfaces — and a stream
    // that silently died would look exactly like an idle one.
    expect(new URL(FakeES.instances[0]!.url, 'http://localhost').searchParams.get('heartbeat')).toBe('1');
  });

  it('reconnects on wake when nothing has arrived for a while, however brief the hide', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));

    // Frozen timers mean the silence watchdog never ran; the wake-up has to notice from the clock alone.
    clock += 60_000;
    act(() => { window.dispatchEvent(new Event('pageshow')); });

    await waitFor(() => expect(startBodies.length).toBe(2));
  });

  it('treats a heartbeat as proof of life, so a fed stream survives the wake-up', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));

    clock += 60_000;
    FakeES.instances[0]!.emit('heartbeat', {});
    act(() => { window.dispatchEvent(new Event('pageshow')); });

    await new Promise((r) => setTimeout(r, 20));
    expect(startBodies.length).toBe(1);
    expect(FakeES.instances.length).toBe(1);
  });

  it('runs ONE reconnect when a wake-up and a server error frame land together', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));

    FakeES.instances[0]!.emit('error', { message: 'brain not started' }); // schedules a backed-off retry
    clock += 60_000;
    act(() => { window.dispatchEvent(new Event('pageshow')); }); // and the phone wakes at the same moment

    await waitFor(() => expect(startBodies.length).toBe(2), { timeout: 3_000 });
    await new Promise((r) => setTimeout(r, 1_500)); // long enough for a second, racing attempt to appear
    expect(startBodies.length).toBe(2);
  });

  it('reconnects on wake when the stream is no longer open, however brief the hide', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    FakeES.instances[0]!.readyState = 2; // CLOSED — iOS tore the socket down while frozen

    clock += 500;
    act(() => { window.dispatchEvent(new Event('pageshow')); });

    await waitFor(() => expect(startBodies.length).toBe(2));
  });
});
