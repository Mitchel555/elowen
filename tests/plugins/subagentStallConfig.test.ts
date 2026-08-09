import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// @ts-expect-error — plugin helper is plain ESM with no type declarations
import { resolveStallMs } from '../../plugins/subagent/lib/stall.mjs';

describe('resolveStallMs — configurable stall watchdog timeout', () => {
  const saved = process.env.ELOWEN_SUBAGENT_TURN_STALL_MS;
  beforeEach(() => { delete process.env.ELOWEN_SUBAGENT_TURN_STALL_MS; });
  afterEach(() => {
    if (saved === undefined) delete process.env.ELOWEN_SUBAGENT_TURN_STALL_MS;
    else process.env.ELOWEN_SUBAGENT_TURN_STALL_MS = saved;
  });

  it('defaults to 60 minutes with no config and no env', () => {
    expect(resolveStallMs(undefined)).toBe(60 * 60_000);
    expect(resolveStallMs({})).toBe(60 * 60_000);
  });

  it('reads stallMinutes from the plugin config, in minutes', () => {
    expect(resolveStallMs({ stallMinutes: 90 })).toBe(90 * 60_000);
  });

  it('clamps the config value to the 5..240 minute range', () => {
    expect(resolveStallMs({ stallMinutes: 500 })).toBe(240 * 60_000); // mutation: drop the max clamp -> 500m
    expect(resolveStallMs({ stallMinutes: 2 })).toBe(5 * 60_000);     // mutation: drop the min clamp -> 2m
    expect(resolveStallMs({ stallMinutes: 0 })).toBe(60 * 60_000);    // non-positive -> default, not clamped to min
  });

  it('lets the env override win over config, unclamped (the e2e test relies on this)', () => {
    process.env.ELOWEN_SUBAGENT_TURN_STALL_MS = '300';
    expect(resolveStallMs({ stallMinutes: 90 })).toBe(300); // mutation: config wins -> 90*60_000
  });
});
