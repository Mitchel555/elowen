import { describe, it, expect } from 'vitest';
import { chatTheme, chatThemeItems, color, glyph, isChatThemeName, setChatTheme, setCustomChatTheme } from '../../../src/cli/chat/theme.js';

describe('chat theme', () => {
  it('colour helpers wrap text in an ANSI sequence and reset', () => {
    const out = color.accent('hi');
    expect(out.startsWith('\x1b[')).toBe(true);
    expect(out.endsWith('\x1b[0m')).toBe(true);
    expect(out).toContain('hi');
  });

  it('exposes the Elowen brand glyphs', () => {
    expect(glyph.whale).toBe('elowen');
    expect(glyph.tool).toBe('*');
  });

  it('switches the active terminal theme at runtime', () => {
    const before = chatTheme().name;
    expect(isChatThemeName('mono')).toBe(true);
    expect(isChatThemeName('missing')).toBe(false);
    setChatTheme('mono');
    expect(chatTheme().name).toBe('mono');
    expect(chatThemeItems().some((item) => item.value === 'mono' && item.description === 'current')).toBe(true);
    setChatTheme(before);
  });

  it('builds a custom theme from a web terminal palette; bad hex keeps the default slot', () => {
    const before = chatTheme().name;
    const theme = setCustomChatTheme({ foreground: '#101112', cyan: '#22ccbb', red: 'oops', background: '#000000' });
    expect(theme.name).toBe('custom');
    expect(theme.text).toBe('38;2;16;17;18');
    expect(theme.accent).toBe('38;2;34;204;187');
    expect(theme.error).toBe(setChatTheme('elowen').error); // invalid hex → Elowen default for that slot
    expect(theme.inputBg).toBe('48;2;14;14;14');          // background lifted so layers stay readable
    if (isChatThemeName(before)) setChatTheme(before);
  });

  // WCAG 2.x relative luminance + contrast ratio, so the assertion is the real accessibility metric
  // rather than a hand-picked brightness threshold. Parses the `38;2;r;g;b` / `48;2;r;g;b` SGR fragments
  // the theme stores.
  const rgbOf = (sgrFragment: string): [number, number, number] => {
    const m = /(?:38|48);2;(\d+);(\d+);(\d+)/.exec(sgrFragment);
    if (!m) throw new Error(`not an rgb SGR fragment: ${sgrFragment}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const relLum = ([r, g, b]: [number, number, number]): number => {
    const lin = (c: number): number => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const contrast = (a: [number, number, number], b: [number, number, number]): number => {
    const la = relLum(a); const lb = relLum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };

  it('renders faint text at WCAG AA (>= 4.5:1) against the panel background in every theme', () => {
    const before = chatTheme().name;
    for (const item of chatThemeItems()) {
      const theme = setChatTheme(item.value);
      const ratio = contrast(rgbOf(theme.faint), rgbOf(theme.panelBg));
      // faint carries CONTENT in the rail (meta, hints, borders), so it must clear the AA body threshold.
      expect(ratio, `${item.value} faint vs panelBg = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      // The hierarchy faint < muted < text must survive the brightening, or the tiers collapse.
      expect(relLum(rgbOf(theme.faint)), `${item.value} faint brighter than muted`)
        .toBeLessThan(relLum(rgbOf(theme.muted)));
    }
    if (isChatThemeName(before)) setChatTheme(before);
  });

  it('selects rows with a concrete dark RGB, never ANSI 30;1 (bold-black renders as unreadable brightBlack)', () => {
    setChatTheme('elowen');
    const row = color.selected('picked');
    expect(row).not.toContain(';30;1');
    expect(row).toContain('38;2;20;18;24'); // the dark selection foreground
    expect(row).toContain('picked');
  });

  it('ships a wide palette and every listed theme is a valid, switchable name', () => {
    const items = chatThemeItems();
    expect(items.length).toBeGreaterThanOrEqual(13);
    const before = chatTheme().name;
    for (const item of items) {
      expect(isChatThemeName(item.value)).toBe(true);
      const theme = setChatTheme(item.value);
      // every palette slot must be populated so no component renders an undefined ANSI code
      for (const slot of ['accent', 'text', 'muted', 'faint', 'success', 'warning', 'error', 'panelBg', 'inputBg', 'modalBg', 'selectedBg'] as const) {
        expect(typeof theme[slot]).toBe('string');
        expect(theme[slot].length).toBeGreaterThan(0);
      }
    }
    setChatTheme(before);
  });
});
