import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { ConfigStore } from '../../src/store/configStore.js';

/** The runtime knobs are the sibling group of the brain limits: same contract (whole numbers, per-field
 *  clamp, a partial patch never resetting a sibling), different domain. Every default here must equal the
 *  hardcoded value it replaced, or enabling the setting would itself change behaviour. */
describe('ConfigStore runtime limits', () => {
  it('defaults to the values that were hardcoded before the setting existed', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    expect(cs.get().runtime).toEqual({
      limits: {
        localShellTimeoutMs: 30_000,      // LOCAL_SHELL_TIMEOUT_MS
        memorySemanticFloorPerMille: 300, // MIN_SEMANTIC 0.3
        toolDeferThreshold: 10,           // DEFAULT_DEFER_THRESHOLD
        eventRetentionDays: 30,           // purgeOlderThan(days = 30)
        streamSilenceLimitMs: 75_000,     // SILENCE_LIMIT_MS
        streamReviveSilenceLimitMs: 45_000, // REVIVE_SILENCE_LIMIT_MS
        toastDurationMs: 4_500,           // TOAST_MS
      },
      toolDeferralEnabled: true,
    });
  });

  it('accepts every knob at both edges of its range', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ runtime: { limits: { localShellTimeoutMs: 10_000, memorySemanticFloorPerMille: 100, toolDeferThreshold: 1, eventRetentionDays: 1, streamSilenceLimitMs: 35_000, streamReviveSilenceLimitMs: 35_000, toastDurationMs: 2_000 } } });
    expect(cs.get().runtime.limits).toEqual({
      localShellTimeoutMs: 10_000, memorySemanticFloorPerMille: 100, toolDeferThreshold: 1, eventRetentionDays: 1,
      streamSilenceLimitMs: 35_000, streamReviveSilenceLimitMs: 35_000, toastDurationMs: 2_000,
    });
    cs.update({ runtime: { limits: { localShellTimeoutMs: 300_000, memorySemanticFloorPerMille: 800, toolDeferThreshold: 100, eventRetentionDays: 365, streamSilenceLimitMs: 300_000, streamReviveSilenceLimitMs: 300_000, toastDurationMs: 15_000 } } });
    expect(cs.get().runtime.limits).toEqual({
      localShellTimeoutMs: 300_000, memorySemanticFloorPerMille: 800, toolDeferThreshold: 100, eventRetentionDays: 365,
      streamSilenceLimitMs: 300_000, streamReviveSilenceLimitMs: 300_000, toastDurationMs: 15_000,
    });
  });

  it('clamps a value past either end back into range', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ runtime: { limits: { localShellTimeoutMs: 1, memorySemanticFloorPerMille: 0, toolDeferThreshold: 0, eventRetentionDays: 0, streamSilenceLimitMs: 1_000, streamReviveSilenceLimitMs: 1_000, toastDurationMs: 100 } } });
    expect(cs.get().runtime.limits).toEqual({
      localShellTimeoutMs: 10_000, memorySemanticFloorPerMille: 100, toolDeferThreshold: 1, eventRetentionDays: 1,
      streamSilenceLimitMs: 35_000, streamReviveSilenceLimitMs: 35_000, toastDurationMs: 2_000,
    });
    cs.update({ runtime: { limits: { localShellTimeoutMs: 9_000_000, memorySemanticFloorPerMille: 1_000, toolDeferThreshold: 5_000, eventRetentionDays: 10_000, streamSilenceLimitMs: 9_000_000, streamReviveSilenceLimitMs: 9_000_000, toastDurationMs: 9_000_000 } } });
    expect(cs.get().runtime.limits).toEqual({
      localShellTimeoutMs: 300_000, memorySemanticFloorPerMille: 800, toolDeferThreshold: 100, eventRetentionDays: 365,
      streamSilenceLimitMs: 300_000, streamReviveSilenceLimitMs: 300_000, toastDurationMs: 15_000,
    });
  });

  it('merges a partial patch per-field without resetting siblings, and rounds a fractional value', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ runtime: { limits: { toolDeferThreshold: 25 } } });
    expect(cs.get().runtime.limits.toolDeferThreshold).toBe(25);
    expect(cs.get().runtime.limits.eventRetentionDays).toBe(30); // sibling untouched
    cs.update({ runtime: { limits: { eventRetentionDays: 7.6 } } });
    expect(cs.get().runtime.limits.eventRetentionDays).toBe(8);
    expect(cs.get().runtime.limits.toolDeferThreshold).toBe(25); // still the earlier patch
  });

  it('ignores a non-finite value, keeping the current one', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ runtime: { limits: { localShellTimeoutMs: 120_000 } } });
    cs.update({ runtime: { limits: { localShellTimeoutMs: Number.NaN } } });
    expect(cs.get().runtime.limits.localShellTimeoutMs).toBe(120_000);
  });

  // The floor is carried in per mille precisely so the whole-number clamp cannot destroy it: were it
  // stored as a cosine float, 0.3 would round to 0 and no memory would ever be filtered out again.
  it('keeps the semantic floor intact through the whole-number clamp', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ runtime: { limits: { memorySemanticFloorPerMille: 450 } } });
    expect(cs.get().runtime.limits.memorySemanticFloorPerMille).toBe(450);
  });

  it('round-trips the deferral kill switch and leaves it alone on a limits-only patch', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ runtime: { toolDeferralEnabled: false } });
    expect(cs.get().runtime.toolDeferralEnabled).toBe(false);
    expect(cs.get().runtime.limits.toolDeferThreshold).toBe(10); // untouched by the switch patch
    cs.update({ runtime: { limits: { toolDeferThreshold: 12 } } });
    expect(cs.get().runtime.toolDeferralEnabled).toBe(false);
    cs.update({ runtime: { toolDeferralEnabled: true } });
    expect(cs.get().runtime.toolDeferralEnabled).toBe(true);
  });

  it('leaves the whole runtime block alone when the patch touches another section', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ runtime: { limits: { eventRetentionDays: 90 }, toolDeferralEnabled: false } });
    cs.update({ brain: { maxSteps: 30 } });
    expect(cs.get().runtime.limits.eventRetentionDays).toBe(90);
    expect(cs.get().runtime.toolDeferralEnabled).toBe(false);
  });
});
