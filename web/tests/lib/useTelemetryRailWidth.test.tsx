import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useTelemetryRailWidth,
  railTypeVars,
  RAIL_MIN_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_DEFAULT_WIDTH,
} from '../../lib/useTelemetryRailWidth';

const KEY = 'elowen:telemetry-rail-width';

beforeEach(() => localStorage.clear());

describe('useTelemetryRailWidth', () => {
  it('starts at the default width', () => {
    const { result } = renderHook(() => useTelemetryRailWidth());
    expect(result.current.width).toBe(RAIL_DEFAULT_WIDTH);
  });

  it('resizes by a delta and persists the result', () => {
    const { result } = renderHook(() => useTelemetryRailWidth());
    act(() => result.current.resizeBy(40));
    expect(result.current.width).toBe(RAIL_DEFAULT_WIDTH + 40);
    expect(localStorage.getItem(KEY)).toBe(String(RAIL_DEFAULT_WIDTH + 40));
  });

  it('clamps to the legible range in both directions', () => {
    const { result } = renderHook(() => useTelemetryRailWidth());
    act(() => result.current.resizeBy(9999));
    expect(result.current.width).toBe(RAIL_MAX_WIDTH);
    act(() => result.current.resizeBy(-9999));
    expect(result.current.width).toBe(RAIL_MIN_WIDTH);
  });

  it('rehydrates the stored width on mount', () => {
    localStorage.setItem(KEY, '420');
    const { result } = renderHook(() => useTelemetryRailWidth());
    expect(result.current.width).toBe(420);
  });

  it('ignores a stored value that is not a usable number', () => {
    localStorage.setItem(KEY, 'wide-please');
    const { result } = renderHook(() => useTelemetryRailWidth());
    expect(result.current.width).toBe(RAIL_DEFAULT_WIDTH);
  });

  it('resets back to the default and persists that too', () => {
    localStorage.setItem(KEY, '520');
    const { result } = renderHook(() => useTelemetryRailWidth());
    act(() => result.current.reset());
    expect(result.current.width).toBe(RAIL_DEFAULT_WIDTH);
    expect(localStorage.getItem(KEY)).toBe(String(RAIL_DEFAULT_WIDTH));
  });
});

describe('railTypeVars', () => {
  it('overrides only the two rail text tokens', () => {
    expect(Object.keys(railTypeVars(RAIL_DEFAULT_WIDTH)).sort()).toEqual(['--text-caption', '--text-tiny']);
  });

  it('grows the type with the rail and stays inside the narrow/wide bounds', () => {
    const num = (v: string) => Number.parseFloat(v);
    const at = (w: number) => railTypeVars(w) as Record<string, string>;
    const narrow = num(at(RAIL_MIN_WIDTH)['--text-tiny'] ?? '0');
    const mid = num(at((RAIL_MIN_WIDTH + RAIL_MAX_WIDTH) / 2)['--text-tiny'] ?? '0');
    const wide = num(at(RAIL_MAX_WIDTH)['--text-tiny'] ?? '0');
    expect(narrow).toBeLessThan(mid);
    expect(mid).toBeLessThan(wide);
    // Even at its narrowest the rail must beat the 9px global token it used to inherit.
    expect(narrow).toBeGreaterThanOrEqual(0.6875);
    expect(num(at(RAIL_MIN_WIDTH)['--text-caption'] ?? '0')).toBeGreaterThan(narrow);
  });

  it('does not run past the bounds for an out-of-range width', () => {
    const tiny = (w: number) => (railTypeVars(w) as Record<string, string>)['--text-tiny'];
    expect(tiny(10)).toBe(tiny(RAIL_MIN_WIDTH));
    expect(tiny(4000)).toBe(tiny(RAIL_MAX_WIDTH));
  });
});
