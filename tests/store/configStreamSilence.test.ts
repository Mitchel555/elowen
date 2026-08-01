import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { ConfigStore } from '../../src/store/configStore.js';

/** The two stream silence limits are a pair, and their shared 35 s floor is a CORRECTNESS bound rather
 *  than a taste one: the daemon heartbeats every 30 s whether or not a turn is running, so a limit at or
 *  below the beat interval fires in the ordinary gap between two beats — the browser would tear down a
 *  perfectly live stream, reconnect, and open the next gap, on a loop. The web client re-applies the same
 *  floor to whatever it receives (`MIN_SILENCE_LIMIT_MS`); this covers the daemon end of it. */
const HEARTBEAT_MS = 30_000;
const FLOOR_MS = 35_000;

describe('stream silence limits', () => {
  it('keeps the heartbeat floor above the beat interval', () => {
    expect(FLOOR_MS).toBeGreaterThan(HEARTBEAT_MS);
  });

  it('refuses to set either limit below the heartbeat floor', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    // Every one of these would declare a healthy stream dead: inside a beat, exactly on the beat, and
    // between the beat and the floor.
    for (const attempt of [0, 1_000, HEARTBEAT_MS, HEARTBEAT_MS + 1, FLOOR_MS - 1]) {
      cs.update({ runtime: { limits: { streamSilenceLimitMs: attempt, streamReviveSilenceLimitMs: attempt } } });
      expect(cs.get().runtime.limits.streamSilenceLimitMs).toBe(FLOOR_MS);
      expect(cs.get().runtime.limits.streamReviveSilenceLimitMs).toBe(FLOOR_MS);
    }
  });

  it('accepts the floor itself and anything above it, up to the ceiling', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ runtime: { limits: { streamSilenceLimitMs: FLOOR_MS, streamReviveSilenceLimitMs: 90_000 } } });
    expect(cs.get().runtime.limits.streamSilenceLimitMs).toBe(FLOOR_MS);
    expect(cs.get().runtime.limits.streamReviveSilenceLimitMs).toBe(90_000);
  });

  // They are a pair, not one value: raising the watched-page limit must not drag the wake-up limit with it.
  it('tunes each half of the pair independently', () => {
    const cs = new ConfigStore(openDb(':memory:'));
    cs.update({ runtime: { limits: { streamSilenceLimitMs: 120_000 } } });
    expect(cs.get().runtime.limits.streamSilenceLimitMs).toBe(120_000);
    expect(cs.get().runtime.limits.streamReviveSilenceLimitMs).toBe(45_000);
  });
});
