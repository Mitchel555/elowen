import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { createWrapper } from '../../test-utils';
import type { MemoryVitalityHistory } from '../../../lib/types';

const history = vi.fn();

vi.mock('../../../lib/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMemoryVitalityHistory: (id: number | null) => history(id),
}));

import { MemoryVitalityChart } from '../../../modules/memory/MemoryVitalityChart';

const NOW = '2026-08-04T12:00:00.000Z';

const curve = (over: Partial<MemoryVitalityHistory> = {}): MemoryVitalityHistory => ({
  points: [
    { at: '2026-07-20T12:00:00.000Z', vitality: 90 },
    { at: '2026-07-28T12:00:00.000Z', vitality: 74 },
    { at: NOW, vitality: 61 },
  ],
  forecast: [
    { at: NOW, vitality: 61 },
    { at: '2026-08-20T12:00:00.000Z', vitality: 38 },
  ],
  recalls: ['2026-07-28T12:00:00.000Z'],
  floor: 10,
  evictAt: '2026-09-15T12:00:00.000Z',
  historyFrom: '2026-07-20T12:00:00.000Z',
  now: NOW,
  ...over,
});

const loaded = (data: MemoryVitalityHistory) => ({ data, isLoading: false, isError: false });

beforeEach(() => {
  history.mockReset();
  history.mockReturnValue(loaded(curve()));
});

const renderChart = (vitality = 61) =>
  render(<MemoryVitalityChart memoryId={1} vitality={vitality} />, { wrapper: createWrapper().wrapper });

describe('MemoryVitalityChart', () => {
  it('draws the reconstructed past solid and the forecast dashed', async () => {
    const { container } = renderChart();
    await waitFor(() => expect(container.querySelector('svg')).toBeInTheDocument());

    const paths = [...container.querySelectorAll('path')];
    expect(paths).toHaveLength(2);
    // The past must be readable as fact and the forecast as a guess; the dash is the only thing saying so.
    expect(paths[0]?.getAttribute('stroke-dasharray')).toBeNull();
    expect(paths[1]?.getAttribute('stroke-dasharray')).not.toBeNull();
  });

  it('marks every recall inside the window', async () => {
    history.mockReturnValue(loaded(curve({
      recalls: ['2026-07-22T12:00:00.000Z', '2026-07-28T12:00:00.000Z'],
    })));
    const { container } = renderChart();
    await waitFor(() => expect(container.querySelector('svg')).toBeInTheDocument());

    expect(container.querySelectorAll('circle')).toHaveLength(2);
  });

  it('says when the memory would be binned, and carries it into the label for screen readers', async () => {
    renderChart(61);
    await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument());

    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('61/100');
    // The rendered date follows the active locale, so pin the sentence and the year, not the format.
    expect(screen.getByText(/Moves to the trash on .*2026/)).toBeInTheDocument();
  });

  it('states plainly that a pinned memory is never deleted', async () => {
    history.mockReturnValue(loaded(curve({ evictAt: null })));
    renderChart();

    await waitFor(() => expect(screen.getByText('Never deleted automatically')).toBeInTheDocument());
  });

  // A memory used before the log existed cannot have its past reconstructed. Saying so is the point —
  // the alternative is a chart that looks complete while inventing the part it cannot know.
  it('admits when there is no reconstructable history instead of drawing one', async () => {
    history.mockReturnValue(loaded(curve({ points: [], historyFrom: null })));
    const { container } = renderChart();
    await waitFor(() => expect(container.querySelector('svg')).toBeInTheDocument());

    expect(container.querySelectorAll('path')).toHaveLength(1);
    expect(screen.getByText(/only the forecast is shown/)).toBeInTheDocument();
  });

  it('stays out of the way when the curve cannot be loaded', () => {
    history.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    const { container } = renderChart();

    expect(container).toBeEmptyDOMElement();
  });
});
