import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { ConfigStore } from '../../src/store/configStore.js';

const entry = { id: 'relay', label: 'CoreSynth', type: 'openai', baseUrl: 'https://ai.example/v1', models: ['m1'], apiKey: 'sek' };

describe('ConfigStore brain providers', () => {
  it('defaults to no providers', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    expect(cs.get().brain.providers).toEqual([]);
  });

  it('round-trips a provider, stripping the key to apiKeySet in the public view', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { providers: [entry] } });
    expect(cs.get().brain.providers).toEqual([
      { id: 'relay', label: 'CoreSynth', type: 'openai', baseUrl: 'https://ai.example/v1', models: ['m1'], apiKeySet: true },
    ]);
    expect(JSON.stringify(cs.get())).not.toContain('sek');
    expect(cs.brainProviders()[0]?.apiKey).toBe('sek');
  });

  it('keeps the stored key when a patched entry arrives keyless', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { providers: [entry] } });
    cs.update({ brain: { providers: [{ ...entry, apiKey: undefined, label: 'Renamed' }] } });
    expect(cs.brainProviders()[0]?.apiKey).toBe('sek');
    expect(cs.brainProviders()[0]?.label).toBe('Renamed');
  });

  it('drops malformed entries and duplicate ids', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { providers: [entry, { ...entry, label: 'dup' }, { id: '', type: 'openai' }, { id: 'x', type: 'bogus' }, 'junk'] } });
    expect(cs.brainProviders().map((p) => p.id)).toEqual(['relay']);
  });

  it('removing an entry via a wholesale update deletes it (and its key)', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { providers: [entry] } });
    cs.update({ brain: { providers: [] } });
    expect(cs.brainProviders()).toEqual([]);
  });
});

describe('ConfigStore brain limits', () => {
  it('defaults to the built-in limits', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    expect(cs.get().brain.limits).toEqual({
      toolOutputMaxLines: 80, toolOutputMaxChars: 30000, elicitationTimeoutMs: 300000,
      memoryRecallCount: 6, memoryRecallChars: 1500, goalTurnBudget: 8, goalMaxTurns: 64, channelSessionCap: 32,
      delegateContextChars: 20000,
    });
  });

  // Every tuning knob is adjustable to its default ±50%; the bound is derived from the default so the
  // two cannot drift apart. A value inside the band survives untouched, one outside lands on the edge.
  it('accepts a tuning knob anywhere in its default ±50% band and clamps beyond it', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { limits: { toolOutputMaxChars: 22_000, memoryRecallChars: 900, toolOutputMaxLines: 120 } } });
    expect(cs.get().brain.limits.toolOutputMaxChars).toBe(22000);
    expect(cs.get().brain.limits.memoryRecallChars).toBe(900);
    expect(cs.get().brain.limits.toolOutputMaxLines).toBe(120); // upper edge, exactly in range
    cs.update({ brain: { limits: { toolOutputMaxChars: 500_000, memoryRecallChars: 10, toolOutputMaxLines: 1 } } });
    expect(cs.get().brain.limits.toolOutputMaxChars).toBe(45000); // 30 000 + 50%
    expect(cs.get().brain.limits.memoryRecallChars).toBe(750);    // 1 500 − 50%
    expect(cs.get().brain.limits.toolOutputMaxLines).toBe(40);    // 80 − 50%
  });

  // These three are exempt from the ±50% rule because their range is load-bearing: the far ends are real
  // operating points, not slack. The 1 hour question timeout was an explicit owner request.
  it('lets the exempt limits reach their far ends and clamps past them', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { limits: { elicitationTimeoutMs: 3_600_000, goalMaxTurns: 500, channelSessionCap: 256 } } });
    expect(cs.get().brain.limits.elicitationTimeoutMs).toBe(3_600_000);
    expect(cs.get().brain.limits.goalMaxTurns).toBe(500);
    expect(cs.get().brain.limits.channelSessionCap).toBe(256);
    cs.update({ brain: { limits: { elicitationTimeoutMs: 30_000, goalMaxTurns: 8, channelSessionCap: 4 } } });
    expect(cs.get().brain.limits.elicitationTimeoutMs).toBe(30_000);
    expect(cs.get().brain.limits.goalMaxTurns).toBe(8);
    expect(cs.get().brain.limits.channelSessionCap).toBe(4);
    cs.update({ brain: { limits: { elicitationTimeoutMs: 7_200_000, goalMaxTurns: 999, channelSessionCap: 1 } } });
    expect(cs.get().brain.limits.elicitationTimeoutMs).toBe(3_600_000);
    expect(cs.get().brain.limits.goalMaxTurns).toBe(500);
    expect(cs.get().brain.limits.channelSessionCap).toBe(4);
  });

  // The sub-agent context budget is the one knob whose ceiling is not the ±50% rule: packing re-trims
  // anything above the delegated-scope prompt total (32 000 chars, shared with the child's role prompt),
  // so a bigger number would buy the operator no extra context.
  it('caps the sub-agent context budget at what a packed delegated scope can carry', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { limits: { delegateContextChars: 500_000 } } });
    expect(cs.get().brain.limits.delegateContextChars).toBe(26000);
    cs.update({ brain: { limits: { delegateContextChars: 10 } } });
    expect(cs.get().brain.limits.delegateContextChars).toBe(10000);
    cs.update({ brain: { limits: { delegateContextChars: 12_345 } } });
    expect(cs.get().brain.limits.delegateContextChars).toBe(12345);
  });

  it('merges a partial patch per-field without resetting siblings, and clamps out-of-range values', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { limits: { goalTurnBudget: 10 } } });
    expect(cs.get().brain.limits.goalTurnBudget).toBe(10);
    expect(cs.get().brain.limits.memoryRecallCount).toBe(6); // sibling untouched
    // Clamp both ends + round a fractional value to a whole number.
    cs.update({ brain: { limits: { goalTurnBudget: 999, memoryRecallCount: 0, channelSessionCap: 40.7 } } });
    expect(cs.get().brain.limits.goalTurnBudget).toBe(12);   // max 12 (8 + 50%)
    expect(cs.get().brain.limits.memoryRecallCount).toBe(3); // min 3 (6 − 50%)
    expect(cs.get().brain.limits.channelSessionCap).toBe(41); // rounded, in range
  });

  it('ignores a non-finite value, keeping the current one', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { limits: { goalMaxTurns: 100 } } });
    cs.update({ brain: { limits: { goalMaxTurns: Number.NaN } } });
    expect(cs.get().brain.limits.goalMaxTurns).toBe(100);
  });
});

describe('brain provider wire-API (api) round-trip', () => {
  const oa = { id: 'oa', label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-x'] };

  it('persists the pin, exposes it in the public view, and keeps it across a keyless echo', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { providers: [{ ...oa, api: 'openai-completions', apiKey: 'sk-1' }] } });
    expect(cs.get().brain.providers[0]).toMatchObject({ api: 'openai-completions', apiKeySet: true });
    // The UI/setup round-trip re-sends the keyless public entry — pin AND key must both survive.
    cs.update({ brain: { providers: [{ ...oa, api: 'openai-completions' }] } });
    expect(cs.brainProviders()[0]).toMatchObject({ api: 'openai-completions', apiKey: 'sk-1' });
  });

  it('an entry arriving WITHOUT api resets the pin to auto (documented contract)', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { providers: [{ ...oa, api: 'openai-responses', apiKey: 'sk-1' }] } });
    cs.update({ brain: { providers: [{ ...oa }] } });
    expect(cs.get().brain.providers[0]!.api).toBeUndefined();
  });

  it('drops api on non-openai types and rejects unknown values', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { providers: [
      { id: 'an', label: 'Ant', type: 'anthropic', baseUrl: '', models: [], api: 'openai-responses' },
      { ...oa, api: 'not-a-real-api' },
    ] } });
    expect(cs.get().brain.providers.find((p) => p.id === 'an')!.api).toBeUndefined();
    expect(cs.get().brain.providers.find((p) => p.id === 'oa')!.api).toBeUndefined();
  });

  it('persists an oauth-kimi entry', () => {
    // The runtime allowlist in sanitizeBrainProviders is a membership test, not an exhaustive one, so a
    // type the union gained and the array did not is dropped here without a word.
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ brain: { providers: [{ id: 'kimi-coding', label: 'Kimi account', type: 'oauth-kimi', baseUrl: '', models: [], apiKey: null }] } });
    expect(cs.get().brain.providers.map((p) => p.type)).toEqual(['oauth-kimi']);
  });

  describe('temperature', () => {
    const withTemp = (temperature: unknown) => {
      const cs = new ConfigStore(openDb(':memory:'));
      cs.update({ brain: { providers: [{ ...entry, temperature }] } });
      return cs.brainProviders()[0]?.temperature;
    };

    it('round-trips a value in range, including the edges and 0', () => {
      expect(withTemp(0.7)).toBe(0.7);
      expect(withTemp(0)).toBe(0); // a real setting, not "unset"
      expect(withTemp(2)).toBe(2);
    });

    it('drops anything out of range or not a finite number', () => {
      // Dropped rather than clamped: sending a temperature we invented is worse than sending none, and
      // "none" is a valid request against every endpoint.
      for (const bad of [-0.1, 2.1, Number.NaN, Number.POSITIVE_INFINITY, '0.7', null, {}]) {
        expect(withTemp(bad)).toBeUndefined();
      }
    });

    it('is absent by default so no temperature reaches the wire', () => {
      // Load-bearing: Kimi K3 rejects any temperature but its own default, as does Claude Opus 4.7+.
      const cs = new ConfigStore(openDb(':memory:'));
      cs.update({ brain: { providers: [entry] } });
      expect(cs.brainProviders()[0]).not.toHaveProperty('temperature');
      expect(cs.get().brain.providers[0]).not.toHaveProperty('temperature');
    });
  });
});
