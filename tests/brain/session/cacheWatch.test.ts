import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CACHE_DROP_MIN_TOKENS,
  installCacheWatch,
} from '../../../src/brain/session/cacheWatch.js';
import { cacheTtlMs } from '../../../src/brain/session/toolResultClearing.js';
import { setLogSink } from '../../../src/shared/logger.js';

const T0 = 1_000_000;
const TTL = 60_000;

interface Captured { level: string; scope: string; message: string }
let captured: Captured[] = [];

beforeEach(() => {
  captured = [];
  setLogSink({ push: (e) => { captured.push(e); } });
});
afterEach(() => setLogSink(undefined));

type Listener = (event: unknown) => void;

function harness(options: { ttlMs?: number } = { ttlMs: TTL }): { fire: Listener } {
  let listener: Listener = () => undefined;
  const session = { subscribe: (fn: Listener) => { listener = fn; } };
  installCacheWatch(session, options);
  return { fire: (e) => listener(e) };
}

const assistantUsage = (cacheRead: number, timestamp: number) => ({
  type: 'message_end',
  message: { role: 'assistant', timestamp, usage: { cacheRead } },
});

const warnings = (): Captured[] => captured.filter((c) => c.level === 'warn' && c.scope === 'brain-cache');

/** A failed or aborted attempt: the provider was never reached, so every usage figure comes back 0. */
const failedUsage = (stopReason: 'error' | 'aborted', timestamp: number) => ({
  type: 'message_end',
  message: { role: 'assistant', timestamp, stopReason, usage: { cacheRead: 0 } },
});

describe('installCacheWatch — unsuccessful attempts', () => {
  // These reported cacheRead: 0 like any other message, so the watch read them as "the prefix was
  // rewritten". Reproduced from the live log: a warm read, a timeout, then the very next request reading
  // the cache back at full size — proof that nothing about the prefix had changed.
  it('ignores a timed-out attempt instead of reporting it as a cache drop', () => {
    const { fire } = harness();
    fire(assistantUsage(185_854, T0));
    fire(failedUsage('error', T0 + 19_000));
    expect(warnings()).toHaveLength(0);
  });

  it('does not let a failed attempt poison the baseline for the next comparison', () => {
    const { fire } = harness();
    fire(assistantUsage(185_854, T0));
    fire(failedUsage('error', T0 + 19_000));
    // Back to a full read. Had the failure been kept as the baseline, this RISE would reset it to a tiny
    // number and the next ordinary read would look like a fresh drop.
    fire(assistantUsage(187_990, T0 + 24_000));
    expect(warnings()).toHaveLength(0);
  });

  it('ignores an aborted attempt too', () => {
    // Five workflow children aborted within 5.4s once produced five warnings in a burst.
    const { fire } = harness();
    fire(assistantUsage(120_000, T0));
    fire(failedUsage('aborted', T0 + 3_000));
    expect(warnings()).toHaveLength(0);
  });

  it('still reports a genuine drop between two SUCCESSFUL requests', () => {
    const { fire } = harness();
    fire(assistantUsage(100_000, T0));
    fire(failedUsage('aborted', T0 + 2_000));
    fire(assistantUsage(20_000, T0 + 5_000));
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]?.message).toContain('100000 → 20000');
  });
});

describe('installCacheWatch', () => {
  it('warns when cacheRead drops sharply within a warm window', () => {
    const { fire } = harness();
    fire(assistantUsage(100_000, T0));
    fire(assistantUsage(80_000, T0 + 10_000)); // −20k, warm
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]?.message).toContain('100000 → 80000');
  });

  it('stays silent for small drops and for growth', () => {
    const { fire } = harness();
    fire(assistantUsage(100_000, T0));
    fire(assistantUsage(100_000 - CACHE_DROP_MIN_TOKENS + 500, T0 + 10_000)); // below the token floor
    fire(assistantUsage(120_000, T0 + 20_000)); // growth is normal
    expect(warnings()).toHaveLength(0);
  });

  it('treats a drop after a TTL-exceeding gap as expiry, not a break', () => {
    const { fire } = harness();
    fire(assistantUsage(100_000, T0));
    fire(assistantUsage(10_000, T0 + TTL + 5_000)); // cache simply expired
    expect(warnings()).toHaveLength(0);
  });

  it('resets its baseline after a real compaction (the smaller context is by design)', () => {
    const { fire } = harness();
    fire(assistantUsage(100_000, T0));
    fire({ type: 'compaction_end', aborted: false, result: { summary: '…' } });
    fire(assistantUsage(20_000, T0 + 10_000)); // post-compact context — no baseline, no warning
    expect(warnings()).toHaveLength(0);
    // …but a drop AFTER the new baseline warns again.
    fire(assistantUsage(15_000, T0 + 20_000));
    expect(warnings()).toHaveLength(1);
  });

  it('ignores aborted compactions, non-assistant messages and missing usage', () => {
    const { fire } = harness();
    fire(assistantUsage(100_000, T0));
    fire({ type: 'compaction_end', aborted: true }); // not a real compaction — baseline must survive
    fire({ type: 'message_end', message: { role: 'toolResult', timestamp: T0 + 5_000 } });
    fire({ type: 'message_end', message: { role: 'assistant', timestamp: T0 + 6_000 } }); // no usage
    fire(assistantUsage(80_000, T0 + 10_000));
    expect(warnings()).toHaveLength(1);
  });

  it('is a no-op without the subscribe seam', () => {
    expect(() => installCacheWatch({}, { ttlMs: TTL })).not.toThrow();
  });

  it('defaults the warm window to the env TTL MINUS a minute (boundary drops are expiry, not breaks)', () => {
    // Short retention (env unset) → TTL 5 min → warm window 4 min.
    const windowMs = cacheTtlMs(process.env) - 60_000;
    const { fire } = harness({}); // no ttlMs override — the env default drives
    fire(assistantUsage(100_000, T0));
    fire(assistantUsage(80_000, T0 + windowMs - 30_000)); // inside the window → break
    expect(warnings()).toHaveLength(1);
    // Measured against the PREVIOUS event: past the window → expiry, silent.
    fire(assistantUsage(10_000, T0 + 2 * windowMs + 30_000));
    expect(warnings()).toHaveLength(1);
  });
});
