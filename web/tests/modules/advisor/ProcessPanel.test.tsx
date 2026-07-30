import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ProcessPanel } from '../../../modules/advisor/ProcessPanel';
import type { ProcessInfo } from '../../../lib/types';

const proc = (id: string, command: string, sessionId: string | null): ProcessInfo => ({
  id, command, cwd: '/w', startedAt: '2026-01-01T00:00:00Z', sessionId, running: true, exitCode: null,
});

// The API list is owner-wide (every process the operator owns across sessions), but the transcript panel
// filters it to the OPEN conversation so a job from another chat, a channel or a sub-agent does not leak
// into it. The owner-wide view (which reaches a service an orphaned delegate left behind) is the rail's.
const processes: ProcessInfo[] = [
  proc('own', 'npm run dev', 'brain-1'),
  proc('other', 'python train.py', 'brain-7'),
  proc('sub', 'npm run watch', 'brain-ch-subagent-sub-dlg-9'),
  proc('chan', 'tail -f log', 'brain-ch-discord-42'),
];
const killed: string[] = [];
const server = setupServer(
  http.get('*/api/brain/processes', () => HttpResponse.json(processes)),
  http.delete('*/api/brain/processes/:id', ({ params }) => { killed.push(String(params['id'])); return HttpResponse.json({ killed: true }); }),
);

beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => { server.resetHandlers(); killed.length = 0; });
afterAll(() => server.close());

describe('ProcessPanel', () => {
  it('shows only the processes the open conversation started, not the owner-wide list', async () => {
    const { wrapper } = createWrapper();
    render(<ProcessPanel activeSessionId="brain-1" />, { wrapper });

    expect(await screen.findByTitle('npm run dev')).toBeInTheDocument();
    // A job from another chat, a sub-agent or a channel must NOT leak into this conversation's panel.
    expect(screen.queryByTitle('python train.py')).not.toBeInTheDocument();
    expect(screen.queryByTitle('npm run watch')).not.toBeInTheDocument();
    expect(screen.queryByTitle('tail -f log')).not.toBeInTheDocument();
  });

  it('follows the conversation on screen: a row local in one chat is absent in another', async () => {
    const { wrapper } = createWrapper();
    render(<ProcessPanel activeSessionId="brain-7" />, { wrapper });

    // Viewing brain-7: its own process shows, and brain-1's drops out of the panel entirely.
    expect(await screen.findByTitle('python train.py')).toBeInTheDocument();
    expect(screen.queryByTitle('npm run dev')).not.toBeInTheDocument();
  });

  it('kills a local process straight from the panel', async () => {
    const { wrapper } = createWrapper();
    render(<ProcessPanel activeSessionId="brain-1" />, { wrapper });
    await screen.findByTitle('npm run dev');

    // brain-1 has exactly one local process, so its is the only kill button in the panel.
    fireEvent.click(screen.getByRole('button', { name: 'Kill process' }));

    await waitFor(() => expect(killed).toEqual(['own']));
  });
});
