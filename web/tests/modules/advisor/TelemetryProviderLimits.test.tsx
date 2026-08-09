import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { useEffect } from 'react';
import { BrainChatProvider, useBrainChat } from '../../../modules/advisor/BrainChatProvider';
import { TelemetryPanel } from '../../../modules/advisor/TelemetryPanel';

class FakeES {
  static instances: FakeES[] = [];
  static OPEN = 1;
  readyState = 1;
  private listeners = new Map<string, ((e: { data?: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data?: string }) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  close() {}
  emit(type: string, data: unknown) {
    act(() => { for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) }); });
  }
}

let provider = 'anthropic';
let rateLimitFetches = 0;
const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.post('*/api/brain/visibility', () => HttpResponse.json({ ok: true })),
  http.get('*/api/brain/messages', () => HttpResponse.json({ items: [], hasMore: false, nextBefore: null })),
  http.get('*/api/brain/status', () => HttpResponse.json({
    running: true, sessionId: 'brain-1', model: provider === 'anthropic' ? 'claude' : 'gpt', provider, usage: null, statusline: null, cards: [], queued: [],
  })),
  http.get('*/api/brain/rate-limits', () => {
    rateLimitFetches += 1;
    return HttpResponse.json({ provider, planType: provider, windows: [], fetchedAt: 0, stale: false });
  }),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => server.listen({ onUnhandledRequest }));
afterAll(() => server.close());
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; provider = 'anthropic'; rateLimitFetches = 0; });
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

function Attach() {
  const chat = useBrainChat();
  useEffect(() => { chat.ensureAttached(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

describe('telemetry provider usage cache', () => {
  it('refetches rate limits when a session-event changes provider under the same session id', async () => {
    const { wrapper } = createWrapper();
    render(<ToastProvider><BrainChatProvider><Attach /><TelemetryPanel variant="column" /></BrainChatProvider></ToastProvider>, { wrapper });
    await waitFor(() => expect(FakeES.instances).toHaveLength(1));
    await waitFor(() => expect(rateLimitFetches).toBeGreaterThan(0));
    const initialFetches = rateLimitFetches;

    provider = 'openai-codex';
    FakeES.instances[0]!.emit('session-event', {});
    await waitFor(() => expect(rateLimitFetches).toBeGreaterThan(initialFetches));
  });
});
