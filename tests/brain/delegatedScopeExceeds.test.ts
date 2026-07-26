import { describe, it, expect } from 'vitest';
import { scopeExceedsCurrentAccess, type DelegatedExecutionScope } from '../../src/brain/delegatedScope.js';

type Access = Parameters<typeof scopeExceedsCurrentAccess>[1];

const scope = (over: Partial<DelegatedExecutionScope> = {}): DelegatedExecutionScope => ({
  admin: false, projectIds: [1], owner: false, permissionBoundary: null, ...over,
});
const access = (over: Partial<Access> = {}): Access => ({
  admin: false, projectIds: [1], owner: false, permissionBoundary: null, ...over,
});

/** Continuing an existing sub-agent replays a scope minted in the PAST. It must therefore be checked
 *  against the delegating turn's CURRENT authority, not only against what it was originally granted —
 *  otherwise a conversation that has since been narrowed could reach back through an old child. */
describe('scopeExceedsCurrentAccess', () => {
  it('accepts a child whose scope matches the caller exactly', () => {
    expect(scopeExceedsCurrentAccess(scope(), access())).toBeUndefined();
  });

  it('accepts a child strictly narrower than the caller', () => {
    expect(scopeExceedsCurrentAccess(
      scope({ projectIds: [1], toolPolicy: { allow: ['Read'] } }),
      access({ projectIds: [1, 2], toolPolicy: { allow: ['Read', 'Write'] } }),
    )).toBeUndefined();
  });

  it('an admin caller may continue any project-scoped child', () => {
    expect(scopeExceedsCurrentAccess(scope({ projectIds: [3, 4] }), access({ admin: true, projectIds: [] })))
      .toBeUndefined();
    expect(scopeExceedsCurrentAccess(scope({ admin: true, projectIds: [] }), access({ admin: true, projectIds: [] })))
      .toBeUndefined();
  });

  describe('refuses to hand back more than the caller now holds', () => {
    it('an all-project child under a project-scoped caller', () => {
      expect(scopeExceedsCurrentAccess(scope({ admin: true, projectIds: [] }), access()))
        .toMatch(/all-project/i);
    });

    it('a child scoped to a project the caller has since lost', () => {
      expect(scopeExceedsCurrentAccess(scope({ projectIds: [1, 9] }), access({ projectIds: [1] })))
        .toMatch(/project/i);
    });

    it('an owner-authority child under a non-owner caller', () => {
      expect(scopeExceedsCurrentAccess(scope({ owner: true }), access({ owner: false })))
        .toMatch(/owner/i);
    });

    it('a child holding a tool the caller no longer has', () => {
      expect(scopeExceedsCurrentAccess(
        scope({ toolPolicy: { allow: ['Read', 'Bash'] } }),
        access({ toolPolicy: { allow: ['Read'] } }),
      )).toMatch(/Bash/);
    });

    // The dangerous asymmetry: "no allow-list" means UNRESTRICTED, so an old unrestricted child is
    // strictly wider than a caller who now runs on an allow-list. Absence must not read as "narrow".
    it('an unrestricted child under a caller restricted to an allow-list', () => {
      expect(scopeExceedsCurrentAccess(scope(), access({ toolPolicy: { allow: ['Read'] } })))
        .toMatch(/tool/i);
    });

    // A PLANNING turn must never reach a writing child. The persisted scope cannot prove a child was
    // spawned read-only (an ordinary `tools: ['Read']` delegation looks the same), so this fails closed
    // for every continuation rather than guessing.
    it('any continuation from a read-only (planning) turn', () => {
      expect(scopeExceedsCurrentAccess(scope(), access({ readOnly: true }))).toMatch(/read-only|plan/i);
    });
  });

  // A deny is a narrowing, and the continuation path adds the caller's current denies on top; it is
  // never a reason to refuse.
  it('does not refuse merely because the caller gained a deny-list', () => {
    expect(scopeExceedsCurrentAccess(scope(), access({ toolPolicy: { deny: ['Bash'] } }))).toBeUndefined();
  });
});
