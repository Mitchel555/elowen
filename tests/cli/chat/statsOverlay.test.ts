import { describe, expect, it, vi } from 'vitest';
import { openStatsOverlay } from '../../../src/cli/chat/statsOverlay.js';
import type { ModelUsageView } from '../../../src/cli/chat/brainClient.js';

interface Overlay { render(width: number): string[]; handleInput(data: string): void }

/** Render the Models section of the overlay and return its Σ row, stripped of styling. */
function sigmaRow(models: ModelUsageView[]): string {
  const shown: Overlay[] = [];
  const tui = {
    terminal: { columns: 120 },
    setFocus: vi.fn(),
    requestRender: vi.fn(),
    showOverlay: vi.fn((c: Overlay) => { shown.push(c); return { hide: vi.fn(), focus: vi.fn() }; }),
  };
  openStatsOverlay({ tui: tui as never, editor: {} as never, data: { model: 'm', usage: null, models } });
  const overlay = shown[0]!;
  overlay.handleInput('\x1b[C'); // ←/→ cycles Conversation → Models
  const lines = overlay.render(100).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  return lines.find((l) => l.includes('Σ')) ?? '';
}

const model = (exec: string, usage: Partial<ModelUsageView['usage']>): ModelUsageView => ({
  exec,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costUsd: null, ...usage },
});

describe('stats overlay — Σ speed', () => {
  it('weights the average by each model MEASURED output, not its total output', () => {
    // x timed only 10k of its 1.01M output (200 s → 50 tok/s); y timed all 20k (200 s → 100 tok/s).
    // Duration-weighted: 30k over 400 s = 75 tok/s. Weighting by TOTAL output would yield ~50.
    expect(sigmaRow([
      model('elowen:x', { output: 1_010_000, total: 1_010_000, outputTps: 50, measuredOutput: 10_000 }),
      model('elowen:y', { output: 20_000, total: 20_000, outputTps: 100, measuredOutput: 20_000 }),
    ])).toMatch(/\s75\s/);
  });

  it('dashes the average when no model carries the measured pair (older daemon)', () => {
    // Costed, so the only dash the row can show is the unweightable speed.
    const row = sigmaRow([model('elowen:x', { output: 100, total: 100, costUsd: 1.5, outputTps: 40 })]);
    expect(row).toContain('—');
    expect(row).not.toMatch(/\s40\s/);
  });
});
