import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs plugin module, no types
import { splitContent, extractImageRefs, stripThinking, parseModelExec, stripForSpeech, runtimeFooter, stripRuntimeFooter } from '../../plugins/_shared/format.mjs';

describe('shared plugin format helpers', () => {
  it('splitContent / extractImageRefs / stripThinking never throw on a null or undefined body (the shipped Discord/WhatsApp TypeError)', () => {
    expect(() => splitContent(null, 1990)).not.toThrow();
    expect(splitContent(undefined, 1990)).toEqual(['']);
    expect(() => extractImageRefs(undefined)).not.toThrow();
    expect(extractImageRefs(null)).toEqual({ cleaned: '', files: [] });
    expect(stripThinking(undefined)).toBe('');
  });

  it('splitContent keeps a fenced code block intact across a chunk boundary', () => {
    const body = 'before\n```js\n' + 'x'.repeat(50) + '\n```\nafter';
    const pieces = splitContent(body, 40);
    expect(pieces.length).toBeGreaterThan(1);
    // Every piece has balanced fences (the split reopens the block).
    for (const p of pieces) expect((p.match(/```/g)?.length ?? 0) % 2).toBe(0);
    // Every code character survives the split (the reopen/close fences are injected around them).
    expect((pieces.join('').match(/x/g) ?? []).length).toBe(50);
  });

  it('extractImageRefs pulls brain-image links and leaves other text, guarding path tricks', () => {
    const { cleaned, files } = extractImageRefs('see ![a](http://x/brain/images/abc123.png) and ![b](/brain/images/def.png)');
    expect(files).toEqual(['abc123.png', 'def.png']);
    expect(cleaned).not.toContain('brain/images');
    // A non-matching name (uppercase / path segment) is left untouched.
    expect(extractImageRefs('![x](/brain/images/../evil.png)').files).toEqual([]);
  });

  it('stripThinking removes inline chain-of-thought; parseModelExec parses the three exec shapes', () => {
    expect(stripThinking('<think>secret</think>answer')).toBe('answer');
    expect(parseModelExec('elowen:anthropic/claude-x')).toEqual({ provider: 'anthropic', model: 'claude-x' });
    expect(parseModelExec('anthropic/claude-x')).toEqual({ provider: 'anthropic', model: 'claude-x' });
    expect(parseModelExec('claude-x')).toEqual({ model: 'claude-x' });
    expect(parseModelExec('')).toBeNull();
  });

  it('stripForSpeech flattens markdown to speakable prose', () => {
    expect(stripForSpeech('# Title\n`code` and [link](http://x)')).toBe('Title code and link');
    expect(stripForSpeech(null)).toBe('');
  });

  // One footer implementation now serves Discord, Telegram and WhatsApp — only the fence differs. These
  // pin each surface's fence so a change to the shared core can't silently flatten them into one look,
  // and pin the writer/reader symmetry the history strip depends on.
  describe('runtimeFooter / stripRuntimeFooter', () => {
    const FENCES = {
      discord: { open: '-# ', close: '' },
      telegram: { open: '— ', close: '' },
      whatsapp: { open: '_', close: '_' },
    };
    const idle = { model: 'alibaba/qwen3.8-max-preview', usage: { percent: 41.6 } };

    it('wraps the same text in each surface own markup, provider dropped and percent rounded', () => {
      expect(runtimeFooter(idle, FENCES.discord)).toBe('-# qwen3.8-max-preview · 42 %');
      expect(runtimeFooter(idle, FENCES.telegram)).toBe('— qwen3.8-max-preview · 42 %');
      expect(runtimeFooter(idle, FENCES.whatsapp)).toBe('_qwen3.8-max-preview · 42 %_');
    });

    it('renders nothing rather than an empty fence when the idle event carried no usable data', () => {
      for (const fence of Object.values(FENCES)) {
        expect(runtimeFooter(null, fence)).toBe('');
        expect(runtimeFooter({}, fence)).toBe('');
        // Either half alone still earns a footer — only a turn that reported NEITHER renders none.
        expect(runtimeFooter({ model: 'gpt-5' }, fence)).toBe(`${fence.open}gpt-5${fence.close}`);
        expect(runtimeFooter({ usage: { percent: 7 } }, fence)).toBe(`${fence.open}7 %${fence.close}`);
      }
    });

    it('takes back off exactly what it writes, on every surface', () => {
      for (const fence of Object.values(FENCES)) {
        expect(stripRuntimeFooter(`Hotovo.\n\n${runtimeFooter(idle, fence)}`, fence)).toBe('Hotovo.');
      }
    });

    it('leaves anything that is not a trailing footer of its own surface intact', () => {
      // A Discord footer is not a WhatsApp one — each reader only recognises its own fence.
      expect(stripRuntimeFooter('Hotovo.\n\n-# x · 1 %', FENCES.whatsapp)).toBe('Hotovo.\n\n-# x · 1 %');
      // A bare fence has nothing between open and close.
      expect(stripRuntimeFooter('Hotovo.\n\n_', FENCES.whatsapp)).toBe('Hotovo.\n\n_');
      expect(stripRuntimeFooter('Hotovo.\n\n-#', FENCES.discord)).toBe('Hotovo.\n\n-#');
      // Only the LAST line is a footer position; the same markup mid-body is content.
      expect(stripRuntimeFooter('— pozn\n\nHotovo.', FENCES.telegram)).toBe('— pozn\n\nHotovo.');
      expect(stripRuntimeFooter(null, FENCES.discord)).toBe('');
    });
  });
});
