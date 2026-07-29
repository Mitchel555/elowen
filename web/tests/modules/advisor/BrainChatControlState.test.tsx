import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChat } from '../../../modules/advisor/BrainChat';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';

// The three symptoms a user saw side by side with the CLI: a Stop button that never went away, an
// AskUserQuestion the web never rendered, and an agent chip counting history instead of running work.
// All three came from the web holding its OWN copies of state the daemon already owns, so these tests
// pin the client to the authoritative frame: whatever `control` says, the surface shows.

/** EventSource stand-in that can deliver frames to the registered listeners. */
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

const question = {
  question: 'Kterou variantu?',
  header: 'Volba',
  multiSelect: false,
  options: [{ label: 'Modrou' }, { label: 'Zelenou' }],
};

let statusAsk: { id: string; questions: typeof question[] } | null = null;

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.get('*/api/brain/messages', ({ request }) => (new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([]))),
  http.get('*/api/brain/status', () => HttpResponse.json({
    running: true, sessionId: 'brain-1', model: 'm', usage: null, statusline: null,
    cards: [], queued: [], pendingAsk: statusAsk,
  })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; statusAsk = null; });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

async function renderChat(): Promise<FakeES> {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><BrainChatProvider><BrainChat /></BrainChatProvider></ToastProvider></Wrapper>);
  await waitFor(() => expect(FakeES.instances.length).toBe(1));
  return FakeES.instances[0]!;
}

const snapshot = (over: Record<string, unknown>) => ({
  type: 'snapshot', sessionId: 'brain-1', hasMore: false, nextBefore: null, history: [], events: [], ...over,
});

describe('BrainChat control state mirrors the daemon', () => {
  it('drops the Stop button when the frame says nothing is streaming, even with a non-terminal tail', async () => {
    const es = await renderChat();
    es.emit('snapshot', snapshot({
      events: [{ type: 'step', label: 'thinking' }],
      control: { streaming: false, pendingAsk: null },
    }));
    await waitFor(() => expect(screen.queryByTestId('chat-stop')).toBeNull());
    expect(screen.queryByTestId('chat-send')).not.toBeNull();
  });

  it('revives the Stop button when the frame says a turn is streaming with an empty journal', async () => {
    const es = await renderChat();
    es.emit('snapshot', snapshot({ events: [], control: { streaming: true, pendingAsk: null } }));
    await waitFor(() => expect(screen.queryByTestId('chat-stop')).not.toBeNull());
  });

  it('shows a question parked before this client ever connected', async () => {
    const es = await renderChat();
    es.emit('snapshot', snapshot({ control: { streaming: true, pendingAsk: { id: 'q1', questions: [question] } } }));
    await screen.findByText('Kterou variantu?');
  });

  it('keeps the question when the turn reports idle', async () => {
    const es = await renderChat();
    es.emit('ask', { id: 'q1', questions: [question] });
    await screen.findByText('Kterou variantu?');
    es.emit('idle', {});
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Kterou variantu?')).not.toBeNull();
  });

  it('clears a question the frame no longer reports', async () => {
    const es = await renderChat();
    es.emit('ask', { id: 'q1', questions: [question] });
    await screen.findByText('Kterou variantu?');
    es.emit('snapshot', snapshot({ control: { streaming: false, pendingAsk: null } }));
    await waitFor(() => expect(screen.queryByText('Kterou variantu?')).toBeNull());
  });

  it('hydrates the parked question from status on connect', async () => {
    statusAsk = { id: 'q1', questions: [question] };
    await renderChat();
    await screen.findByText('Kterou variantu?');
  });

  // The question is raised on every client of the conversation, so answering it in the CLI has to take
  // the card down here too — otherwise it sits there and its answer would match nothing.
  it('drops the question when it is settled on another surface', async () => {
    const es = await renderChat();
    es.emit('ask', { id: 'q1', questions: [question] });
    await screen.findByText('Kterou variantu?');
    es.emit('ask_resolved', { id: 'q1', reason: 'answered' });
    await waitFor(() => expect(screen.queryByText('Kterou variantu?')).toBeNull());
  });

  it('ignores a resolution for a question it is not showing', async () => {
    const es = await renderChat();
    es.emit('ask', { id: 'q2', questions: [question] });
    await screen.findByText('Kterou variantu?');
    // A late frame for the PREVIOUS question must not clear the one now on screen.
    es.emit('ask_resolved', { id: 'q1', reason: 'timeout' });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Kterou variantu?')).not.toBeNull();
  });

  it('counts only running sub-agents in the chip', async () => {
    const es = await renderChat();
    es.emit('snapshot', snapshot({
      events: [
        { type: 'tool', name: 'Delegate', id: 't1' },
        { type: 'subagent', id: 't1', sessionId: 'child-1', status: 'done', task: 'hotovo', tools: 2, seconds: 3 },
      ],
      control: { streaming: false, pendingAsk: null },
    }));
    await waitFor(() => expect(screen.queryByText(/agent/)).not.toBeNull());
    expect(screen.queryByText('1 agents')).toBeNull();
    expect(screen.queryByText('1 finished agent')).not.toBeNull();
  });

  it('names one running sub-agent in the singular', async () => {
    const es = await renderChat();
    es.emit('snapshot', snapshot({
      events: [
        { type: 'tool', name: 'Delegate', id: 't1' },
        { type: 'subagent', id: 't1', sessionId: 'child-1', status: 'running', task: 'bezi', tools: 2, seconds: 3 },
      ],
      control: { streaming: true, pendingAsk: null },
    }));
    await waitFor(() => expect(screen.queryByText('1 agent')).not.toBeNull());
  });
});
