import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { en } from '../../../lib/i18n/dictionaries/en';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChat } from '../../../modules/advisor/BrainChat';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';

/** Guards the two render paths added when the web transcript reached parity with the daemon wire contract:
 *  a session-change EVENT row and a tool-output NOTES suffix. Both are new branches in BrainChatSurface's
 *  Message component — the build only type-checks them; this mounts the real surface over seeded history so
 *  a runtime render crash (or a dropped row) fails CI, which is the closest thing to an E2E of the dock. */

class FakeES {
  static instances: FakeES[] = [];
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
  emit(type: string, data: unknown) {
    act(() => { for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) }); });
  }
}

// A history page carrying every new-parity row: a model-switch event marker, then an assistant turn whose
// tool output has hook-appended notes.
const HISTORY = [
  { id: 'e1', role: 'event', text: '', kind: 'model', detail: 'gpt-5.4' },
  {
    id: 'm1', role: 'assistant', text: '',
    segments: [{
      kind: 'tool', name: 'Edit', id: 'c1', detail: 'a.ts',
      output: { title: 'result', kind: 'result', text: 'patched', tone: 'success', notes: ['formatted a.ts with prettier'] },
    }],
  },
];

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.get('*/api/brain/messages', ({ request }) => new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: HISTORY, hasMore: false, nextBefore: null })
    : HttpResponse.json(HISTORY)),
  http.get('*/api/brain/status', () => HttpResponse.json({ running: false, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([{ id: 'brain-1', title: 'Chat', model: 'm', updated_at: '2026-07-08', active: true, attached: 0 }])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

describe('BrainChatSurface renders the daemon-parity rows without crashing', () => {
  it('shows a session-change event marker and a tool-output notes suffix from seeded history', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><BrainChatProvider><BrainChat /></BrainChatProvider></ToastProvider></Wrapper>);
    // The transcript is hydrated by the stream's snapshot frame, not by a separate history fetch.
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    FakeES.instances[0]!.emit('snapshot', {
      type: 'snapshot', sessionId: 'brain-1', history: HISTORY, events: [], hasMore: false, nextBefore: null,
    });
    // The event row renders its label (eventLabel mirror of the daemon sessionEventLabel).
    expect(await screen.findByText('model → gpt-5.4')).toBeInTheDocument();
    // The tool-output notes suffix renders under the output body.
    expect(await screen.findByText(/formatted a\.ts with prettier/)).toBeInTheDocument();
  });

  it('lets the user expand a truncated tool output instead of promising a broken terminal link', async () => {
    // Regression for review-web-sol finding 6: the old markup rendered "Click to expand in terminal" on a
    // plain div with no handler. This asserts the affordance is now a real, working, translated toggle.
    const richHistory = [{
      id: 'm2', role: 'assistant', text: '',
      segments: [{
        kind: 'tool', name: 'Bash', id: 'c2', detail: 'npm test',
        output: { title: 'result', kind: 'console', text: 'FAIL summary', fullText: 'FAIL summary\nfull failure log here' },
      }],
    }];
    server.use(http.get('*/api/brain/messages', ({ request }) => new URL(request.url).searchParams.has('limit')
      ? HttpResponse.json({ items: richHistory, hasMore: false, nextBefore: null })
      : HttpResponse.json(richHistory)));

    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><BrainChatProvider><BrainChat /></BrainChatProvider></ToastProvider></Wrapper>);
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    FakeES.instances[0]!.emit('snapshot', {
      type: 'snapshot', sessionId: 'brain-1', history: richHistory, events: [], hasMore: false, nextBefore: null,
    });

    const expandBtn = await screen.findByTestId('chat-tool-output-expand');
    expect(expandBtn).toHaveTextContent(en.brainChat.toolOutputExpand);
    expect(screen.queryByText(/full failure log here/)).toBeNull();

    fireEvent.click(expandBtn);
    expect(await screen.findByText(/full failure log here/)).toBeInTheDocument();
    expect(expandBtn).toHaveTextContent(en.brainChat.toolOutputCollapse);

    fireEvent.click(expandBtn); // toggles back to the short preview
    await waitFor(() => expect(screen.queryByText(/full failure log here/)).toBeNull());
  });
});
