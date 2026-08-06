import { createHash } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { logger } from '../../shared/logger.js';
import { cacheTtlMs } from './cacheTiming.js';
import { currentTurnMode, type TurnWorkMode } from '../../plugins/policyContext.js';

/** Prompt-cache observability, modeled on Claude Code's promptCacheBreakDetection. In a healthy
 * append-only conversation `cacheRead` grows monotonically: each request reads the prefix the previous
 * request wrote. A DROP means the prefix changed or Anthropic evicted/routed away from it. The payload
 * monitor hashes the exact provider request so the warning can distinguish those cases without retaining
 * prompt content.
 *
 * Two expected drops are suppressed: a real compaction (baseline resets) and an idle gap beyond the cache
 * TTL. Installed for Anthropic sessions only; other providers report best-effort cache stats whose drops
 * are routine noise. */

const log = logger('brain-cache');

/** Below BOTH thresholds a drop is noise: small absolute swings happen with thinking-block variance. */
export const CACHE_DROP_MIN_TOKENS = 2000;
const CACHE_DROP_MIN_RATIO = 0.05;
/** The provider request can contain thousands of messages. Tracking its stable prefix is enough to catch
 * egress rewrites while bounding both hashing work and retained digests. */
const MAX_TRACKED_HISTORY_SEGMENTS = 512;
const MAX_TRACKED_TOOL_SEGMENTS = 256;
const MAX_PENDING_SNAPSHOTS = 2;

interface HashedSegment {
  hash: string;
  label: string;
  /** Tool segments only: the schema carries Anthropic's `defer_loading`, so the API keeps it OUT of the
   *  cached prefix (see {@link deferredOnlyAppend}). */
  deferred?: true;
}

interface CachePayloadSnapshot {
  systemHash: string;
  toolsHash: string;
  tools: HashedSegment[];
  toolCount: number;
  deferredToolCount: number;
  history: HashedSegment[];
  historyCount: number;
  /** Work mode of the turn that sent this request, captured while the prompt scope is still active. */
  turnMode?: TurnWorkMode;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? '').digest('hex');
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeToolLabel(value: unknown, index: number): string {
  const name = record(value)?.name;
  if (typeof name !== 'string') return `#${index}`;
  return name.startsWith('mcp__') ? 'mcp' : name;
}

function historyLabel(value: unknown, index: number): string {
  const message = record(value);
  const role = typeof message?.role === 'string' ? message.role : 'unknown';
  const content = Array.isArray(message?.content) ? message.content : [];
  const toolResult = content.some((block) => record(block)?.type === 'tool_result');
  return `${index}:${role}${toolResult ? '/tool_result' : ''}`;
}

function isDeferredTool(value: unknown): boolean {
  return record(value)?.defer_loading === true;
}

function snapshotPayload(value: unknown, turnMode: TurnWorkMode | undefined): CachePayloadSnapshot {
  const payload = record(value);
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  return {
    systemHash: hash(payload?.system),
    toolsHash: hash(tools),
    tools: tools.slice(0, MAX_TRACKED_TOOL_SEGMENTS).map((tool, index) => ({
      hash: hash(tool),
      label: safeToolLabel(tool, index),
      ...(isDeferredTool(tool) ? { deferred: true as const } : {}),
    })),
    toolCount: tools.length,
    deferredToolCount: tools.filter(isDeferredTool).length,
    history: messages.slice(0, MAX_TRACKED_HISTORY_SEGMENTS).map((message, index) => ({
      hash: hash(message), label: historyLabel(message, index),
    })),
    historyCount: messages.length,
    ...(turnMode ? { turnMode } : {}),
  };
}

/** One recorder per session. The pre-request extension stores only bounded hashes; cacheWatch consumes the
 * corresponding snapshot when that request's assistant message ends. */
export interface CachePayloadMonitor {
  extension: (pi: ExtensionAPI) => void;
  consumeSnapshot: () => CachePayloadSnapshot | undefined;
  /** Drop snapshots that predate a compaction, so none can pair with a post-compaction response. */
  clearPending: () => void;
}

export function createCachePayloadMonitor(): CachePayloadMonitor {
  const pending: CachePayloadSnapshot[] = [];
  return {
    extension: (pi) => {
      pi.on('before_provider_request', (event) => {
        // currentTurnMode() is only meaningful here, inside the prompt scope that owns the request; the
        // message_end handler that consumes the snapshot has no such guarantee.
        pending.push(snapshotPayload(event.payload, currentTurnMode()));
        while (pending.length > MAX_PENDING_SNAPSHOTS) pending.shift();
      });
    },
    consumeSnapshot: () => pending.shift(),
    clearPending: () => { pending.length = 0; },
  };
}

function changedLabels(previous: HashedSegment[], current: HashedSegment[]): string[] {
  const changed: string[] = [];
  const common = Math.min(previous.length, current.length);
  for (let index = 0; index < common; index += 1) {
    if (previous[index]?.hash !== current[index]?.hash) {
      changed.push(current[index]?.label ?? `#${index}`);
    }
  }
  return changed;
}

function formatLabels(labels: string[]): string {
  const visible = labels.slice(0, 5);
  return `${visible.join(', ')}${labels.length > visible.length ? ` (+${labels.length - visible.length} more)` : ''}`;
}

/** A position-aligned comparison cannot tell a REWRITE from a SHIFT: insert one message mid-history and
 *  every later index mismatches, which reads as though the whole tail was rewritten. The distinction is
 *  the whole point of this warning — a rewrite of an already-sent message is a cost defect we must fix,
 *  while an insertion is ordinary (live recall anchors a frozen meta message into the stream). So the
 *  divergence is classified instead of merely listed. */
type SegmentDelta =
  | { kind: 'none' }
  | { kind: 'appended'; count: number }
  | { kind: 'dropped'; count: number }
  | { kind: 'rewritten'; label: string; labels: string[] }
  | { kind: 'inserted'; label: string; count: number }
  | { kind: 'removed'; label: string; count: number };

/** How far ahead to look for the originals resuming. Past a handful of segments the shift hypothesis
 *  stops being more likely than a genuine rewrite, and saying "rewritten" is the safer report. */
const MAX_SHIFT_PROBE = 16;

/** Do `original`'s segments resume `shift` positions later in `shifted` — i.e. was something inserted at
 *  `at`? Two consecutive matches are required so a single coincidental hash cannot pass as a shift. */
function resumesAfterShift(
  original: HashedSegment[],
  shifted: HashedSegment[],
  at: number,
  shift: number,
): boolean {
  const probe = Math.min(2, original.length - at);
  if (probe <= 0) return false;
  for (let offset = 0; offset < probe; offset += 1) {
    if (original[at + offset]?.hash !== shifted[at + shift + offset]?.hash) return false;
  }
  return true;
}

/** Anthropic's cache is prefix-based, so only the FIRST divergence can explain a drop; everything after
 *  it is already past the break. */
function classifySegments(previous: HashedSegment[], current: HashedSegment[]): SegmentDelta {
  const common = Math.min(previous.length, current.length);
  let diverged = -1;
  for (let index = 0; index < common; index += 1) {
    if (previous[index]?.hash !== current[index]?.hash) { diverged = index; break; }
  }
  if (diverged < 0) {
    if (current.length > previous.length) return { kind: 'appended', count: current.length - previous.length };
    if (current.length < previous.length) return { kind: 'dropped', count: previous.length - current.length };
    return { kind: 'none' };
  }
  for (let shift = 1; shift <= MAX_SHIFT_PROBE; shift += 1) {
    if (resumesAfterShift(previous, current, diverged, shift)) {
      return { kind: 'inserted', label: current[diverged]?.label ?? `#${diverged}`, count: shift };
    }
    if (resumesAfterShift(current, previous, diverged, shift)) {
      return { kind: 'removed', label: previous[diverged]?.label ?? `#${diverged}`, count: shift };
    }
  }
  return {
    kind: 'rewritten',
    label: current[diverged]?.label ?? `#${diverged}`,
    labels: changedLabels(previous, current),
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** The tools array is hashed into the cached prefix as one block, so ANY delta there — an append
 *  included — invalidates every message behind it. Activating a deferred tool mid-conversation is the
 *  common cause and is worth naming as such rather than as an anonymous change. */
function describeToolDelta(delta: SegmentDelta): string {
  switch (delta.kind) {
    case 'appended': return `${plural(delta.count, 'tool')} appended`;
    case 'dropped': return `${plural(delta.count, 'tool')} dropped`;
    case 'inserted': return `${plural(delta.count, 'tool')} inserted at ${delta.label}`;
    case 'removed': return `${plural(delta.count, 'tool')} removed at ${delta.label}`;
    case 'rewritten': return `segments ${formatLabels(delta.labels)}`;
    case 'none': return 'outside tracked segments or order';
  }
}

/** History is append-only in a healthy conversation, so an append is silence. Everything else is
 *  reported, and only `rewritten` is the alarming one. */
function describeHistoryDelta(delta: SegmentDelta): string | undefined {
  switch (delta.kind) {
    case 'none':
    case 'appended':
      return undefined;
    case 'dropped':
      return `history lost ${plural(delta.count, 'trailing message')}`;
    case 'inserted':
      return `${plural(delta.count, 'message')} inserted into history at ${delta.label} `
        + '(a shift, not a rewrite — the prefix resumes unchanged after it)';
    case 'removed':
      return `${plural(delta.count, 'message')} removed from history at ${delta.label}`;
    case 'rewritten':
      return `history REWRITTEN IN PLACE at ${delta.label} — an already-sent message changed`;
  }
}

/** Anthropic excludes `defer_loading` tools from the system-prompt prefix and expands them inline through
 *  `tool_reference` blocks, so appending one CANNOT be what broke the prefix — reporting it as the cause
 *  sends the reader after the wrong culprit (activating a deferred tool is exactly when the payload grows
 *  by one deferred schema). Only an append is forgiven: a tool moving out of the deferred tail, or any
 *  edit among the immediate ones, does change the cached block. Truncated tracking abstains, since the
 *  appended segments may lie past the tracked window. */
function deferredOnlyAppend(
  delta: SegmentDelta,
  previous: CachePayloadSnapshot,
  current: CachePayloadSnapshot,
): boolean {
  if (delta.kind !== 'appended') return false;
  if (previous.tools.length !== previous.toolCount || current.tools.length !== current.toolCount) return false;
  const appended = current.tools.slice(previous.tools.length);
  return appended.length > 0 && appended.every((segment) => segment.deferred === true);
}

function attributePayloadChange(
  previous: CachePayloadSnapshot | undefined,
  current: CachePayloadSnapshot | undefined,
): string {
  if (!previous || !current) return 'payload snapshot unavailable';
  const changes: string[] = [];
  const notes: string[] = [];
  // Worth reporting as CONTEXT, never as the cause. Plan mode used to narrow the tool set, which rehashed
  // the prefix and made a switch an expected break — but enforcement moved to execute time, so the mode no
  // longer touches system or tools at all. A drop that coincides with a switch is therefore a REAL break,
  // and calling the mode the culprit would suppress the eviction hint below and send the next
  // investigation somewhere there is nothing to find.
  const modeSwitched = previous.turnMode && current.turnMode && previous.turnMode !== current.turnMode;
  if (previous.systemHash !== current.systemHash) changes.push('system prompt changed');
  if (previous.toolsHash !== current.toolsHash) {
    const delta = classifySegments(previous.tools, current.tools);
    const count = previous.toolCount === current.toolCount ? '' : `, count ${previous.toolCount}→${current.toolCount}`;
    if (deferredOnlyAppend(delta, previous, current)) {
      notes.push(`${plural(current.deferredToolCount, 'deferred tool')} in the payload`
        + `${count} — excluded from the cached prefix, so not the cause`);
    } else {
      const deferred = current.deferredToolCount > 0 ? `, ${current.deferredToolCount} deferred` : '';
      changes.push(`tools changed (${describeToolDelta(delta)}${count}${deferred})`);
    }
  }
  const historyDelta = describeHistoryDelta(classifySegments(previous.history, current.history));
  if (historyDelta) changes.push(historyDelta);
  if (current.historyCount < previous.historyCount) {
    changes.push(`history truncated ${previous.historyCount}→${current.historyCount}`);
  }
  if (modeSwitched) notes.push(`turn mode changed ${previous.turnMode}→${current.turnMode}`);
  const suffix = notes.length > 0 ? ` [${notes.join('; ')}]` : '';
  if (changes.length > 0) return `${changes.join('; ')}${suffix}`;
  const tracked = Math.min(previous.history.length, current.history.length);
  const prefix = notes.length > 0 ? 'cached prefix unchanged' : 'tracked payload prefix unchanged';
  return `${prefix} (system, tools, first ${tracked} history messages); likely provider eviction or routing${suffix}`;
}

type SessionEvent = { type?: string; message?: { role?: string; timestamp?: number; stopReason?: string; usage?: { cacheRead?: number } }; aborted?: boolean; result?: unknown };
type Subscribable = { subscribe?: (listener: (event: SessionEvent) => void) => unknown };

export interface CacheWatchOptions {
  /** Warm window in ms; a drop after a longer gap is TTL expiry, not a break. Defaults to the cache
   * TTL MINUS a 1-minute buffer — the opposite rounding direction from the clearing gate. */
  ttlMs?: number;
  now?: () => number;
  monitor?: CachePayloadMonitor;
  /** Conversation id to report in warnings, so a drop can be traced to the session it happened in. */
  sessionId?: string;
}

export function installCacheWatch(
  session: Subscribable,
  options: CacheWatchOptions = {},
): void {
  if (typeof session.subscribe !== 'function') return;
  const ttlMs = options.ttlMs ?? (cacheTtlMs(process.env) - 60_000);
  const now = options.now ?? Date.now;
  let previous: { cacheRead: number; at: number; snapshot?: CachePayloadSnapshot } | null = null;
  session.subscribe((event) => {
    if (event.type === 'compaction_end' && !event.aborted && event.result) {
      // Post-compaction history is genuinely smaller; the next request's lower cacheRead is by design.
      previous = null;
      // A snapshot taken by a request BEFORE the compaction describes a payload that no longer exists;
      // leaving it queued would pair it with the first response after the compaction and attribute the
      // next drop to that stale request.
      options.monitor?.clearPending();
      return;
    }
    if (event.type !== 'message_end') return;
    const message = event.message;
    if (message?.role !== 'assistant') return;
    const snapshot = options.monitor?.consumeSnapshot();
    // A request that errored or was aborted reports usage as all-zero. Consume its request snapshot, but
    // keep the last successful response and payload as the comparison baseline.
    if (message.stopReason === 'error' || message.stopReason === 'aborted') return;
    const cacheRead = message.usage?.cacheRead;
    if (typeof cacheRead !== 'number') return;
    const at = typeof message.timestamp === 'number' ? message.timestamp : now();
    if (previous) {
      const drop = previous.cacheRead - cacheRead;
      if (
        drop > CACHE_DROP_MIN_TOKENS
        && drop / previous.cacheRead > CACHE_DROP_MIN_RATIO
        && at - previous.at < ttlMs
      ) {
        log.warn(
          `${options.sessionId ? `[session ${options.sessionId}] ` : ''}`
          + `prompt cache read dropped within a warm window: ${previous.cacheRead} → ${cacheRead} tokens `
          + `(${Math.round((at - previous.at) / 1000)}s apart) — ${attributePayloadChange(previous.snapshot, snapshot)}`,
        );
      }
    }
    previous = { cacheRead, at, ...(snapshot ? { snapshot } : {}) };
  });
}
