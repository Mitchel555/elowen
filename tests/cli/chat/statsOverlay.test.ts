import { describe, expect, it, vi } from 'vitest';
import { openStatsOverlay } from '../../../src/cli/chat/statsOverlay.js';
import type { BrainUsageView, ModelUsageView } from '../../../src/cli/chat/brainClient.js';
import type { BrainContextBreakdown } from '../../../src/shared/wireContract.js';

interface Overlay { render(width: number): string[]; handleInput(data: string): void }

/** Open the overlay on `section` and return its rendered lines, stripped of styling. */
function renderOverlay(o: {
  models?: ModelUsageView[];
  context?: BrainContextBreakdown | null;
  usage?: Partial<BrainUsageView>;
  section?: 'conversation' | 'models' | 'context';
  keys?: string[];
}): string[] {
  const shown: Overlay[] = [];
  const tui = {
    terminal: { columns: 120 },
    setFocus: vi.fn(),
    requestRender: vi.fn(),
    showOverlay: vi.fn((c: Overlay) => { shown.push(c); return { hide: vi.fn(), focus: vi.fn() }; }),
  };
  const usage: BrainUsageView | null = o.usage
    ? { tokens: null, contextWindow: 0, percent: null, totalTokens: 0, cost: 0, ...o.usage }
    : null;
  openStatsOverlay({
    tui: tui as never,
    editor: {} as never,
    section: o.section,
    data: { model: 'm', usage, models: o.models ?? [], context: o.context ?? null },
  });
  const overlay = shown[0];
  if (!overlay) throw new Error('the overlay was never shown');
  for (const key of o.keys ?? []) overlay.handleInput(key);
  return overlay.render(100).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
}

/** Render the Models section of the overlay and return its Σ row, stripped of styling. */
function sigmaRow(models: ModelUsageView[]): string {
  const lines = renderOverlay({ models, keys: ['\x1b[C'] }); // ←/→ cycles Conversation → Models
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

describe('stats overlay — cache hit', () => {
  const cacheLine = (usage: Partial<BrainUsageView>): string =>
    renderOverlay({ usage }).find((l) => l.includes('cache hit')) ?? '';

  it('counts cacheWrite as a miss in the denominator, not just cacheRead + input', () => {
    // 255660 read, 3957 written (a miss — it was NOT in the cache, it had to be written), 2 fresh.
    // Correct: 255660 / (255660 + 3957 + 2) = 98.48%. The old cacheRead/(cacheRead+input) gave ~100%.
    expect(cacheLine({ cacheRead: 255660, cacheWrite: 3957, input: 2 })).toContain('98.48%');
  });

  it('shows two decimals rather than rounding a near-full rate up to 100%', () => {
    expect(cacheLine({ cacheRead: 9955, cacheWrite: 0, input: 45 })).toContain('99.55%');
  });

  it('omits the line entirely when there is no input to measure', () => {
    expect(cacheLine({ cacheRead: 0, cacheWrite: 0, input: 0 })).toBe('');
  });
});

const breakdown = (over: Partial<BrainContextBreakdown> = {}): BrainContextBreakdown => ({
  model: 'test-model',
  contextWindow: 200_000,
  reportedTokens: 96_000,
  estimatedTokens: 90_000,
  percent: 45,
  categories: [
    { id: 'system', tokens: 12_000, percent: 6 },
    { id: 'toolResults', tokens: 78_000, percent: 39 },
  ],
  free: { tokens: 110_000, percent: 55 },
  tools: [{ name: 'Bash', schemaTokens: 1_000, callTokens: 2_000, resultTokens: 75_000, tokens: 78_000, percent: 39, active: true }],
  compactAtTokens: 160_000,
  ...over,
});

describe('stats overlay — context section', () => {
  it('opens straight on the breakdown when asked, naming the categories and the heaviest tools', () => {
    const lines = renderOverlay({ context: breakdown(), section: 'context' });
    const text = lines.join('\n');
    expect(text).toContain('● Context');
    expect(text).toContain('tool output');
    expect(text).toContain('Bash');
    expect(text).toContain('compacts at 160k');
    // The provider's own count is shown as such, never merged into the estimated rows.
    expect(text).toContain('reported');
  });

  it('renders a bar only for the categories that carry tokens', () => {
    const lines = renderOverlay({ context: breakdown(), section: 'context' });
    expect(lines.filter((l) => l.includes('▰') || l.includes('▱'))).toHaveLength(2);
    expect(lines.join('\n')).not.toContain('assistant');
  });

  it('says so plainly when there is no live session to measure', () => {
    const lines = renderOverlay({ context: null, section: 'context' });
    expect(lines.join('\n')).toContain('no live session to measure');
  });
});
