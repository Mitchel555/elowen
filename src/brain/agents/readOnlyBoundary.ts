import {
  normalizeNoninteractivePermissionBoundary,
  READ_ONLY_BASH_RULES,
  type NoninteractivePermissionBoundary,
  type PermissionRule,
} from '../toolPermissions.js';

/** The restrictions layered onto a read-only agent's boundary, in order. Appended AFTER the parent's own
 *  rules so — with last-match-wins resolution — they win over an inherited allow: writes are denied, then
 *  the shared shell clamp (deny everything, re-permit only the read-only allow-list, claw back the
 *  redirection/git-exec escapes — see READ_ONLY_BASH_RULES for why each rule is there).
 *  This is the unattended security clamp; the shared READ_ONLY_BASH_ALLOW stays frictionless for the
 *  interactive owner, who is trusted to run these. `Write`/`Edit` deny is defense-in-depth (a read-only
 *  agent never holds them in its tool allow-list either). */
const READ_ONLY_RESTRICT_RULES: readonly PermissionRule[] = [
  { scope: 'tools', pattern: 'Write', action: 'deny' },
  { scope: 'tools', pattern: 'Edit', action: 'deny' },
  ...READ_ONLY_BASH_RULES,
];

/**
 * Mint the immutable permission boundary for a read-only sub-agent (explore/plan).
 *
 * A sub-agent runs UNATTENDED — there is no human to answer an `ask`, so an inherited `ask` resolves via
 * the parent's `unattendedAsks` (default 'allow'), which would let a "read-only" agent holding the Bash
 * tool run `rm -rf`. This mints a strictly narrower boundary: the parent's rules, then the read-only
 * restrictions above, then the parent's own DENY rules re-asserted last, with `unattendedAsks: 'deny'`.
 *
 * The order is load-bearing (last-match-wins):
 *  - parent rules first, so the operator's baseline carries through;
 *  - the read-only restrictions next, so writes/shell are clamped and only the read-only allow-list runs;
 *  - the parent's DENY rules re-asserted LAST, so a command the operator explicitly denied can never be
 *    re-permitted by our allow-list — the boundary can only ever NARROW, never widen.
 * A null parent (permission gate absent) falls back to a minimal allow-all-tools base the restrictions
 * clamp down.
 */
export function buildReadOnlyBoundary(parent: NoninteractivePermissionBoundary | null): NoninteractivePermissionBoundary {
  const base: PermissionRule[] = parent ? parent.rules : [{ scope: 'tools', pattern: '*', action: 'allow' }];
  const parentDenies = base.filter((rule) => rule.action === 'deny');
  const boundary = normalizeNoninteractivePermissionBoundary({
    rules: [...base, ...READ_ONLY_RESTRICT_RULES, ...parentDenies],
    unattendedAsks: 'deny',
  });
  // The base was already validated on read and the appended rules are well-formed literals, so this
  // cannot fail — assert it so a future normalizer change can never silently widen the boundary.
  if (!boundary) throw new Error('invalid read-only agent boundary');
  return boundary;
}
