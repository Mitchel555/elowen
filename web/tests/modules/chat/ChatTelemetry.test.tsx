import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import { ChatView } from '../../../modules/chat/ChatView';

class FakeES {
  static instances: FakeES[] = [];
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener() {}
  close() {}
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
    expect(screen.queryByTestId('telemetry-column')).toBeNull();
  });
});
