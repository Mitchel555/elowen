import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChat } from '../../../modules/advisor/BrainChat';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';

/** EventSource stand-in — the surface only needs the stream to exist and to be drivable by hand. */
class FakeES {
  static instances: FakeES[] = [];
  private listeners = new Map<string, ((e: { data?: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() { /* nothing to tear down */ }
  emit(obj: Record<string, unknown>) {
    for (const fn of this.listeners.get(obj['type'] as string) ?? []) fn({ data: JSON.stringify(obj) });
  }
}

let sendBodies: Record<string, unknown>[] = [];
let renameCalls: { id: string; title: string }[] = [];

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.post('*/api/brain/send', async ({ request }) => { sendBodies.push((await request.json()) as Record<string, unknown>); return HttpResponse.json({ ok: true }, { status: 202 }); }),
  http.get('*/api/brain/messages', ({ request }) => new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([])),
  http.get('*/api/brain/status', () => HttpResponse.json({ running: true, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([{ id: 'brain-1', title: 'Katalog dílů', model: 'm', updated_at: '2026-07-08', active: true, attached: 0 }])),
  http.patch('*/api/brain/sessions/:id', async ({ request, params }) => {
    const body = (await request.json()) as { title: string };
    renameCalls.push({ id: String(params['id']), title: body.title });
    return HttpResponse.json({ id: params['id'], title: body.title });
  }),
  // The catalog the daemon publishes for the web surface (single source of truth).
  http.get('*/api/brain/commands', () => HttpResponse.json({
    commands: [
      { name: 'plan', description: 'Plan mode', kind: 'mode' },
      { name: 'build', description: 'Build mode', kind: 'mode' },
      { name: 'workflow', description: 'Workflow mode', kind: 'mode' },
      { name: 'rename', description: 'Rename this conversation', kind: 'picker' },
    ],
  })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; sendBodies = []; renameCalls = []; vi.restoreAllMocks(); });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

function renderChat() {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider><BrainChatProvider><BrainChat /></BrainChatProvider></ToastProvider></Wrapper>);
}

/** Run a slash command through the composer's menu, exactly as the user does. */
async function runSlash(name: string) {
  const composer = await screen.findByRole('textbox');
  act(() => fireEvent.change(composer, { target: { value: `/${name}` } }));
  const menu = await screen.findByTestId('chat-slash-menu');
  const item = await within(menu).findByText(`/${name}`);
  await act(async () => { fireEvent.mouseDown(item); });
}

async function send(text: string) {
  const composer = await screen.findByRole('textbox');
  act(() => fireEvent.change(composer, { target: { value: text } }));
  await act(async () => { fireEvent.click(screen.getByTestId('chat-send')); });
}

describe('web slash commands: work mode + rename', () => {
  it('sends in build mode by default and shows no mode pill', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    await send('ahoj');
    await waitFor(() => expect(sendBodies.length).toBe(1));
    expect(sendBodies[0]).toMatchObject({ mode: 'build' });
    expect(screen.queryByTestId('chat-work-mode')).toBeNull();
  });

  it('/plan switches the work mode, shows it, and stamps every following send', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    await runSlash('plan');
    expect(await screen.findByTestId('chat-work-mode')).toBeInTheDocument();
    await send('rozmysli to');
    await waitFor(() => expect(sendBodies.length).toBe(1));
    expect(sendBodies[0]).toMatchObject({ text: 'rozmysli to', mode: 'plan' });

    // …and back: /build clears the pill and the stamp returns to build.
    await runSlash('build');
    await waitFor(() => expect(screen.queryByTestId('chat-work-mode')).toBeNull());
    await send('do it');
    await waitFor(() => expect(sendBodies.length).toBe(2));
    expect(sendBodies[1]).toMatchObject({ mode: 'build' });
  });

  it('/workflow stamps the workflow mode', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    await runSlash('workflow');
    await send('rozděl to');
    await waitFor(() => expect(sendBodies.length).toBe(1));
    expect(sendBodies[0]).toMatchObject({ mode: 'workflow' });
  });

  it('/rename opens a dialog prefilled with the conversation title and PATCHes the new one', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    await screen.findByText('Katalog dílů');
    await runSlash('rename');
    const dialog = await screen.findByRole('dialog');
    const field = within(dialog).getByRole('textbox');
    expect(field).toHaveValue('Katalog dílů');
    act(() => fireEvent.change(field, { target: { value: '  Objednávky  ' } }));
    await act(async () => { fireEvent.keyDown(field, { key: 'Enter' }); });
    await waitFor(() => expect(renameCalls).toEqual([{ id: 'brain-1', title: 'Objednávky' }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('offers the plan decision once a plan is submitted and implements it in build mode', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    await runSlash('plan');
    const es = FakeES.instances[0]!;
    act(() => {
      es.emit({ type: 'tool', name: 'ExitPlanMode', id: 'call-1' });
      es.emit({ type: 'tool_end', id: 'call-1', plan: '1. read\n2. write' });
      es.emit({ type: 'idle' });
    });
    const implement = await screen.findByTestId('chat-plan-decision');
    await act(async () => { fireEvent.click(implement.querySelector('button')!); });
    await waitFor(() => expect(sendBodies.length).toBe(1));
    expect(sendBodies[0]).toMatchObject({ text: 'Implement the plan you proposed above.', mode: 'build' });
    // Approving leaves plan mode, so the decision row and the mode pill are gone.
    await waitFor(() => expect(screen.queryByTestId('chat-plan-decision')).toBeNull());
    expect(screen.queryByTestId('chat-work-mode')).toBeNull();
  });
});
