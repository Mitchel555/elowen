import type { ToolPolicy } from '../plugins/policyContext.js';
import {
  normalizeNoninteractivePermissionBoundary,
  type NoninteractivePermissionBoundary,
} from './toolPermissions.js';
import { buildReadOnlyBoundary } from './agents/readOnlyBoundary.js';

/**
 * The immutable execution boundary minted for a delegated child.  A child is a durable conversation:
 * after an LRU eviction or an idle drill-in continuation it must resume with this boundary, never with
 * the account owner's ambient all-access policy.  Arrays (rather than Sets) make the boundary safe to
 * store as JSON and deliberately retain an empty allow-list (`allow: []` means no plugin tools).
 */
export interface DelegatedExecutionScope {
  admin: boolean;
  projectIds: number[];
  owner: boolean;
  toolPolicy?: { allow?: string[]; deny?: string[] };
  /** Captured effective granular permission rules for this unattended child. Explicit `null` means the
   * delegating turn had no permission gate wired at all; an absent/malformed field is legacy/corrupt and
   * must fail closed. */
  permissionBoundary: NoninteractivePermissionBoundary | null;
  /** System-prompt appendices that describe the child role. Kept with the execution boundary so an
   * evicted child is rebuilt with the same focused-agent instruction before a later continuation. */
  promptAppend?: string[];
}

const MAX_PROJECT_IDS = 10_000;
const MAX_TOOL_NAMES = 2_000;
const MAX_TOOL_NAME_CHARS = 256;
const MAX_PROMPT_CHUNKS = 16;
const MAX_PROMPT_CHARS = 8_000;
// Shared budget for ALL system-prompt sections of a delegated child (role prompt + parent-supplied
// context + shared-channel fragment), fair-shared between them by packDelegatedPromptAppend. Raised from
// 32k so the operator-tunable delegateContextChars can actually reach its 80k ceiling instead of being
// trimmed straight back off. Hard ceiling above this is MAX_PROMPT_CHUNKS * CHUNK_BODY_CHARS = 127 616.
const MAX_PROMPT_TOTAL_CHARS = 120_000;
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function canonicalStrings(raw: unknown, maxItems: number, maxChars: number): string[] | undefined {
  if (!Array.isArray(raw) || raw.length > maxItems) return undefined;
  const values: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') return undefined;
    const clean = value.trim();
    if (!clean || clean.length > maxChars) return undefined;
    values.push(clean);
  }
  return [...new Set(values)].sort();
}

/** Validate and canonicalize persisted/untrusted JSON. Invalid state is intentionally indistinguishable
 * from missing state to callers: both must fail closed before an idle child can execute. */
export function normalizeDelegatedExecutionScope(raw: unknown): DelegatedExecutionScope | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.admin !== 'boolean' || typeof value.owner !== 'boolean') return undefined;
  if (!Array.isArray(value.projectIds) || value.projectIds.length > MAX_PROJECT_IDS) return undefined;
  const projectIds: number[] = [];
  for (const id of value.projectIds) {
    if (!Number.isSafeInteger(id) || id <= 0) return undefined;
    projectIds.push(id);
  }
  const canonicalProjectIds = [...new Set(projectIds)].sort((a, b) => a - b);
  // `all` is represented by admin=true and no project list; accepting both shapes would make a corrupted
  // row ambiguous and risks a later caller interpreting its project list as a narrower policy.
  if (value.admin && canonicalProjectIds.length) return undefined;

  // Required even when the installation has no granular-permission resolver: explicit null preserves
  // that exact "gate inert" behavior, while a missing field identifies an old/corrupted child that must
  // never resume under its durable row owner's ambient settings.
  if (!own(value, 'permissionBoundary')) return undefined;
  let permissionBoundary: NoninteractivePermissionBoundary | null;
  if (value.permissionBoundary === null) {
    permissionBoundary = null;
  } else {
    const normalized = normalizeNoninteractivePermissionBoundary(value.permissionBoundary);
    if (!normalized) return undefined;
    permissionBoundary = normalized;
  }

  let toolPolicy: DelegatedExecutionScope['toolPolicy'];
  if (own(value, 'toolPolicy')) {
    const rawPolicy = value.toolPolicy;
    if (!rawPolicy || typeof rawPolicy !== 'object' || Array.isArray(rawPolicy)) return undefined;
    const policy = rawPolicy as Record<string, unknown>;
    const hasAllow = own(policy, 'allow');
    const hasDeny = own(policy, 'deny');
    if (hasAllow && !Array.isArray(policy.allow)) return undefined;
    if (hasDeny && !Array.isArray(policy.deny)) return undefined;
    const allow = hasAllow ? canonicalStrings(policy.allow, MAX_TOOL_NAMES, MAX_TOOL_NAME_CHARS) : undefined;
    const deny = hasDeny ? canonicalStrings(policy.deny, MAX_TOOL_NAMES, MAX_TOOL_NAME_CHARS) : undefined;
    if ((hasAllow && !allow) || (hasDeny && !deny)) return undefined;
    if (hasAllow || hasDeny) toolPolicy = {
      ...(hasAllow ? { allow: allow! } : {}),
      ...(hasDeny ? { deny: deny! } : {}),
    };
  }

  let promptAppend: string[] | undefined;
  if (own(value, 'promptAppend')) {
    promptAppend = canonicalStrings(value.promptAppend, MAX_PROMPT_CHUNKS, MAX_PROMPT_CHARS);
    if (!promptAppend || promptAppend.reduce((n, text) => n + text.length, 0) > MAX_PROMPT_TOTAL_CHARS) return undefined;
    // System-prompt append order is meaningful. canonicalStrings sorts, so re-read the validated source
    // preserving its original order while deduplicating exact repeated chunks.
    const ordered = value.promptAppend as string[];
    const seen = new Set<string>();
    promptAppend = ordered.map((text) => text.trim()).filter((text) => {
      if (seen.has(text)) return false;
      seen.add(text);
      return true;
    });
  }

  return {
    admin: value.admin,
    projectIds: canonicalProjectIds,
    owner: value.owner,
    permissionBoundary,
    ...(toolPolicy ? { toolPolicy } : {}),
    ...(promptAppend ? { promptAppend } : {}),
  };
}

/** Ordered, field-by-field boundary equality. Rule ORDER is load-bearing (resolution is last-match-wins),
 *  and JSON.stringify would additionally depend on object key order, which callers do not guarantee. */
function sameBoundary(a: NoninteractivePermissionBoundary, b: NoninteractivePermissionBoundary): boolean {
  if (a.unattendedAsks !== b.unattendedAsks || a.rules.length !== b.rules.length) return false;
  return a.rules.every((rule, index) => {
    const other = b.rules[index];
    return !!other && other.scope === rule.scope && other.pattern === rule.pattern && other.action === rule.action;
  });
}

/** Whether a child's captured granular permissions grant more than the caller's current ones.
 *
 *  Deliberately EQUALITY, not a subset test: rules are ordered wildcard patterns resolved last-match-wins
 *  across two pattern spaces, so "is this ruleset contained in that one" is a real language-inclusion
 *  problem. An approximate implementation would silently ALLOW the escalation it was written to stop, so
 *  until a proven subset check exists this refuses every boundary it cannot prove identical.
 *
 *  The one accepted non-identity is the read-only clamp, recomputed from the caller's CURRENT boundary:
 *  an explore/plan child never equals its parent by construction, and admitting exactly the boundary that
 *  spawning it again right now would mint grants nothing the caller does not already hold this instant. */
function permissionBoundaryExceeds(
  child: NoninteractivePermissionBoundary | null,
  caller: NoninteractivePermissionBoundary | null,
): string | undefined {
  // An ungated caller has no granular authority for the child to exceed.
  if (caller === null) return undefined;
  // `null` is "no permission gate wired at all" — strictly wider than any gate the caller now runs on.
  if (child === null) return 'it captured no permission gate and this conversation now runs under one';
  if (sameBoundary(child, caller) || sameBoundary(child, buildReadOnlyBoundary(caller))) return undefined;
  return 'its captured tool permissions differ from the ones this conversation holds now';
}

/** Whether a PERSISTED child scope grants more than the delegating turn holds right now — returns the
 *  human-readable reason it exceeds, or undefined when the child fits inside the caller's current
 *  authority.
 *
 *  Spawning a child mints its scope from the parent's access, so the two agree by construction.
 *  CONTINUING one replays a scope minted earlier, and the conversation may have been narrowed since
 *  (projects revoked, an allow-list applied, the turn switched to planning). Without this check an old
 *  child would be a durable handle onto authority its parent has lost.
 *
 *  Only the comparison lives here. Tool DENIES are not a reason to refuse — the continuation path layers
 *  the caller's current denies onto the resumed policy, which only ever narrows it. */
export function scopeExceedsCurrentAccess(
  scope: DelegatedExecutionScope,
  access: {
    admin: boolean; projectIds: number[]; owner: boolean;
    toolPolicy?: { allow?: string[]; deny?: string[] };
    permissionBoundary: NoninteractivePermissionBoundary | null;
    readOnly?: boolean;
  },
): string | undefined {
  // A planning turn is read-only, and nothing in a persisted scope distinguishes a child that was
  // spawned read-only from an ordinary `tools: ['Read']` delegation whose Bash boundary was never
  // clamped. Guessing here would be the one way a plan-mode turn could reach a writing agent, so every
  // continuation fails closed instead.
  if (access.readOnly) return 'this turn is read-only (planning), which cannot continue a sub-agent — a planning turn may only spawn fresh read-only ones';
  if (scope.admin && !access.admin) return 'it holds all-project access and this conversation no longer does';
  if (!access.admin) {
    const held = new Set(access.projectIds);
    const lost = scope.projectIds.filter((id) => !held.has(id));
    if (lost.length) return `it is scoped to project(s) ${lost.join(', ')}, which this conversation no longer has`;
  }
  if (scope.owner && !access.owner) return 'it carries owner authority and this conversation does not';
  const callerAllow = access.toolPolicy?.allow;
  if (callerAllow) {
    const childAllow = scope.toolPolicy?.allow;
    // Absence means UNRESTRICTED, so an old child without an allow-list is strictly wider than a caller
    // that now runs on one. Reading a missing list as "narrow" is exactly the inversion to avoid.
    if (!childAllow) return 'it runs with an unrestricted toolset and this conversation is now limited to a specific one';
    const held = new Set(callerAllow);
    const extra = childAllow.filter((name) => !held.has(name));
    if (extra.length) return `it holds ${extra.join(', ')}, which this conversation does not`;
  }
  return permissionBoundaryExceeds(scope.permissionBoundary, access.permissionBoundary);
}

/** Semantically compare canonical durable scopes without trusting caller object identity or array order. */
export function sameDelegatedExecutionScope(a: DelegatedExecutionScope, b: DelegatedExecutionScope): boolean {
  const left = normalizeDelegatedExecutionScope(a);
  const right = normalizeDelegatedExecutionScope(b);
  return !!left && !!right && JSON.stringify(left) === JSON.stringify(right);
}

/** Add an account-level deny-list to an inherited scope. This only narrows access; an old deny remains
 * durable even if the account later re-enables that tool. */
export function withDelegatedDeniedTools(scope: DelegatedExecutionScope, denied: Iterable<string>): DelegatedExecutionScope {
  const extra = [...denied]
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && name.length <= MAX_TOOL_NAME_CHARS);
  // Preserve the captured JSON shape when there is nothing new to add. In particular, undefined policy
  // is distinct from the deliberately restrictive `allow: []` form and should not gain a synthetic
  // empty deny-list merely because this helper ran.
  if (extra.length === 0) {
    const unchanged = normalizeDelegatedExecutionScope(scope);
    if (!unchanged) throw new Error('invalid delegated access');
    return unchanged;
  }
  const normalized = normalizeDelegatedExecutionScope({
    ...scope,
    toolPolicy: {
      ...(scope.toolPolicy?.allow !== undefined ? { allow: scope.toolPolicy.allow } : {}),
      deny: [...(scope.toolPolicy?.deny ?? []), ...extra],
    },
  });
  // `scope` was validated on persistence/read and the bounded account list above cannot make it invalid.
  // Keep the explicit assertion here so a future change to the normalizer does not accidentally widen it.
  if (!normalized) throw new Error('invalid delegated access');
  return normalized;
}

/** Left on a section that did not fit its share of the prompt budget. A child reading a shortened role or
 *  context block cannot otherwise tell whether something was absent or merely cut off. */
export const PROMPT_TRUNCATION_MARKER = '\n[truncated to fit the delegated prompt budget]';
/** Room reserved on every chunk of a SPLIT section for its `[part i of n]` label. The label also keeps
 *  those chunks distinct, which is load-bearing: the normalizer above drops exact duplicate appends. */
const PART_LABEL_CHARS = 24;
/** Room reserved on the last chunk for the note counting sections that had no slot left at all. */
const DROP_NOTE_CHARS = 120;
const CHUNK_BODY_CHARS = MAX_PROMPT_CHARS - PART_LABEL_CHARS;

export interface PackedDelegatedPrompt {
  /** Chunks satisfying all three ceilings, in the order the sections were given. */
  promptAppend: string[];
  /** How many sections had to be shortened (each carries PROMPT_TRUNCATION_MARKER). */
  truncated: number;
  /** How many sections had no chunk slot left at all (counted on the last chunk). */
  dropped: number;
}

/** Max-min fair share of `total` across `demands`: nobody gets more than it asks for, and the slack the
 *  modest ones leave is redistributed to the greedy ones — so nothing shrinks while everything still fits. */
function fairShare(demands: readonly number[], total: number, capOf: (index: number) => number): number[] {
  const share = demands.map(() => 0);
  const smallestFirst = demands.map((_, index) => index).sort((a, b) => (demands[a] ?? 0) - (demands[b] ?? 0));
  let left = total;
  let open = smallestFirst.length;
  for (const index of smallestFirst) {
    const got = Math.max(0, Math.min(demands[index] ?? 0, capOf(index), Math.floor(left / open)));
    share[index] = got;
    left -= got;
    open -= 1;
  }
  return share;
}

/** A single-chunk section may use the whole per-chunk ceiling; a split one pays the part label per chunk. */
const sectionCapacity = (slots: number): number => (slots <= 1 ? MAX_PROMPT_CHARS : slots * CHUNK_BODY_CHARS);

/** Cut a section that outgrew one chunk into labelled parts. Its char budget is capped at the capacity of
 *  the slots it was granted, so the part count can never exceed them. */
function splitSection(body: string): string[] {
  if (body.length <= MAX_PROMPT_CHARS) return [body];
  const parts = Math.ceil(body.length / CHUNK_BODY_CHARS);
  return Array.from({ length: parts }, (_, index) =>
    `[part ${index + 1} of ${parts}]\n${body.slice(index * CHUNK_BODY_CHARS, (index + 1) * CHUNK_BODY_CHARS)}`);
}

/** Fit a delegated child's system-prompt sections — its role prompt, the parent-supplied context blocks
 *  and the shared-channel fragment — inside the three ceilings normalizeDelegatedExecutionScope enforces.
 *
 *  None of those sections is bounded upstream: a user-authored `.md` agent role of 20 000 chars breaches
 *  the per-chunk ceiling on its own, which invalidated the WHOLE scope and left the child unable to spawn
 *  at all. So a long section is SPLIT across chunks rather than rejected, every section keeps at least an
 *  even share of the budget, and whatever had to be cut says so instead of vanishing. */
export function packDelegatedPromptAppend(sections: readonly string[]): PackedDelegatedPrompt {
  const parts = sections.map((section) => section.trim()).filter((section) => section.length > 0);
  const kept = parts.slice(0, MAX_PROMPT_CHUNKS);
  const dropped = parts.length - kept.length;
  const slots = fairShare(
    kept.map((part) => Math.ceil(part.length / CHUNK_BODY_CHARS)),
    MAX_PROMPT_CHUNKS,
    () => MAX_PROMPT_CHUNKS,
  );
  const chars = fairShare(
    kept.map((part) => part.length),
    MAX_PROMPT_TOTAL_CHARS - MAX_PROMPT_CHUNKS * PART_LABEL_CHARS - DROP_NOTE_CHARS,
    (index) => sectionCapacity(slots[index] ?? 1),
  );
  const chunks: string[] = [];
  let truncated = 0;
  for (const [index, part] of kept.entries()) {
    const allowed = chars[index] ?? 0;
    if (part.length <= allowed) { chunks.push(...splitSection(part)); continue; }
    truncated += 1;
    chunks.push(...splitSection(
      `${part.slice(0, Math.max(1, allowed - PROMPT_TRUNCATION_MARKER.length))}${PROMPT_TRUNCATION_MARKER}`,
    ));
  }
  const tail = chunks.at(-1);
  if (dropped > 0 && tail !== undefined) {
    const note = `\n[${dropped} further prompt section(s) dropped — the delegated prompt budget is full]`;
    chunks[chunks.length - 1] = `${tail.slice(0, MAX_PROMPT_CHARS - note.length)}${note}`;
  }
  return { promptAppend: chunks, truncated, dropped };
}

/** Rehydrate the execution-time plugin-tool policy. An empty allow-list is preserved as a real empty Set. */
export function delegatedToolPolicy(scope: DelegatedExecutionScope, currentDenied: Iterable<string> = []): ToolPolicy | undefined {
  const narrowed = withDelegatedDeniedTools(scope, currentDenied);
  const allow = narrowed.toolPolicy?.allow;
  const deny = narrowed.toolPolicy?.deny;
  if (allow === undefined && (!deny || deny.length === 0)) return undefined;
  return {
    ...(allow !== undefined ? { allow: new Set(allow) } : {}),
    ...(deny && deny.length ? { deny: new Set(deny) } : {}),
  };
}
