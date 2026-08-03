import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createWrapper } from '../../test-utils';
import type { RetrievalResult } from '../../../lib/types';

const retrievalDebug = vi.fn();

vi.mock('../../../lib/elowenClient', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  elowenClient: { retrievalDebug: (q: string) => retrievalDebug(q) },
}));

import { RetrievalDebugPanel } from '../../../modules/memory/RetrievalDebugPanel';

const result = (fallback: boolean, provider: string | null): RetrievalResult => ({
  memories: [],
  debug: { query: 'q', fallback, provider, model: provider ? 'm' : null, candidates: 0, scores: [] },
});

const runQuery = async (res: RetrievalResult): Promise<void> => {
  retrievalDebug.mockResolvedValueOnce(res);
  render(<RetrievalDebugPanel />, { wrapper: createWrapper().wrapper });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'deployment' } });
  fireEvent.click(screen.getByRole('button', { name: 'Run retrieval' }));
};

const WARNING = 'Fallback — embeddings unconfigured, using keyword matching.';
const KEYWORD_NOTE = 'Semantic search returned no match above the threshold — showing keyword results.';

describe('RetrievalDebugPanel fallback notice', () => {
  it('warns "embeddings unconfigured" only when no provider is present', async () => {
    await runQuery(result(true, null));
    await waitFor(() => expect(screen.getByText(WARNING)).toBeInTheDocument());
    expect(screen.queryByText(KEYWORD_NOTE)).not.toBeInTheDocument();
  });

  it('shows a neutral keyword note (never the unconfigured warning) when embeddings ran but cleared the floor', async () => {
    // Provider is set → embeddings ARE configured; keyword only answered because nothing beat the floor.
    // The scary "unconfigured" banner here is exactly the bug a configured user hit.
    await runQuery(result(true, 'openrouter'));
    await waitFor(() => expect(screen.getByText(KEYWORD_NOTE)).toBeInTheDocument());
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });

  it('shows no fallback notice when the vector path answered', async () => {
    await runQuery(result(false, 'openrouter'));
    await waitFor(() => expect(screen.getByText('0 recalled')).toBeInTheDocument());
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
    expect(screen.queryByText(KEYWORD_NOTE)).not.toBeInTheDocument();
  });
});
