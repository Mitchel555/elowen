import { describe, it, expect, beforeEach } from 'vitest';
import { markImagesRejected, imagesRejected, resetImageRejections } from '../../../src/brain/session/imageRejection.js';

// The mark is deliberately sticky — it is not cleared on dispose, because an in-place respawn is part of
// recovering from the very failure it records. Sticky must not mean unbounded, though: the daemon runs for
// weeks, and every conversation that ever hit a refused image would accumulate.

beforeEach(() => resetImageRejections());

describe('image-rejection marks', () => {
  it('remembers a marked conversation', () => {
    markImagesRejected('brain-1');
    expect(imagesRejected('brain-1')).toBe(true);
    expect(imagesRejected('brain-2')).toBe(false);
  });

  it('stops growing once the ceiling is reached', () => {
    for (let i = 0; i < 900; i++) markImagesRejected(`brain-${i}`);
    // The oldest marks are gone, the newest are kept — the set cannot grow past its bound.
    expect(imagesRejected('brain-0')).toBe(false);
    expect(imagesRejected('brain-899')).toBe(true);
    expect(imagesRejected('brain-500')).toBe(true);
  });

  it('re-marking moves a conversation out of the eviction line', () => {
    // Oldest of a full set: the very next evictions would take it first.
    markImagesRejected('brain-live');
    for (let i = 0; i < 499; i++) markImagesRejected(`brain-${i}`);
    // Each new failure re-marks it, which moves it back to the end — so the 400 conversations that follow
    // push out the ones marked before it instead.
    markImagesRejected('brain-live');
    for (let i = 499; i < 899; i++) markImagesRejected(`brain-${i}`);
    expect(imagesRejected('brain-live')).toBe(true);
    expect(imagesRejected('brain-0')).toBe(false);
  });

  it('marking twice does not consume two slots', () => {
    for (let i = 0; i < 400; i++) markImagesRejected('brain-same');
    markImagesRejected('brain-other');
    expect(imagesRejected('brain-same')).toBe(true);
    expect(imagesRejected('brain-other')).toBe(true);
  });
});
