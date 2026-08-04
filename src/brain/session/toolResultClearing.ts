import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { fsSafeSegment, toolResultSpillDir } from '../../shared/paths.js';
import { logger } from '../../shared/logger.js';
import type { PiAgentMessage } from './historyImageStripping.js';
import { cacheColdAtTurnStart, cacheTtlMs, idleThresholdMs } from './cacheTiming.js';
import { isUserTurn } from './userTurn.js';

export { cacheColdAtTurnStart, cacheTtlMs, idleThresholdMs };

/** Egress-only clearing of large historical tool results — the transferable core of Claude Code's
 *  time-based microcompact, adapted to Elowen's `transformContext` seam (the same hook
 *  `historyImageStripping` composes onto). Anthropic's prompt cache is prefix-based, so the one rule
 *  that matters is: NEVER rewrite history while the cache could still be warm. Two mechanisms enforce
 *  it:
 *
 *  1. The gate opens only when the turn's first user message arrived MORE than the cache TTL after the
 *     previous message — i.e. the cached prefix had already expired and this provider call pays a full
 *     re-cache either way. Clearing here SHRINKS that rewrite instead of costing anything.
 *  2. A per-session latch (Map of cleared toolCallIds → original bytes) guarantees a result once
 *     cleared stays cleared on every later request, so the prefix is byte-stable from then on. The
 *     latch lives in this closure; a respawn loses it. The cache is server-side, so a respawn WITHIN
 *     the TTL is NOT cold — the first request then re-sends the full results and pays one full
 *     re-cache of the restored (larger) prefix. Correct, just expensive; the gate re-clears on the
 *     next idle turn. Rebuilding the latch from disk would also need the original byte counts
 *     persisted (the placeholder embeds them), so we accept the one-off cost instead.
 *
 *  The full text is spilled to `<dataDir>/tool-results/<sessionId>/<toolCallId>.txt` BEFORE the
 *  placeholder replaces it (write-once, `wx`), so clearing loses nothing the model could not re-read
 *  with the Read tool — pathGuard lets every session read its OWN spill dir. Persisted history in
 *  the store is untouched — this runs on PI's egress copy.
 *
 *  A SECOND trigger shares all of that machinery: a single result bigger than SPILL_MAX_RESULT_BYTES
 *  is spilled on SIZE at delivery, whatever the idle gate says (Claude Code's
 *  DEFAULT_MAX_RESULT_SIZE_CHARS behaves the same way). It is restricted to the current run — the
 *  results produced after the last user message — because those have not been sent to the provider
 *  yet: replacing one there APPENDS a smaller block to the prefix instead of rewriting a cached one,
 *  so rule 1 still holds. Everything older stays the time gate's business. Because the model never
 *  gets to see such a result at all, this placeholder also carries a preview of the content; the
 *  time-triggered one does not, since the model already read that result earlier in the conversation. */

const log = logger('brain-tool-clearing');

/** Results smaller than this stay in context: clearing them saves a handful of tokens while costing a
 *  spill file and a placeholder. 4 KB ≈ 1k tokens. */
export const CLEAR_MIN_BYTES = 4096;

/** A single fresh result above this size is spilled the moment it would be delivered, without waiting
 *  for the idle gate: at ~12k tokens one result of this size costs more context than the whole rest of
 *  a typical turn, and the model can read it back in full from the spill path.
 *
 *  50 000 is Claude Code's DEFAULT_MAX_RESULT_SIZE_CHARS, kept as the DEFAULT of the operator-tunable
 *  `toolResultInlineBytes` knob (Elowen AI → Limits) — `toolOutputMaxChars` caps the TRANSCRIPT preview,
 *  not what the model receives, so it neither bounds nor competes with this. Measured in bytes rather than
 *  characters because this module already measures in bytes (textBytes, CLEAR_MIN_BYTES); for the
 *  ASCII-dominant output that reaches this size the two differ by a rounding error, and one measure beats
 *  two. */
export const SPILL_MAX_RESULT_BYTES = 50_000;

/** The size trigger's threshold, resolved live so a Limits change applies without a restart — the same
 *  module-level-resolver seam messageView uses for its tool-output caps ({@link setToolOutputCaps}).
 *  Injected once at bootstrap; defaults to {@link SPILL_MAX_RESULT_BYTES} so tests and any un-wired path
 *  keep the historical behaviour. */
let spillMaxResultBytes: () => number = () => SPILL_MAX_RESULT_BYTES;
export function setSpillMaxResultBytes(resolve: () => number): void { spillMaxResultBytes = resolve; }

/** How much of a size-spilled result the placeholder carries, so the model can tell what it got — and
 *  whether it is worth a Read — without the full text. 2 000 matches Claude Code's preview budget.
 *  Sliced by CHARACTERS on purpose: a byte slice can cut a multi-byte character in half, and the point
 *  of the cap is bounding the placeholder, which a char count does well enough. */
export const SPILL_PREVIEW_CHARS = 2000;

/** How many trailing user turns keep their tool results intact: the current run (after the last user
 *  message) plus the whole previous turn. Everything older is eligible once the gate opens. */
const KEEP_USER_TURNS = 2;

/** Deterministic spill path — the placeholder builds it without any I/O, so the transform stays pure.
 *  The id is fs-encoded like the session id: a provider/plugin-minted toolCallId containing `/` or
 *  `..` must not escape the spill dir (pathGuard would refuse the escaped path and the cleared
 *  content would be unreadable). */
export function toolResultSpillPath(spillDir: string, toolCallId: string): string {
  return join(spillDir, `${fsSafeSegment(toolCallId)}.txt`);
}

/** The one placeholder shape both triggers use. With a preview the wording says the result was never
 *  put in the context (size trigger); without one it says an older result was cleared (time trigger).
 *  The preview follows the bracketed notice as plain text so the notice itself stays a single line. */
export function clearedToolResultPlaceholder(
  spillPath: string,
  originalBytes: number,
  preview?: string,
): string {
  if (preview === undefined) {
    return `[Older tool result cleared to save context. Full output saved at: ${spillPath} — read it with the Read tool if needed. Original size: ${originalBytes} bytes.]`;
  }
  return `[Large tool result (${originalBytes} bytes) saved to disk instead of the context. Full output at: ${spillPath} — read it with the Read tool if needed. First ${preview.length} characters below.]\n${preview}`;
}

type ToolResultMessage = Extract<PiAgentMessage, { role: 'toolResult' }>;
type ContentBlock = ToolResultMessage['content'][number];

function textBytes(message: ToolResultMessage): number {
  if (!Array.isArray(message.content)) return 0;
  let total = 0;
  for (const block of message.content) {
    if (block.type === 'text') total += Buffer.byteLength(block.text, 'utf8');
  }
  return total;
}

/** Index of the user message that starts the KEEP_USER_TURNS-th turn from the end, or -1 when the
 *  conversation is shorter. Messages before it are eligible for clearing. Exported for tests. */
export function clearingCutIndex(messages: readonly PiAgentMessage[]): number {
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!isUserTurn(messages[index])) continue;
    seen += 1;
    if (seen === KEEP_USER_TURNS) return index;
  }
  return -1;
}

export interface ClearableResult {
  index: number;
  toolCallId: string;
  bytes: number;
}

/** Pure selection: which tool results may be cleared on this pass. Eligible = toolResult before the
 *  cut, ≥ CLEAR_MIN_BYTES of text, with a toolCallId (no id → no spill path → never cleared), not
 *  already latched. Exported for tests. */
export function selectClearableToolResults(
  messages: PiAgentMessage[],
  alreadyCleared: ReadonlySet<string>,
): ClearableResult[] {
  const cut = clearingCutIndex(messages);
  if (cut <= 0) return [];
  const selection: ClearableResult[] = [];
  for (let index = 0; index < cut; index += 1) {
    const message = messages[index];
    if (message?.role !== 'toolResult') continue;
    if (!message.toolCallId || alreadyCleared.has(message.toolCallId)) continue;
    const bytes = textBytes(message);
    if (bytes < CLEAR_MIN_BYTES) continue;
    selection.push({ index, toolCallId: message.toolCallId, bytes });
  }
  return selection;
}

/** Index of the message that opened the current run, or -1 when the conversation has no user message
 *  yet. Everything after it was produced during this turn. */
function lastUserIndex(messages: readonly PiAgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isUserTurn(messages[index])) return index;
  }
  return -1;
}

/** Pure selection for the size trigger: results of the CURRENT run (after the last user message) that
 *  are too large to hand to the model at all. Deliberately the complement of
 *  selectClearableToolResults' region — a result the provider has already seen must not be rewritten
 *  outside the idle gate, however big it is. Exported for tests. */
export function selectOversizedToolResults(
  messages: PiAgentMessage[],
  alreadyCleared: ReadonlySet<string>,
): ClearableResult[] {
  const selection: ClearableResult[] = [];
  for (let index = lastUserIndex(messages) + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== 'toolResult') continue;
    if (!message.toolCallId || alreadyCleared.has(message.toolCallId)) continue;
    const bytes = textBytes(message);
    if (bytes <= spillMaxResultBytes()) continue;
    selection.push({ index, toolCallId: message.toolCallId, bytes });
  }
  return selection;
}

/** Pure replacement: swap each selected message's content for the placeholder text block. Input is
 *  never mutated and unselected messages keep their references (idempotence, same contract as
 *  stripHistoricalImages). Exported for tests. */
export function applyToolResultClearing(
  messages: PiAgentMessage[],
  cleared: ReadonlyMap<string, { index: number; placeholder: string }>,
): PiAgentMessage[] {
  let changed = false;
  const next = messages.map((message, index): PiAgentMessage => {
    if (message?.role !== 'toolResult') return message;
    const entry = cleared.get(message.toolCallId);
    if (!entry || entry.index !== index) return message;
    const already = Array.isArray(message.content)
      && message.content.length === 1
      && message.content[0]?.type === 'text'
      && message.content[0].text === entry.placeholder;
    if (already) return message;
    changed = true;
    return { ...message, content: [{ type: 'text', text: entry.placeholder }] };
  });
  return changed ? next : messages;
}

export interface ToolResultClearingOptions {
  /** Directory the spill files land in; defaults to `<dataDir>/tool-results/<sessionId>`. */
  spillDir?: string;
  /** Idle gate in ms; defaults to idleThresholdMs(process.env). */
  idleMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
  /** Spill writer injection for tests. Receives the absolute path and the full text. */
  writeSpill?: (path: string, text: string) => Promise<void>;
  /** Spill reader injection for tests; null = unreadable/missing. Used to verify an EEXIST survivor. */
  readSpill?: (path: string) => Promise<string | null>;
}

async function defaultWriteSpill(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { flag: 'wx' });
}

async function defaultReadSpill(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch { return null; }
}

/** Compose the clearing pass onto the session's `transformContext`, after (inside) any previous hook —
 *  installed after installHistoryImageStripping so it sees images already collapsed. Same wrap pattern
 *  as the other installers; a session without the agent seam is a no-op. */
export function installToolResultClearing(
  session: { agent?: { transformContext?: NonNullable<AgentSession['agent']['transformContext']> } },
  sessionId: string,
  options: ToolResultClearingOptions = {},
): void {
  const agent = session.agent;
  if (!agent) return;
  const spillDir = options.spillDir ?? toolResultSpillDir(process.env, sessionId);
  const idleMs = options.idleMs ?? idleThresholdMs(process.env);
  const now = options.now ?? Date.now;
  const writeSpill = options.writeSpill ?? defaultWriteSpill;
  const readSpill = options.readSpill ?? defaultReadSpill;
  /** Cleared toolCallId → its original text size in bytes, plus the preview a size-spilled result
   *  keeps in its placeholder. The latch is what makes the egress prefix byte-stable across requests:
   *  once inside, the placeholder never reverts to full content — and rebuilding it from the same
   *  entry every pass is what keeps those bytes identical. */
  const latched = new Map<string, { bytes: number; preview?: string }>();
  /** toolCallIds whose spill failed during THIS idle epoch. The gate stays open for a whole turn, so
   *  retrying on the next pass would clear right after THIS pass paid a full re-cache — a warm-prefix
   *  rewrite, the one thing this module must never do. Retries wait for the next gate OPENING. */
  const failedSpills = new Set<string>();
  /** toolCallIds whose spill path is occupied by a DIFFERENT file. `wx` can never overwrite it, so
   *  retrying could only ever warn again — skip permanently (for this session's lifetime). */
  const foreignSpills = new Set<string>();
  let gateWasOpen = false;
  const previous = agent.transformContext;
  agent.transformContext = async (messages, signal) => {
    const base = previous ? await previous(messages, signal) : messages;
    const gateOpen = cacheColdAtTurnStart(base, idleMs, now());
    if (gateOpen && !gateWasOpen) failedSpills.clear();
    gateWasOpen = gateOpen;
    /** Spill and latch a selection. Shared by both triggers, so a size-spilled result gets the same
     *  write-once semantics, the same EEXIST reconciliation and the same one-attempt-per-epoch retry
     *  rule. That rule matters just as much here: once a size spill has failed, the full result has
     *  gone out to the provider, so retrying it before the gate re-opens would rewrite a warm prefix. */
    const spillSelected = async (items: ClearableResult[], withPreview: boolean): Promise<void> => {
      for (const item of items) {
        if (failedSpills.has(item.toolCallId) || foreignSpills.has(item.toolCallId)) continue;
        const message = base[item.index] as ToolResultMessage;
        const text = (Array.isArray(message.content) ? message.content : [])
          .filter((block: ContentBlock): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
          .map((block) => block.text)
          .join('\n');
        const entry = { bytes: item.bytes, preview: withPreview ? text.slice(0, SPILL_PREVIEW_CHARS) : undefined };
        const spillPath = toolResultSpillPath(spillDir, item.toolCallId);
        try {
          await writeSpill(spillPath, text);
          latched.set(item.toolCallId, entry);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            // SOMETHING already sits at the path: a pre-respawn spill of this same output, or a file
            // the session itself wrote (its own spill dir is inside its allowed paths). Latch only
            // when the on-disk bytes are exactly what we would have written — otherwise the
            // placeholder would point at text that was never the tool's output.
            let onDisk: string | null = null;
            try { onDisk = await readSpill(spillPath); }
            catch { onDisk = null; } // a throwing readSpill must not take the whole turn down
            if (onDisk === text) {
              latched.set(item.toolCallId, entry);
              continue;
            }
            foreignSpills.add(item.toolCallId);
            log.warn(`tool result spill for ${item.toolCallId} conflicts with a different file on disk — leaving the result in context`);
            continue;
          }
          failedSpills.add(item.toolCallId);
          log.warn(`tool result spill failed for ${item.toolCallId}`, error);
        }
      }
    };
    if (gateOpen) {
      await spillSelected(selectClearableToolResults(base, new Set(latched.keys())), false);
    }
    // Runs on every pass, gate or no gate: an oversized result of the current run has not reached the
    // provider yet, so this is the only chance to keep it out of the context entirely.
    await spillSelected(selectOversizedToolResults(base, new Set(latched.keys())), true);
    if (latched.size === 0) return base;
    const cleared = new Map<string, { index: number; placeholder: string }>();
    for (let index = 0; index < base.length; index += 1) {
      const message = base[index];
      if (message?.role !== 'toolResult') continue;
      const entry = latched.get(message.toolCallId);
      if (entry === undefined) continue;
      cleared.set(message.toolCallId, {
        index,
        placeholder: clearedToolResultPlaceholder(
          toolResultSpillPath(spillDir, message.toolCallId),
          entry.bytes,
          entry.preview,
        ),
      });
    }
    return applyToolResultClearing(base, cleared);
  };
}
