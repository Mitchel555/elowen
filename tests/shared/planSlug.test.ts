import { describe, it, expect } from 'vitest';
import { planSlug } from '../../src/shared/planSlug.js';

describe('planSlug', () => {
  // The whole reason for deriving rather than generating: every caller that needs the plan path computes
  // the same answer from the session id alone, with nothing persisted and nothing to drift after a
  // daemon restart. If this ever stops holding, plan files silently orphan themselves.
  it('is stable for the same session id', () => {
    expect(planSlug('brain-ch-owner-1')).toBe(planSlug('brain-ch-owner-1'));
  });

  it('separates sessions that differ only slightly', () => {
    expect(planSlug('brain-ch-owner-1')).not.toBe(planSlug('brain-ch-owner-2'));
  });

  it('reads as words, so a person can tell two plans apart in a listing', () => {
    expect(planSlug('brain-ch-owner-1')).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{12}$/);
  });

  // It becomes a path component, so the charset is a safety property, not a cosmetic one — a session id
  // full of separators, dots or control characters must not be able to steer the filename anywhere.
  it('stays a safe path component whatever the session id contains', () => {
    for (const id of ['../../escape', 'a/b/c', '..', '', 'x\u0000y', 'CAPS AND SPACES', '💥']) {
      expect(planSlug(id)).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('does not collide across a realistic number of sessions', () => {
    const slugs = new Set(Array.from({ length: 5_000 }, (_, i) => planSlug(`brain-ch-owner-${i}`)));
    expect(slugs.size).toBe(5_000);
  });
});
