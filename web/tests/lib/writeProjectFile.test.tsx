import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { useWriteProjectFile } from '../../lib/mutations';

// Every write is held open until the test releases it: the interleaving is what these tests assert,
// and real delays would let a loaded CI box pass them without any actual serialization.
let started: string[] = [];
let completed: string[] = [];
const gates = new Map<string, () => void>();
const server = setupServer(
  http.put('*/api/projects/:id/file', async ({ request }) => {
    const body = (await request.json()) as { path: string; content: string };
    const key = `${body.path}:${body.content}`;
    started.push(key);
    await new Promise<void>((resolve) => gates.set(key, resolve));
    completed.push(key);
    return HttpResponse.json({ ok: true });
  }),
);
beforeAll(() => server.listen());
beforeEach(() => { started = []; completed = []; gates.clear(); });
afterAll(() => server.close());

async function release(key: string) {
  const gate = gates.get(key);
  if (!gate) throw new Error(`no write in flight for ${key}`);
  gate();
  await waitFor(() => expect(completed).toContain(key));
}
/** Give any queued request a real chance to reach the server before asserting that it did not. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function renderWrite() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, ...renderHook(() => useWriteProjectFile(), { wrapper }) };
}

describe('useWriteProjectFile ordering', () => {
  // Cmd+S is not gated on `write.isPending`, so a user can fire a second save before the first
  // returns. Out of order, the older write's response overwrites the file cache with the older
  // content — the editor then shows text the user already replaced.
  it('never lets an older write of the same file overwrite a newer one', async () => {
    const { client, result } = renderWrite();

    result.current.mutate({ id: 5, path: 'a.ts', content: 'first' });
    result.current.mutate({ id: 5, path: 'a.ts', content: 'second' });

    await waitFor(() => expect(started).toEqual(['a.ts:first']));
    await settle();
    expect(started).toEqual(['a.ts:first']);

    await release('a.ts:first');
    await waitFor(() => expect(started).toEqual(['a.ts:first', 'a.ts:second']));
    await release('a.ts:second');

    expect(completed).toEqual(['a.ts:first', 'a.ts:second']);
    await waitFor(() => expect(client.getQueryData(['project-file', 5, 'a.ts'])).toEqual({ content: 'second', truncated: false }));
  });

  // Serialization exists to protect one file from itself. Two different files (or projects) share
  // nothing, so a slow save must not hold the other one back.
  it('saves different files in parallel', async () => {
    const { client, result } = renderWrite();

    result.current.mutate({ id: 5, path: 'a.ts', content: 'slow' });
    result.current.mutate({ id: 5, path: 'b.ts', content: 'quick' });
    result.current.mutate({ id: 6, path: 'a.ts', content: 'other project' });

    await waitFor(() => expect(started).toHaveLength(3));

    await release('b.ts:quick');
    await release('a.ts:other project');
    await waitFor(() => expect(client.getQueryData(['project-file', 5, 'b.ts'])).toEqual({ content: 'quick', truncated: false }));
    await waitFor(() => expect(client.getQueryData(['project-file', 6, 'a.ts'])).toEqual({ content: 'other project', truncated: false }));

    await release('a.ts:slow');
  });

  // A rejected write must not wedge the queue for that file — the next save has to go out.
  it('keeps saving a file after one of its writes fails', async () => {
    server.use(http.put('*/api/projects/:id/file', async () => {
      started.push('a.ts:boom');
      return HttpResponse.json({ error: 'boom' }, { status: 500 });
    }, { once: true }));
    const { result } = renderWrite();

    result.current.mutate({ id: 5, path: 'a.ts', content: 'fails' });
    await waitFor(() => expect(started).toEqual(['a.ts:boom']));

    result.current.mutate({ id: 5, path: 'a.ts', content: 'after' });
    await waitFor(() => expect(started).toEqual(['a.ts:boom', 'a.ts:after']));
    await release('a.ts:after');
  });
});
