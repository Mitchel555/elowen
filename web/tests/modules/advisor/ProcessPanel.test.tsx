import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ProcessPanel } from '../../../modules/advisor/ProcessPanel';
import { ownedSessionIds } from '../../../lib/processScope';
import type { ProcessInfo } from '../../../lib/types';
import type { SubagentState } from '../../../lib/transcript';

const proc = (id: string, command: string, sessionId: string | null): ProcessInfo => ({
  id, command, cwd: '/w', startedAt: '2026-01-01T00:00:00Z', sessionId, running: true, exitCode: null,
});
const agent = (sessionId: string): SubagentState => ({ sessionId, status: 'running', task: 'build', tools: 0, seconds: 1 });

// The API list is owner-wide (every process the operator owns across sessions), but the transcript panel
// narrows it to the OPEN conversation so a job from another chat or a channel does not leak into it. Those
// stay reachable in the telemetry rail's "other processes" section, which is where an orphaned delegate's
// leftover service gets killed from.
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
    render(<ProcessPanel owned={ownedSessionIds('brain-1', [])} />, { wrapper });

    expect(await screen.findByTitle('npm run dev')).toBeInTheDocument();
    // A job from another chat or a channel must NOT leak into this conversation's panel.
    expect(screen.queryByTitle('python train.py')).not.toBeInTheDocument();
    expect(screen.queryByTitle('tail -f log')).not.toBeInTheDocument();
  });

  it('shows a job started by this conversation own sub-agent', async () => {
    const { wrapper } = createWrapper();
    render(<ProcessPanel owned={ownedSessionIds('brain-1', [agent('brain-ch-subagent-sub-dlg-9')])} />, { wrapper });

    // The delegate runs under its own session id, but its background job is this conversation's live work.
    expect(await screen.findByTitle('npm run watch')).toBeInTheDocument();
    expect(screen.queryByTitle('python train.py')).not.toBeInTheDocument();
  });

  it('follows the conversation on screen: a row local in one chat is absent in another', async () => {
    const { wrapper } = createWrapper();
    render(<ProcessPanel owned={ownedSessionIds('brain-7', [])} />, { wrapper });

    // Viewing brain-7: its own process shows, and brain-1's drops out of the panel entirely.
    expect(await screen.findByTitle('python train.py')).toBeInTheDocument();
    expect(screen.queryByTitle('npm run dev')).not.toBeInTheDocument();
  });

  it('kills a local process straight from the panel', async () => {
    const { wrapper } = createWrapper();
    render(<ProcessPanel owned={ownedSessionIds('brain-1', [])} />, { wrapper });
    await screen.findByTitle('npm run dev');

    // brain-1 has exactly one local process, so its is the only kill button in the panel.
    fireEvent.click(screen.getByRole('button', { name: 'Kill process' }));

    await waitFor(() => expect(killed).toEqual(['own']));
  });
});
