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
// (inline). Which set is chosen must wait for the viewport measurement.

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
    const sawDesktopControls = watchMounts('[data-testid="chat-thoughts-toggle"]');
    renderSurface();

    await screen.findByRole('button', { name: 'More options' });
    expect(sawDesktopControls()).toBe(false);
  });

  it('keeps the desktop controls inline off a phone', async () => {
    setViewport(false);
    renderSurface();

    expect(await screen.findByTestId('chat-thoughts-toggle')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More options' })).toBeNull();
  });

  it('closes the ⋯ popover on Escape', async () => {
    setViewport(true);
    renderSurface();
    fireEvent.click(await screen.findByRole('button', { name: 'More options' }));
    await waitFor(() => expect(document.querySelector('[data-chat-popover]')).not.toBeNull());

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(document.querySelector('[data-chat-popover]')).toBeNull());
  });

  // The footer metrics (model / context / tokens / cost) must stay ONE line on a phone: a second row
  // pushes the composer down and eats the little vertical space a phone has. jsdom does no layout, so
  // what is guarded here is the class contract that produces the single line — the row itself must not
  // wrap, each metric must not wrap internally (a no-wrap flex row still lets an item's own text break),
  // and the model name — the long, expendable part — absorbs the squeeze by truncating.
  it('keeps the model/context/tokens/cost footer on one line for a phone', async () => {
    server.use(http.get('*/api/brain/status', () => HttpResponse.json({
      running: false, sessionId: 'brain-1', model: 'claude-opus-5', cards: [], queued: [],
      statusline: { showModel: true, showContext: true, showTokens: true, showCost: true },
      usage: { tokens: 258_000, contextWindow: 1_000_000, percent: 26, totalTokens: 126_300_000, cost: 59.08 },
    })));
    setViewport(true);
    renderSurface();

    const line = await screen.findByTestId('chat-statusline');
    expect(line.className).not.toContain('flex-wrap');

    const spans = [...line.querySelectorAll('span')];
    const model = spans.find((s) => s.textContent === 'claude-opus-5');
    expect(model?.className).toContain('truncate');
    expect(model?.getAttribute('title')).toBe('claude-opus-5'); // truncation must not hide which model ran

    const metrics = spans.filter((s) => /26%|Σ|59\.08/.test(s.textContent ?? ''));
    expect(metrics).toHaveLength(3);
    for (const metric of metrics) expect(metric.className).toContain('whitespace-nowrap');
  });
});
