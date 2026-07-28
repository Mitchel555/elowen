import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { useWriteProjectFile } from '../../lib/mutations';

// The first write is answered slowly, the second quickly: if both are allowed in flight at once the
// slow (older) response settles last and its cache update wins.
const DELAYS: Record<string, number> = { first: 60, second: 5 };
let completed: string[] = [];
const server = setupServer(
  http.put('*/api/projects/:id/file', async ({ request }) => {
    const body = (await request.json()) as { path: string; content: string };
    await new Promise((resolve) => setTimeout(resolve, DELAYS[body.content] ?? 0));
    completed.push(body.content);
    return HttpResponse.json({ ok: true });
  }),
);
beforeAll(() => server.listen());
beforeEach(() => { completed = []; });
afterAll(() => server.close());

describe('useWriteProjectFile ordering', () => {
  // Cmd+S is not gated on `write.isPending`, so a user can fire a second save before the first
  // returns. Out of order, the older write's response overwrites the file cache with the older
  // content — the editor then shows text the user already replaced.
  it('never lets an older write overwrite a newer one in the cache', async () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useWriteProjectFile(), { wrapper });

    result.current.mutate({ id: 5, path: 'a.ts', content: 'first' });
    result.current.mutate({ id: 5, path: 'a.ts', content: 'second' });

    await waitFor(() => expect(completed).toHaveLength(2), { timeout: 3000 });
    expect(completed).toEqual(['first', 'second']);
    expect(client.getQueryData(['project-file', 5, 'a.ts'])).toEqual({ content: 'second', truncated: false });
  });
});
