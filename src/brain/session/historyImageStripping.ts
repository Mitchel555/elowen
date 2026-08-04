import { createHash } from 'node:crypto';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { cacheColdAtTurnStart, idleThresholdMs } from './cacheTiming.js';
import { isUserTurn } from './userTurn.js';

/** PI's `transformContext` hook signature and its message type, derived from the hook itself —
 *  `@earendil-works/pi-agent-core` (where AgentMessage lives) is not a direct dependency, so the
 *  types are pulled off the AgentSession surface the codebase already imports. */
type AgentTransformContext = NonNullable<AgentSession['agent']['transformContext']>;
export type PiAgentMessage = Awaited<ReturnType<AgentTransformContext>>[number];
/** The roles whose `content` can carry `{type:'image'}` blocks (assistant content cannot by type). */
type ImageBearingMessage = Extract<PiAgentMessage, { role: 'user' | 'toolResult' | 'custom' }>;
type ContentBlock = Extract<ImageBearingMessage['content'], readonly unknown[]>[number];

export const HISTORY_IMAGE_PLACEHOLDER = '[image omitted from history]';

/** Replace every image block with the placeholder, collapsing consecutive placeholders the same way
 *  PI's own `downgradeUnsupportedImages` does. Returns null when the content holds no image (so the
 *  caller keeps the original reference — this is also what makes the transform idempotent). */
function collapseImages(content: readonly ContentBlock[]): ContentBlock[] | null {
  if (!content.some((block) => block.type === 'image')) return null;
  const result: ContentBlock[] = [];
  let previousWasPlaceholder = false;
  for (const block of content) {
    if (block.type === 'image') {
      if (!previousWasPlaceholder) result.push({ type: 'text', text: HISTORY_IMAGE_PLACEHOLDER });
      previousWasPlaceholder = true;
      continue;
    }
    result.push(block);
    previousWasPlaceholder = block.type === 'text' && block.text === HISTORY_IMAGE_PLACEHOLDER;
  }
  return result;
}

/** Egress-only, source-agnostic image stripping for the provider request context.
 *
 * PI never downgrades images for vision-capable models, so every historical screenshot/read image is
 * re-serialized into EVERY provider call and the context grows monotonically. This strips image blocks
 * from all messages BEFORE the last user message — i.e. images that have scrolled into history — while
 * the current run (the last user message and everything after it) keeps its real images, so the model
 * still sees a freshly-read image on the step that consumes it. Pure and non-mutating: unchanged
 * messages/arrays keep their references. */
export function stripHistoricalImages(messages: PiAgentMessage[]): PiAgentMessage[] {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isUserTurn(messages[index])) { lastUserIndex = index; break; }
  }
  if (lastUserIndex <= 0) return messages;
  let changed = false;
  const next = messages.map((message, index): PiAgentMessage => {
    if (index >= lastUserIndex) return message;
    if (message.role !== 'user' && message.role !== 'toolResult' && message.role !== 'custom') return message;
    if (!Array.isArray(message.content)) return message;
    const content = collapseImages(message.content);
    if (!content) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? next : messages;
}

interface LatchedImageMessage {
  sourceHash: string;
  stripped: PiAgentMessage;
}

function messageHash(message: PiAgentMessage): string {
  const serialized = JSON.stringify(message);
  return createHash('sha256').update(serialized ?? '').digest('hex');
}

export interface HistoryImageStrippingOptions {
  /** Idle gate in ms; defaults to the same shared threshold as tool-result clearing. */
  idleMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

/** Compose the stripper onto the session's `transformContext` — the hook PI runs before every provider
 * request, applied to a local copy only (persisted history is untouched). Historical images may first be
 * stripped only on a definitely-cold turn. Each replacement is then latched to its original message hash:
 * old placeholders remain byte-stable, while images first seen after that cold turn stay intact until a
 * later cold turn makes them eligible. */
export function installHistoryImageStripping(
  session: { agent?: { transformContext?: AgentTransformContext } },
  options: HistoryImageStrippingOptions = {},
): void {
  // Injected/custom AgentSession implementations (tests) may expose only the public surface, without
  // the underlying agent — same seam-missing tolerance as installTurnBoundaryAutoCompaction.
  const agent = session.agent;
  if (!agent) return;
  const idleMs = options.idleMs ?? idleThresholdMs(process.env);
  const now = options.now ?? Date.now;
  const latched = new Map<number, LatchedImageMessage>();
  const previous = agent.transformContext;
  agent.transformContext = async (messages, signal) => {
    const base = previous ? await previous(messages, signal) : messages;
    if (cacheColdAtTurnStart(base, idleMs, now())) {
      const stripped = stripHistoricalImages(base);
      for (let index = 0; index < base.length; index += 1) {
        const original = base[index];
        const replacement = stripped[index];
        if (original && replacement && replacement !== original) {
          latched.set(index, { sourceHash: messageHash(original), stripped: replacement });
        }
      }
    }
    if (latched.size === 0) return base;

    for (const index of latched.keys()) {
      if (index >= base.length) latched.delete(index);
    }
    let changed = false;
    const next = base.map((message, index): PiAgentMessage => {
      const entry = latched.get(index);
      if (!entry) return message;
      if (messageHash(message) !== entry.sourceHash) {
        latched.delete(index);
        return message;
      }
      changed = true;
      return entry.stripped;
    });
    return changed ? next : base;
  };
}
