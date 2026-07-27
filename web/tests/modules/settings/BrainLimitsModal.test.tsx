import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { BrainLimitsModal, BRAIN_LIMIT_DEFAULTS } from '../../../modules/settings/BrainLimitsModal';

/** The modal's own stacking layer, read from the real stylesheet — jsdom loads no CSS, so a computed
 *  z-index would be empty for both elements and prove nothing. Reading the shipped value keeps the test
 *  honest: if the layers are ever renumbered, this follows them instead of pinning a stale literal. */
function modalLayerZ(): number {
  const css = readFileSync(resolve(process.cwd(), 'app/styles/components.css'), 'utf8');
  const z = /\.overlay-layer-modal\s*\{[^}]*z-index:\s*(\d+)/.exec(css)?.[1];
  if (!z) throw new Error('.overlay-layer-modal z-index not found in components.css');
  return Number(z);
}

/** The z-index the tooltip actually carries (a Tailwind arbitrary value, e.g. `z-[130]`). */
function tooltipZ(tooltip: HTMLElement): number {
  const z = /(?:^|\s)z-\[(\d+)\]/.exec(tooltip.className)?.[1];
  if (!z) throw new Error(`the help tooltip carries no z-index class: ${tooltip.className}`);
  return Number(z);
}

describe('BrainLimitsModal', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('shows human units and writes canonical milliseconds and characters', () => {
    const updates: Parameters<typeof BrainLimitsModal>[0]['onChange'] extends (next: infer T) => void ? T[] : never = [];
    render(
      <LanguageProvider>
        <BrainLimitsModal limits={BRAIN_LIMIT_DEFAULTS} onChange={(update) => updates.push(update)} onClose={() => {}} />
      </LanguageProvider>,
    );

    expect(screen.getByText('5 min')).toBeTruthy();
    expect(screen.getByText('≈ 7.5k tokens')).toBeTruthy();
    fireEvent.change(screen.getByRole('slider', { name: 'Question timeout' }), { target: { value: '10' } });
    fireEvent.change(screen.getByRole('slider', { name: 'Tool output — tokens' }), { target: { value: '4000' } });

    const durationUpdate = updates[0];
    const sizeUpdate = updates[1];
    if (!durationUpdate || !sizeUpdate) throw new Error('slider changes did not reach onChange');
    expect(durationUpdate(BRAIN_LIMIT_DEFAULTS).elicitationTimeoutMs).toBe(600000);
    expect(sizeUpdate(BRAIN_LIMIT_DEFAULTS).toolOutputMaxChars).toBe(16000);
  });

  it('keeps slider changes inside the canonical field bounds', () => {
    const updates: Parameters<typeof BrainLimitsModal>[0]['onChange'] extends (next: infer T) => void ? T[] : never = [];
    render(
      <LanguageProvider>
        <BrainLimitsModal limits={BRAIN_LIMIT_DEFAULTS} onChange={(update) => updates.push(update)} onClose={() => {}} />
      </LanguageProvider>,
    );
    const timeout = screen.getByRole('slider', { name: 'Question timeout' }) as HTMLInputElement;
    expect(timeout.min).toBe('0.5');
    expect(timeout.max).toBe('60');

    fireEvent.change(timeout, { target: { value: '90' } });

    const update = updates[0];
    if (!update) throw new Error('slider change did not reach onChange');
    expect(update(BRAIN_LIMIT_DEFAULTS).elicitationTimeoutMs).toBe(3600000);
  });

  it('names the value actually in force on a field the daemon clamped', () => {
    render(
      <LanguageProvider>
        <BrainLimitsModal
          limits={{ ...BRAIN_LIMIT_DEFAULTS, memoryRecallCount: 9 }}
          applied={{ memoryRecallCount: 6 }}
          onChange={() => {}}
          onClose={() => {}}
        />
      </LanguageProvider>,
    );

    // The row keeps showing what the operator set — the note is what stops that from being a lie.
    expect(screen.getByText('9')).toBeTruthy();
    expect(screen.getByText('Saved as 6 — the value you set was outside the allowed range.')).toBeTruthy();
    // Every other row saved as asked, so none of them carries a note.
    expect(screen.getAllByText(/^Saved as /)).toHaveLength(1);
  });

  it('opens field help as a floating layer above the limits modal', () => {
    render(
      <LanguageProvider>
        <BrainLimitsModal limits={BRAIN_LIMIT_DEFAULTS} onChange={() => {}} onClose={() => {}} />
      </LanguageProvider>,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Help' })[0]!);

    const tooltip = screen.getByRole('tooltip');
    const dialog = screen.getByRole('dialog');
    // "Above the modal" has two halves, and BOTH must hold or the help is unreadable:
    // 1. it escapes the modal's clipping/stacking context (portaled to <body>, painted after it), and
    // 2. it outranks the modal's stacking layer — the half a portal alone does NOT give you.
    expect(tooltip.parentElement).toBe(document.body);
    expect(dialog.compareDocumentPosition(tooltip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tooltipZ(tooltip)).toBeGreaterThan(modalLayerZ());
  });

  it('flips the help body above the trigger so it stays inside the viewport near the fold', () => {
    // A real 120px help body opened near the bottom of jsdom's 768px viewport would spill past it.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120);
    render(
      <LanguageProvider>
        <BrainLimitsModal limits={BRAIN_LIMIT_DEFAULTS} onChange={() => {}} onClose={() => {}} />
      </LanguageProvider>,
    );
    const trigger = screen.getAllByRole('button', { name: 'Help' })[0]!;
    Object.defineProperty(trigger, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 700, bottom: 716, left: 300, right: 316, width: 16, height: 16, x: 300, y: 700, toJSON: () => ({}) }),
    });

    fireEvent.click(trigger);

    const top = Number.parseInt(screen.getByRole('tooltip').style.top, 10);
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    expect(top).toBeLessThanOrEqual(700);
    expect(top + 120).toBeLessThanOrEqual(viewportHeight);
    expect(top).toBeGreaterThanOrEqual(12);
  });
});
