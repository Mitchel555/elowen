import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ELOWEN_VERSION } from '../api/version.js';
import type { BrainUsage } from '../brain/events.js';
import type { DelegatedProgressEvent, DelegatedTurnRequest } from '../brain/delegatedTurn.js';

/** The forked runner's entry module. Resolved relative to THIS file so the daemon and the child always
 *  name the same build: in a packaged install both are `dist/subagent/*.js`. A source checkout run through
 *  `--experimental-strip-types` has no `.js` sibling — the runner is then simply unavailable and the
 *  dispatcher stays in-process (see SubagentRunnerHost). */
export const RUNNER_ENTRY = ((): string => {
  const js = fileURLToPath(new URL('./runner.js', import.meta.url));
  try {
    statSync(js);
    return js;
  } catch {
    return fileURLToPath(new URL('./runner.ts', import.meta.url));
  }
})();

/** What "the same build" means across the process boundary.
 *
 *  A runner is forked from whatever is on disk NOW, while the daemon is running whatever it loaded at
 *  boot. An in-place `npm run build` (or an `elowen update`) under a live daemon is exactly the skew that
 *  produces a child speaking a protocol — or composing a prompt — its parent does not have. The version
 *  alone cannot see that, since a rebuild of the same version is the common case, so the entry module's
 *  size+mtime rides along. The daemon captures this ONCE at startup; the runner recomputes it at boot and
 *  refuses a mismatch rather than serving turns from a different build. */
export function subagentBuildId(): string {
  try {
    const s = statSync(RUNNER_ENTRY);
    return `${ELOWEN_VERSION}:${s.size}:${Math.floor(s.mtimeMs)}`;
  } catch {
    return `${ELOWEN_VERSION}:missing`;
  }
}

/** Boot the runner: the database it attaches to (WITHOUT migrating — the daemon owns the schema) and the
 *  home project, so its brain core is constructed from the same inputs the daemon's was. */
export interface RunnerBootMessage {
  type: 'boot';
  buildId: string;
  dbPath: string;
  project: { id: number; slug: string; path: string };
}

export type DaemonToRunner =
  | RunnerBootMessage
  /** Execute ONE delegated turn. `turnId` correlates the reply; `request` is re-validated on arrival. */
  | { type: 'turn'; turnId: string; request: DelegatedTurnRequest; text: string }
  /** Abort verb (the abort tree stays authoritative in the daemon — see LiveSessionRegistry). */
  | { type: 'abort'; channelId: string }
  /** Drop the live record for a channel so the DAEMON can run that child's next turn itself (a drill-in
   *  or a DelegateContinue rehydrates from SQLite). Refused while that channel is busy. */
  | { type: 'release'; releaseId: string; channelId: string };

export type RunnerToDaemon =
  | { type: 'ready'; buildId: string }
  /** The runner cannot serve turns at all (build skew, boot failure). It exits right after sending this. */
  | { type: 'fatal'; reason: string }
  | { type: 'progress'; turnId: string; event: DelegatedProgressEvent }
  /** A NESTED delegated edge inside the runner, mirrored into the daemon's registry so its abort tree,
   *  status and shutdown gate see the whole tree. The edge of the dispatched turn itself is NOT reported:
   *  the daemon registers that one synchronously before it forwards anything. */
  | { type: 'child'; parentSessionId: string; childSessionId: string; running: boolean }
  | { type: 'result'; turnId: string; reply: string }
  | { type: 'error'; turnId: string; message: string }
  | { type: 'released'; releaseId: string; busy: boolean };

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Parse a message from the daemon. A child never trusts its channel blindly — a malformed frame is
 *  dropped, not coerced. */
export function parseDaemonMessage(raw: unknown): DaemonToRunner | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (v.type === 'boot') {
    const buildId = str(v.buildId);
    const dbPath = str(v.dbPath);
    const p = v.project as Record<string, unknown> | undefined;
    const slug = str(p?.slug);
    const path = str(p?.path);
    if (!buildId || !dbPath || !p || !slug || !path || !Number.isSafeInteger(p.id)) return undefined;
    return { type: 'boot', buildId, dbPath, project: { id: p.id as number, slug, path } };
  }
  if (v.type === 'turn') {
    const turnId = str(v.turnId);
    const text = str(v.text);
    if (!turnId || text === undefined || !v.request) return undefined;
    // The request itself is validated by parseDelegatedTurnRequest at the point of use, where a refusal
    // can be reported back against this turnId instead of vanishing as a dropped frame.
    return { type: 'turn', turnId, request: v.request as DelegatedTurnRequest, text };
  }
  if (v.type === 'abort') {
    const channelId = str(v.channelId);
    return channelId ? { type: 'abort', channelId } : undefined;
  }
  if (v.type === 'release') {
    const releaseId = str(v.releaseId);
    const channelId = str(v.channelId);
    return releaseId && channelId ? { type: 'release', releaseId, channelId } : undefined;
  }
  return undefined;
}

/** Parse a message from the runner. Same rule in reverse: the daemon must not crash on a frame from a
 *  child that is misbehaving or mid-crash. */
export function parseRunnerMessage(raw: unknown): RunnerToDaemon | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  switch (v.type) {
    case 'ready': {
      const buildId = str(v.buildId);
      return buildId ? { type: 'ready', buildId } : undefined;
    }
    case 'fatal': return { type: 'fatal', reason: str(v.reason) ?? 'unknown' };
    case 'progress': {
      const turnId = str(v.turnId);
      const event = parseProgressEvent(v.event);
      return turnId && event ? { type: 'progress', turnId, event } : undefined;
    }
    case 'child': {
      const parentSessionId = str(v.parentSessionId);
      const childSessionId = str(v.childSessionId);
      if (!parentSessionId || !childSessionId || typeof v.running !== 'boolean') return undefined;
      return { type: 'child', parentSessionId, childSessionId, running: v.running };
    }
    case 'result': {
      const turnId = str(v.turnId);
      const reply = str(v.reply);
      return turnId && reply !== undefined ? { type: 'result', turnId, reply } : undefined;
    }
    case 'error': {
      const turnId = str(v.turnId);
      return turnId ? { type: 'error', turnId, message: str(v.message) ?? 'sub-agent runner failed' } : undefined;
    }
    case 'released': {
      const releaseId = str(v.releaseId);
      return releaseId ? { type: 'released', releaseId, busy: v.busy === true } : undefined;
    }
    default: return undefined;
  }
}

function parseProgressEvent(raw: unknown): DelegatedProgressEvent | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (v.type === 'session') {
    const sessionId = str(v.sessionId);
    return sessionId ? { type: 'session', sessionId } : undefined;
  }
  if (v.type === 'tool') {
    const name = str(v.name);
    if (!name) return undefined;
    return { type: 'tool', name, ...(typeof v.detail === 'string' ? { detail: v.detail } : {}) };
  }
  if (v.type === 'step') {
    if (typeof v.step !== 'number' || typeof v.maxSteps !== 'number') return undefined;
    const usage = v.usage;
    const carried = usage && typeof usage === 'object' && !Array.isArray(usage)
      ? { usage: usage as BrainUsage }
      : {};
    return { type: 'step', step: v.step, maxSteps: v.maxSteps, ...carried };
  }
  return undefined;
}
