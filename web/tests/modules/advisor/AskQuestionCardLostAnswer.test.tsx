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

/** Regression for synthesis Tier 1 #9: `AskQuestionCard` used to lock the whole form the instant submit
 *  was clicked and the provider swallowed a failed `/brain/answer` and removed the question anyway — on a
 *  network error the agent kept waiting server-side while the user lost the question with no way to
 *  retry short of a reconnect or reload. The fix makes the submit path await the request: the question
 *  stays until the server actually confirms, and a failure re-enables the form. */

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

let answerShouldFail = true;
let answerCalls = 0;

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.get('*/api/brain/messages', ({ request }) => (new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([]))),
  http.get('*/api/brain/status', () => HttpResponse.json({
    running: true, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [],
  })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
  http.post('*/api/brain/answer', () => {
    answerCalls += 1;
    if (answerShouldFail) return HttpResponse.json({ error: 'boom' }, { status: 500 });
    return HttpResponse.json({ ok: true, matched: true });
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; answerShouldFail = true; answerCalls = 0; });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

async function renderChat(): Promise<FakeES> {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><BrainChatProvider><BrainChat /></BrainChatProvider></ToastProvider></Wrapper>);
  await waitFor(() => expect(FakeES.instances.length).toBe(1));
  return FakeES.instances[0]!;
}

describe('AskUserQuestion survives a failed /brain/answer', () => {
  it('keeps the question, re-enables the form and tells the user when the request fails', async () => {
    const es = await renderChat();
    es.emit('ask', { id: 'q1', questions: [question] });
    await screen.findByText('Kterou variantu?');

    fireEvent.click(screen.getByRole('radio', { name: 'Modrou' }));
    fireEvent.click(screen.getByRole('button', { name: en.brainChat.askSubmit }));

    // The request was made and rejected, but the question is still on screen — nothing was lost.
    await waitFor(() => expect(answerCalls).toBe(1));
    expect(screen.getByText('Kterou variantu?')).toBeInTheDocument();
    expect(await screen.findByText(en.brainChat.askError)).toBeInTheDocument();

    // The form re-enabled: the picked option is still selectable/submittable, not stuck disabled.
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Modrou' })).not.toBeDisabled());
    expect(screen.getByRole('button', { name: en.brainChat.askSubmit })).not.toBeDisabled();

    // Retrying with the server now accepting the answer clears the question — proving the retry path works.
    answerShouldFail = false;
    fireEvent.click(screen.getByRole('button', { name: en.brainChat.askSubmit }));
    await waitFor(() => expect(answerCalls).toBe(2));
    await waitFor(() => expect(screen.queryByText('Kterou variantu?')).toBeNull());
  });
});
