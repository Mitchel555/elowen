import { describe, it, expect } from 'vitest';
import { decideVisionHop } from '../../src/brain/visionFallback.js';

describe('decideVisionHop — the vision-fallback decision, isolated from session plumbing', () => {
  it('an image turn with a configured, different vision model hops onto it', () => {
    expect(decideVisionHop({ hasImages: true, onFallback: false, currentModel: 'main', visionModel: 'gpt-5.5', visionModelProvider: 'oai' }))
      .toEqual({ action: 'hop', provider: 'oai', model: 'gpt-5.5' });
  });

  it('an empty provider normalizes to undefined (start falls back to the default provider)', () => {
    expect(decideVisionHop({ hasImages: true, onFallback: false, currentModel: 'main', visionModel: 'v', visionModelProvider: '' }))
      .toEqual({ action: 'hop', provider: undefined, model: 'v' });
  });

  it('an image turn WITHOUT a configured vision model stays put (image rides the current model)', () => {
    expect(decideVisionHop({ hasImages: true, onFallback: false }))
      .toEqual({ action: 'none' });
  });

  it('an image turn when the current model already IS the vision model never hops', () => {
    expect(decideVisionHop({ hasImages: true, onFallback: false, currentModel: 'v', currentProvider: 'p', visionModel: 'v', visionModelProvider: 'p' }))
      .toEqual({ action: 'none' });
  });

  it('hops when the same model id is configured through a different provider', () => {
    expect(decideVisionHop({
      hasImages: true, onFallback: false, currentModel: 'shared', currentProvider: 'text-provider',
      visionModel: 'shared', visionModelProvider: 'vision-provider',
    })).toEqual({ action: 'hop', provider: 'vision-provider', model: 'shared' });
  });

  // The fallback is a safety net for a model that cannot read images at all. Hopping off one that CAN
  // answers the user on a model they did not choose — and usually a weaker one — while throwing away the
  // conversation's warm cache to do it.
  it('stays on a model the catalog knows reads images, even with a fallback configured', () => {
    expect(decideVisionHop({
      hasImages: true, onFallback: false, currentModel: 'claude-opus-5', currentProvider: 'anthropic',
      currentModelHasVision: true, visionModel: 'qwen3.8-max', visionModelProvider: 'alibaba',
    })).toEqual({ action: 'none' });
  });

  it('still hops for a model not known to read images — that is what the net is for', () => {
    expect(decideVisionHop({
      hasImages: true, onFallback: false, currentModel: 'text-only', currentProvider: 'p',
      currentModelHasVision: false, visionModel: 'v', visionModelProvider: 'vp',
    })).toEqual({ action: 'hop', provider: 'vp', model: 'v' });
  });

  it('hops when capability is simply unknown, rather than gambling on an opaque provider 400', () => {
    expect(decideVisionHop({
      hasImages: true, onFallback: false, currentModel: 'relay-model', currentProvider: 'relay',
      visionModel: 'v', visionModelProvider: 'vp',
    })).toEqual({ action: 'hop', provider: 'vp', model: 'v' });
  });

  it('a text-only turn while parked on the fallback hops back to the normal model', () => {
    expect(decideVisionHop({ hasImages: false, onFallback: true }))
      .toEqual({ action: 'hop-back' });
  });

  it('a text-only turn on the normal model does nothing', () => {
    expect(decideVisionHop({ hasImages: false, onFallback: false, visionModel: 'v' }))
      .toEqual({ action: 'none' });
  });

  it('consecutive image turns while parked on the fallback stay put (already on the vision model)', () => {
    expect(decideVisionHop({ hasImages: true, onFallback: true, currentModel: 'v', currentProvider: 'p', visionModel: 'v', visionModelProvider: 'p' }))
      .toEqual({ action: 'none' });
  });
});
