import type { ConversationLifecycle } from './lifecycle.js';
import type { LiveBrain } from '../session/liveBrain.js';
import type { LiveSessionRegistry } from '../session/liveRegistry.js';
import { clearDeliveredUserEchoes, enqueueMirrored, queuedWithPending } from '../session/queueMirror.js';

interface SessionQueueDeps {
  sessions: LiveSessionRegistry<LiveBrain>;
  lifecycle: ConversationLifecycle;
}

/** The mid-turn message backlog (PI's transient steered + follow-up queue, mirrored with Elowen's
 *  image/display metadata). List, positional remove and value-based recall of pending messages — the CLI
 *  ctrl+x / ↑-recall and the web × button. Split out of BrainService: it reads and re-queues one live
 *  session's queue mirror and touches nothing else. */
export class SessionQueueService {
  private readonly sessions: LiveSessionRegistry<LiveBrain>;
  private readonly lifecycle: ConversationLifecycle;
  constructor(deps: SessionQueueDeps) {
    this.sessions = deps.sessions;
    this.lifecycle = deps.lifecycle;
  }

  /** The caller's pending mid-turn message backlog (PI's transient steered + follow-up snapshot) — of the
   *  active conversation, or of the caller's explicit `session` (a bound CLI). Empty when nothing is
   *  pending or no conversation is live. */
  queueList(userId: number, session?: string): { id: string; text: string }[] {
    const sessionId = session ? this.lifecycle.ownedUserSession(userId, session) : this.sessions.activeIdFor(userId);
    const live = sessionId ? this.sessions.get(sessionId) : undefined;
    return live ? queuedWithPending(live) : [];
  }

  /** Remove ONE pending mid-turn message (the CLI ctrl+x / the web × button). PI's steering queue holds
   *  bare strings with no ids and offers only a clear-all, so we target by POSITION (the same positional
   *  id `queueItems` hands clients): drain the queue, then re-queue everything except the targeted index.
   *  Re-queues from our image-carrying mirror (queuedSteer/queuedFollowUp), NOT PI's text-only accessors —
   *  PI's clearQueue drops image attachments, so re-steering from text alone would strip the surviving
   *  messages' images. An out-of-range id is a no-op. Returns whether a message was actually removed. */
  queueRemove(userId: number, id: string, session?: string): boolean {
    const sessionId = session ? this.lifecycle.ownedUserSession(userId, session) : this.sessions.activeIdFor(userId);
    const live = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!live) return false;
    const steering = live.queuedSteer ?? [];
    const followUp = live.queuedFollowUp ?? [];
    const idx = Number(id);
    if (!Number.isInteger(idx) || idx < 0 || idx >= steering.length + followUp.length) return false;
    // Snapshot WITH images before clearQueue empties both PI's queue and (via queue_update) our mirror.
    const combined = [
      ...steering.map((m) => ({ kind: 'steer' as const, ...m })),
      ...followUp.map((m) => ({ kind: 'followUp' as const, ...m })),
    ];
    live.session.clearQueue();
    clearDeliveredUserEchoes(live);
    // Re-queue in the same order, dropping the positional target, preserving each survivor's images.
    // `steer`/`followUp` only enqueue while the turn is streaming (a queue only exists mid-turn), so
    // nothing runs a fresh turn; enqueueMirrored keeps the mirror in step.
    combined.forEach((m, i) => {
      if (i !== idx) void enqueueMirrored(live, m.kind, m.text, m.images, m.echo);
    });
    return true;
  }

  /** Pop the LAST pending mid-turn message and hand back its text — the CLI ↑-recall (restores it to the
   *  composer) and ctrl+x remove-last (drops it). Unlike queueRemove's positional targeting, this pops by
   *  VALUE from the daemon's authoritative queue mirror. A client's cached positional id goes stale the
   *  moment PI delivers a queued message between steps, so a positional remove issued mid-stream can
   *  mis-target or no-op and leave the message both queued and re-sendable — the duplicate the ↑-recall
   *  produced. Popping the real current tail server-side removes that race. Returns { text: null } when
   *  nothing is pending (e.g. the message was delivered before the key landed). */
  queueRecall(userId: number, session?: string): { text: string | null } {
    const sessionId = session ? this.lifecycle.ownedUserSession(userId, session) : this.sessions.activeIdFor(userId);
    const live = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!live) return { text: null };
    const steering = live.queuedSteer ?? [];
    const followUp = live.queuedFollowUp ?? [];
    if (steering.length + followUp.length === 0) return { text: null };
    // Snapshot WITH images before clearQueue empties both PI's queue and (via queue_update) our mirror —
    // then re-queue every survivor except the tail, preserving order and each message's attachments.
    const combined = [
      ...steering.map((m) => ({ kind: 'steer' as const, ...m })),
      ...followUp.map((m) => ({ kind: 'followUp' as const, ...m })),
    ];
    const target = combined[combined.length - 1]!;
    const text = target.echo?.displayText ?? target.text;
    live.session.clearQueue();
    clearDeliveredUserEchoes(live);
    combined.slice(0, -1).forEach((m) => void enqueueMirrored(live, m.kind, m.text, m.images, m.echo));
    return { text };
  }
}
