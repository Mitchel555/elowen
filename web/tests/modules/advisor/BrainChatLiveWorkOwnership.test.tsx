import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatSurface } from '../../../modules/advisor/BrainChatSurface';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import type { ProcessInfo } from '../../../lib/types';

/** Running agents and background processes must be announced in exactly ONE place. The docked telemetry
 *  rail lists both and drills into both, so while it is open the in-transcript process panel and agents
 *  chip are duplicates. With no rail — or a hidden one — the transcript has to keep reporting them, or the
 *  work would become invisible instead of merely un-duplicated. */

class FakeES {
  static instances: FakeES[] = [];
  static OPEN = 1;
  readyState = 1;
  private listeners = new Map<string, ((e: { data?: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
  emit(type: string, data: unknown) {
    act(() => { for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) }); });
  }
}

const process1: ProcessInfo = {
  id: 'p1', command: 'sleep 55', cwd: '/var/www/elowen', sessionId: 'brain-1',
  startedAt: '2026-07-27T10:00:00.000Z', running: true, exitCode: null, completionMode: 'service',
};

/** Asserting a row is ABSENT only means something once the data it would come from has actually arrived. */
let processFetches = 0;

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.get('*/api/brain/messages', ({ request }) => (new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([]))),
  http.get('*/api/brain/status', () => HttpResponse.json({
    running: true, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [],
  })),
  http.get('*/api/brain/processes', () => { processFetches += 1; return HttpResponse.json([process1]); }),
  http.get('*/api/brain/processes/:id/output', () => HttpResponse.json({ output: '' })),
  http.get('*/api/brain/rate-limits', () => HttpResponse.json(null)),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; processFetches = 0; localStorage.clear(); });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

async function renderSurface(telemetryShown: boolean | undefined): Promise<{ showRail: (shown: boolean) => void }> {
  const { wrapper: Wrapper } = createWrapper();
  const tree = (shown: boolean | undefined) => (
    <Wrapper><ToastProvider><BrainChatProvider>
      <BrainChatSurface variant="full" telemetryShown={shown} />
    </BrainChatProvider></ToastProvider></Wrapper>
  );
  const view = render(tree(telemetryShown));
  await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0));
  const es = FakeES.instances[0]!;
  es.emit('process', { processes: [process1] });
  es.emit('tool', { type: 'tool', name: 'Delegate', id: 'call-1' });
  es.emit('subagent', {
    type: 'subagent', id: 'call-1', sessionId: 'brain-sub-1', status: 'running',
    task: 'sleep 50', tools: 1, seconds: 3,
  });
  await waitFor(() => expect(processFetches).toBeGreaterThan(0));
  return { showRail: (shown: boolean) => act(() => view.rerender(tree(shown))) };
}

describe('live work is reported in one place', () => {
  it('keeps the transcript copies when there is no docked rail', async () => {
    await renderSurface(undefined);

    expect(await screen.findByText('Background processes')).toBeInTheDocument();
    expect(await screen.findByText(/1 agent/)).toBeInTheDocument();
  });

  it('keeps the transcript copies when the rail is hidden', async () => {
    await renderSurface(false);

    expect(await screen.findByText('Background processes')).toBeInTheDocument();
    expect(await screen.findByText(/1 agent/)).toBeInTheDocument();
  });

  it('drops the transcript copies once the rail takes over, and restores them when it closes', async () => {
    // Start with the rail closed so BOTH copies are on screen first. Asserting they are absent from a fresh
    // render would also pass if the process and agent data had simply never arrived — the in-transcript
    // panel is itself what fetches the process list, so a hidden one means nothing is fetched at all.
    const { showRail } = await renderSurface(false);
    expect(await screen.findByText('Background processes')).toBeInTheDocument();
    expect(await screen.findByText(/1 agent/)).toBeInTheDocument();

    showRail(true);
    await waitFor(() => expect(screen.queryByText('Background processes')).toBeNull());
    expect(screen.queryByText(/1 agent/)).toBeNull();

    showRail(false);
    expect(await screen.findByText('Background processes')).toBeInTheDocument();
    expect(await screen.findByText(/1 agent/)).toBeInTheDocument();
  });
});
