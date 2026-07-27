import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const wsTicket = vi.fn(() => Promise.resolve({ ticket: 'T1' }));
const wsConfig = vi.fn(() => Promise.resolve({ directPort: null as number | null }));
vi.mock('../../lib/elowenClient', () => ({
  elowenClient: { wsTicket: (...a: unknown[]) => wsTicket(...(a as [])), wsConfig: () => wsConfig() },
  terminalWsUrl: (t: string, directPort?: number | null) => `ws://${directPort ? `host:${directPort}` : 'host'}/ws/terminal?ticket=${t}`,
}));

class FakeWS {
  static OPEN = 1;
  static last: FakeWS;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeWS.last = this; }
  send(d: string) { this.sent.push(d); }
  close() { this.closed = true; }
}

beforeEach(() => {
  wsTicket.mockClear();
  wsTicket.mockResolvedValue({ ticket: 'T1' });
  wsConfig.mockClear();
  (globalThis as unknown as { WebSocket: typeof FakeWS }).WebSocket = FakeWS;
});

import { useTerminalStream } from '../../lib/useTerminalStream';

describe('useTerminalStream', () => {
  it('mints a ticket and opens the ws, flipping to open', async () => {
    const { result } = renderHook(() => useTerminalStream('elowen-advisor-1', true, () => {}));
    await waitFor(() => expect(FakeWS.last).toBeDefined());
    expect(FakeWS.last.url).toContain('ticket=T1');
    act(() => FakeWS.last.onopen?.());
    expect(result.current.status).toBe('open');
  });

  it('pushes incoming bytes to onData', async () => {
    const onData = vi.fn();
    renderHook(() => useTerminalStream('elowen-advisor-1', true, onData));
    await waitFor(() => expect(FakeWS.last).toBeDefined());
    act(() => FakeWS.last.onmessage?.({ data: '\x1b[32mhi' }));
    expect(onData).toHaveBeenCalledWith('\x1b[32mhi');
  });

  it('treats the 4001 close code as unsupported (fallback)', async () => {
    const { result } = renderHook(() => useTerminalStream('elowen-advisor-1', true, () => {}));
    await waitFor(() => expect(FakeWS.last).toBeDefined());
    act(() => FakeWS.last.onclose?.({ code: 4001 }));
    expect(result.current.status).toBe('unsupported');
  });

  it('treats a close BEFORE the first open as unsupported (no WS-capable proxy in front of the daemon)', async () => {
    const { result } = renderHook(() => useTerminalStream('elowen-advisor-1', true, () => {}));
    await waitFor(() => expect(FakeWS.last).toBeDefined());
    act(() => FakeWS.last.onclose?.({ code: 1006 }));
    expect(result.current.status).toBe('unsupported');
  });

  it('reconnects with a fresh ticket after a healthy socket drops', async () => {
    const { result } = renderHook(() => useTerminalStream('elowen-advisor-1', true, () => {}));
    await waitFor(() => expect(FakeWS.last).toBeDefined());
    act(() => FakeWS.last.onopen?.());
    const first = FakeWS.last;

    act(() => first.onclose?.({ code: 1000 })); // the phone locked and the socket died
    expect(result.current.status).toBe('reconnecting');
    // A ticket is single use, so the recovery has to mint a new one — the socket cannot just reopen.
    await waitFor(() => expect(wsTicket).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    await waitFor(() => expect(FakeWS.last).not.toBe(first));
    act(() => FakeWS.last.onopen?.());
    expect(result.current.status).toBe('open');
  });

  it('reopens the socket when the page wakes up', async () => {
    renderHook(() => useTerminalStream('elowen-advisor-1', true, () => {}));
    await waitFor(() => expect(FakeWS.last).toBeDefined());
    act(() => FakeWS.last.onopen?.());
    FakeWS.last.readyState = 3; // iOS tore the socket down while the page was frozen

    act(() => { window.dispatchEvent(new Event('pageshow')); });

    await waitFor(() => expect(wsTicket).toHaveBeenCalledTimes(2));
  });

  it('falls back to unsupported when the ticket mint fails', async () => {
    wsTicket.mockRejectedValueOnce(new Error('403'));
    const { result } = renderHook(() => useTerminalStream('elowen-advisor-1', true, () => {}));
    await waitFor(() => expect(result.current.status).toBe('unsupported'));
  });

  it('send and resize post the right payloads while open', async () => {
    const { result } = renderHook(() => useTerminalStream('elowen-advisor-1', true, () => {}));
    await waitFor(() => expect(FakeWS.last).toBeDefined());
    act(() => { result.current.send('ls\n'); result.current.resize(120, 40); });
    expect(FakeWS.last.sent).toEqual(['ls\n', JSON.stringify({ type: 'resize', cols: 120, rows: 40 })]);
  });

  it('does not connect when disabled', () => {
    renderHook(() => useTerminalStream('elowen-advisor-1', false, () => {}));
    expect(wsTicket).not.toHaveBeenCalled();
  });
});
