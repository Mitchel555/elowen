import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import { ChatView } from '../../../modules/chat/ChatView';

class FakeES {
  static instances: FakeES[] = [];
  private listeners = new Map<string, ((e: { data?: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
  /** Push one SSE frame at the provider, so a test can assert what a MID-TURN event does to the rail. */
  emit(type: string, data: unknown) {
    act(() => { for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) }); });
  }
}

/** The extended /brain/status payload: usage + project + LSP + MCP, all from the one poll. */
const STATUS = {
  running: true, sessionId: 'brain-1', model: 'm', statusline: null, cards: [], queued: [],
  usage: { tokens: 42_000, contextWindow: 200_000, percent: 21, totalTokens: 51_000, cost: 1.2345 },
  project: { cwd: '/var/www/elowen', branch: 'dev' },
  lspEnabled: true,
  mcp: [{ name: 'chrome-devtools', status: 'connected' }, { name: 'sleepy', status: 'disconnected' }],
};

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.get('*/api/brain/messages', ({ request }) => new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([])),
  http.get('*/api/brain/status', () => HttpResponse.json(STATUS)),
  http.get('*/api/brain/rate-limits', () => HttpResponse.json({
    provider: 'openai-codex', planType: 'pro', fetchedAt: 0, stale: false,
    windows: [{ usedPercent: 64, windowMinutes: 300, resetsAt: null }],
  })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([
    { id: 'brain-1', title: 'First chat', model: 'm', updated_at: '2026-07-08', running: false, active: true },
  ])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

/** Drive useMobile()'s `(max-width: 767px)` media query. */
function setViewport(mobile: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: mobile, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  } as MediaQueryList));
}

/** Watch whether a node matching `selector` was EVER in the document — a query run after render cannot
 *  see a variant that the first commit mounted and the next one dropped. Both sides of every mutation are
 *  inspected: a node mounted inside a bigger inserted subtree has no record of its own, but its later
 *  removal does name it (and a detached node keeps its own subtree, so the match still holds). */
function watchMounts(selector: string): () => boolean {
  let mounted = false;
  const hit = (nodes: NodeList): boolean => {
    for (const node of nodes) {
      if (node instanceof HTMLElement && (node.matches(selector) || node.querySelector(selector))) return true;
    }
    return false;
  };
  // Accumulate in the callback: the observer DRAINS its queue when it delivers, so a later takeRecords()
  // would come back empty for everything that already fired.
  const scan = (records: MutationRecord[]): void => {
    for (const r of records) if (hit(r.addedNodes) || hit(r.removedNodes)) mounted = true;
  };
  const observer = new MutationObserver(scan);
  observer.observe(document.body, { childList: true, subtree: true });
  return () => {
    scan(observer.takeRecords());
    observer.disconnect();
    return mounted;
  };
}

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; vi.restoreAllMocks(); });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

function renderChat(node: ReactNode) {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider><BrainChatProvider>{node}</BrainChatProvider></ToastProvider></Wrapper>);
}

describe('chat telemetry panel', () => {
  it('renders the desktop column with context, limits, project, MCP and LSP', async () => {
    setViewport(false);
    renderChat(<ChatView />);
    expect(await screen.findByTestId('telemetry-column')).toBeInTheDocument();

    // Context fill comes from the status poll's usage numbers.
    const context = await screen.findByTestId('telemetry-context');
    expect(context.textContent).toContain('21%');
    expect(context.textContent).toContain('42k / 200k');
    expect(context.textContent).toContain('$1.23');

    // Project: the daemon-reported directory and its git branch — neither existed on the wire before.
    const project = screen.getByTestId('telemetry-project');
    expect(project.textContent).toContain('/var/www/elowen');
    expect(project.textContent).toContain('dev');

    // Only CONNECTED MCP servers are listed, with a connected/total count.
    const mcp = screen.getByTestId('telemetry-mcp');
    expect(mcp.textContent).toContain('chrome-devtools');
    expect(mcp.textContent).not.toContain('sleepy');
    expect(mcp.textContent).toContain('1/2');

    expect(screen.getByTestId('telemetry-lsp').textContent).toMatch(/Active|Aktivní/);

    // Subscription limits ride their own slower endpoint, not the hot status poll.
    await waitFor(() => expect(screen.getByTestId('telemetry-limits').textContent).toContain('64%'));
  });

  // Regression: the daemon emits a `step` frame carrying a fresh usage snapshot on every model
  // round-trip, precisely so a client does not have to wait for `idle`. The web provider had no handler
  // for it, so the frame was dropped and the rail (and the composer statusline, which reads the same
  // state) showed the PREVIOUS turn's numbers for the whole turn. The CLI never had this problem.
  it('refreshes context, tokens and cost mid-turn from a step frame, not only once the turn settles', async () => {
    setViewport(false);
    renderChat(<ChatView />);
    const context = await screen.findByTestId('telemetry-context');
    expect(context.textContent).toContain('21%'); // the opening numbers, from /brain/status

    FakeES.instances[0]!.emit('step', {
      type: 'step', step: 2, maxSteps: 25,
      usage: { tokens: 120_000, contextWindow: 200_000, percent: 60, totalTokens: 130_000, cost: 3.5 },
    });

    await waitFor(() => expect(screen.getByTestId('telemetry-context').textContent).toContain('60%'));
    const live = screen.getByTestId('telemetry-context').textContent ?? '';
    expect(live).toContain('120k / 200k');
    expect(live).toContain('$3.50');
    expect(live).not.toContain('21%'); // genuinely replaced, not rendered alongside the stale figure
  });

  it('ignores a step frame that carries no usage, leaving the last known numbers standing', async () => {
    setViewport(false);
    renderChat(<ChatView />);
    expect((await screen.findByTestId('telemetry-context')).textContent).toContain('21%');
    // `usage` is optional on the event — a step without it must not blank the rail.
    FakeES.instances[0]!.emit('step', { type: 'step', step: 3, maxSteps: 25 });
    // Settle inside act: the rail's own background queries land during this wait, and React would
    // otherwise warn about a state update escaping the test's control.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.getByTestId('telemetry-context').textContent).toContain('21%');
  });

  it('drops sections the daemon does not report instead of showing blanks', async () => {
    setViewport(false);
    server.use(
      http.get('*/api/brain/status', () => HttpResponse.json({
        ...STATUS, project: { cwd: null, branch: null }, mcp: null, lspEnabled: undefined,
      })),
      http.get('*/api/brain/rate-limits', () => HttpResponse.json(null)),
    );
    renderChat(<ChatView />);
    expect(await screen.findByTestId('telemetry-context')).toBeInTheDocument();
    expect(screen.queryByTestId('telemetry-project')).toBeNull();
    expect(screen.queryByTestId('telemetry-mcp')).toBeNull();
    expect(screen.queryByTestId('telemetry-lsp')).toBeNull();
    expect(screen.queryByTestId('telemetry-limits')).toBeNull();
  });

  it('shows the mascot atop the rail, and keeps it when every section is dropped', async () => {
    setViewport(false);
    server.use(
      http.get('*/api/brain/status', () => HttpResponse.json({
        ...STATUS, project: { cwd: null, branch: null }, mcp: null, lspEnabled: undefined, usage: null,
      })),
      http.get('*/api/brain/rate-limits', () => HttpResponse.json(null)),
    );
    renderChat(<ChatView />);
    // Even with nothing to report the rail is inhabited — the owl shows, the empty note beside it.
    expect(await screen.findByTestId('telemetry-mascot')).toBeInTheDocument();
    expect(screen.queryByTestId('telemetry-context')).toBeNull();
  });

  it('mounts NO side column on mobile — the rail opens as a drawer from the header instead', async () => {
    setViewport(true);
    renderChat(<ChatView />);
    await screen.findByPlaceholderText(/Write a message|Napište zprávu/i);
    // The narrow viewport must never carry a second column: not hidden by CSS, simply not mounted.
    expect(screen.queryByTestId('telemetry-column')).toBeNull();
    expect(screen.queryByTestId('telemetry-drawer')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Show telemetry|Zobrazit telemetrii/i }));
    const drawer = await screen.findByTestId('telemetry-drawer');
    expect(drawer).toBeInTheDocument();
    expect(screen.getByTestId('telemetry-project').textContent).toContain('/var/www/elowen');
    // The phone rail is the same living panel, not a stripped-down one: the mascot is in the drawer too.
    expect(screen.getByTestId('telemetry-mascot')).toBeInTheDocument();
    expect(screen.queryByTestId('telemetry-column')).toBeNull();
  });

  it('never mounts the desktop column on mobile — not even for the pre-effect first commit', async () => {
    setViewport(true);
    const columnWasMounted = watchMounts('[data-testid="telemetry-column"]');
    renderChat(<ChatView />);
    await screen.findByPlaceholderText(/Write a message|Napište zprávu/i);
    // The viewport is unknown on the first commit, so neither variant may be mounted yet: a phone must
    // never build the second column, run its queries and tear it down again a tick later.
    expect(columnWasMounted()).toBe(false);
  });
});
