import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import type { Memory, MemoryCategory } from '../../../lib/types';

/** The "Used" column answers "how long since this memory was last read", so it stays relative at every
 *  distance. `formatTaskTime` deliberately switches to an absolute date past a day, which is why this
 *  column formats with `compactElapsed` instead — the tests below pin that difference. */
const memories = vi.fn();
const categories = vi.fn();

vi.mock('../../../lib/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMemories: (filters?: unknown) => memories(filters),
  useMemoryCategories: () => categories(),
}));

vi.mock('../../../lib/mutations', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useCreateMemory: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useMergeMemories: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useDeleteMemory: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useRestoreMemory: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  usePurgeMemories: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useEmptyTrash: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useSetMemoryCategory: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));

import { MemoryView } from '../../../modules/memory/MemoryView';

const mem = (over: Partial<Memory>): Memory => ({
  id: 1, user_id: 1, body: 'body', kind: 'fact', importance: 3, confidence: 1, source: 'user',
  status: 'active', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  last_used_at: null, use_count: 0, category_id: null, vitality: 50, ...over,
});

const rows = (list: Memory[]) => ({ data: list, isError: false, isLoading: false, refetch: vi.fn() });
const cats = (list: MemoryCategory[] = []) => ({ data: list, isError: false, isLoading: false, refetch: vi.fn() });

const agoIso = (ms: number): string => new Date(Date.now() - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Stamps are built from the current clock, so the rendered elapsed value is stable regardless of when
 *  the suite runs — a memory read "3 hours before now" always formats as "3h". */
const memorySet = (): Memory[] => [
  mem({ id: 1, body: 'read recently', last_used_at: agoIso(3 * HOUR), use_count: 5 }),
  mem({ id: 2, body: 'never read', last_used_at: null, use_count: 0 }),
  mem({ id: 3, body: 'long forgotten', last_used_at: agoIso(40 * DAY), use_count: 2 }),
];

beforeEach(() => {
  memories.mockReset();
  categories.mockReset();
  memories.mockImplementation(() => rows(memorySet()));
  categories.mockReturnValue(cats());
});

const renderView = () => render(<ToastProvider><MemoryView /></ToastProvider>, { wrapper: createWrapper().wrapper });

const usedCellOf = (body: string): string => {
  const row = screen.getAllByTestId('memory-row').find((r) => (r.textContent ?? '').includes(body));
  if (!row) throw new Error(`no row for ${body}`);
  return within(row).getByTestId('memory-used-cell').textContent ?? '';
};

describe('MemoryView used column', () => {
  it('shows the elapsed time since the last recall, relative at every distance', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('read recently')).toBeInTheDocument());

    expect(usedCellOf('read recently')).toContain('3h');
    // Past a day `formatTaskTime` would render a calendar date ("12 Jun 10:00"); this column must not.
    expect(usedCellOf('long forgotten')).toContain('40d');
    expect(usedCellOf('long forgotten')).not.toMatch(/\d{2}:\d{2}/);
  });

  it('marks a memory that was never recalled instead of showing an epoch', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('never read')).toBeInTheDocument());

    expect(usedCellOf('never read')).toContain('—');
  });

  it('sorts by recall recency, putting the never-read memory at the stale end', async () => {
    renderView();
    await waitFor(() => expect(screen.getByText('read recently')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Used' }));
    await waitFor(() => {
      const bodies = screen.getAllByTestId('memory-row').map((r) => r.textContent ?? '');
      expect(bodies[0]).toContain('read recently');
      expect(bodies[2]).toContain('never read');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Used' }));
    await waitFor(() => {
      const bodies = screen.getAllByTestId('memory-row').map((r) => r.textContent ?? '');
      expect(bodies[0]).toContain('never read');
      expect(bodies[2]).toContain('read recently');
    });
  });
});
