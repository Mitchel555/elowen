import { extractText } from '../messageView.js';
import { readPlan } from './planStore.js';
import { planFilePath } from '../../shared/paths.js';
import type { WorkingSetEntry } from './workingSet.js';

/** The slice of BrainStore this needs: the conversation's rows, so the newest compaction divider can be
 *  found and its rolled-up working set read back. Structural so tests need no database. */
export interface PostCompactionStore {
  getMessages(sessionId: string): readonly { id: string; role: string; content: string }[];
}

/** The working set the most recent compaction folded onto its divider, or null when there is none.
 *  Reads the LAST divider: a conversation compacted repeatedly should orient the model around the most
 *  recent loss, not the first one. */
function latestWorkingSet(store: PostCompactionStore, sessionId: string): WorkingSetEntry[] | null {
  const divider = [...store.getMessages(sessionId)].reverse().find((m) => m.role === 'compaction');
  if (!divider) return null;
  try {
    const set = (JSON.parse(divider.content) as { workingSet?: unknown }).workingSet;
    if (!Array.isArray(set)) return null;
    const entries = set.filter((e): e is WorkingSetEntry =>
      !!e && typeof e === 'object' && typeof (e as WorkingSetEntry).path === 'string');
    return entries.length ? entries : null;
  } catch {
    return null; // an unparseable divider costs the orientation, never the turn
  }
}

/** Assemble the one-shot reminder that re-orients the model after a compaction: the plan it agreed to
 *  and the files it was working in. Returns '' when there is nothing to say, so the caller can append
 *  it unconditionally.
 *
 *  The plan is omitted when it is STILL VISIBLE in the live context — a compaction that kept the turn
 *  holding it has cost the model nothing, and repeating the document would waste the context the
 *  compaction just reclaimed while telling the model something it can already read.
 *
 *  Paths, never file contents: see workingSet.ts. The instruction line exists because the summary
 *  paraphrases what happened, and a model that trusts a paraphrase about file contents will edit from
 *  a stale mental copy. */
/** Emit the orientation block once per compaction, deciding from DURABLE state rather than from having
 *  caught an event.
 *
 *  An earlier version armed a flag when the `compaction_end` event arrived. That flag was set on the
 *  live session looked up at event time — and during a compaction that lookup can come back empty, so
 *  the flag was written to nothing while clients still saw the compaction. The feature then did exactly
 *  nothing, silently, which is the worst possible failure for a safety net.
 *
 *  Comparing the newest divider's id against the last one this session was oriented for cannot fail
 *  that way: the divider is a row in the store, so the decision survives whatever happens in memory. A
 *  daemon restart re-orients once, which is right — the process lost its context too. */
export function drainPostCompactionContext(
  store: PostCompactionStore,
  live: { sessionId: string; orientedForCompaction?: string; session: { messages: readonly unknown[] } },
): { block: string; compacted: boolean; commit: () => void } {
  const divider = [...store.getMessages(live.sessionId)].reverse().find((m) => m.role === 'compaction');
  if (!divider || divider.id === live.orientedForCompaction) return { block: '', compacted: false, commit: () => {} };
  // Marked as delivered only when the caller COMMITS, after the prompt it went into actually reached the
  // provider. Marking it here — at composition time — looked equivalent and was not: a provider error or
  // an abort in between, and the orientation is gone for good, having been consumed by a turn that never
  // happened. That window is common precisely when it hurts, because a compaction follows a heavy turn.
  // Failing this way costs at most one duplicate reminder, which is the right side to err on.
  const commit = (): void => { live.orientedForCompaction = divider.id; };
  // `compacted` is reported SEPARATELY from the block, and the difference is load-bearing. The block is
  // empty when the compaction had nothing worth naming — no plan, no files — but the compaction still
  // happened, and it still deleted every standing instruction along with everything else. A caller that
  // inferred "a compaction happened" from "the block is non-empty" would, after a quiet compaction, go on
  // telling the model its full directive is earlier in the conversation when nothing of the sort remains.
  return { block: buildPostCompactionContext(store, live.sessionId, live.session.messages), compacted: true, commit };
}

export function buildPostCompactionContext(
  store: PostCompactionStore,
  sessionId: string,
  liveMessages: readonly unknown[],
): string {
  const stored = readPlan(sessionId);
  // Look for the plan's own TEXT. The way it gets into a live message is by the model READING its own
  // plan file — which the plan-mode directive now tells it to do whenever the file already exists — so
  // the body arrives as the text of a tool result. It does NOT arrive as a Write call's arguments:
  // `extractText` only collects parts carrying a `text` key, and a tool call is not one, so authoring the
  // plan never makes it look already-visible. A prefix identifies it and survives truncation.
  const needle = stored?.slice(0, 200);
  const alreadyVisible = needle !== undefined && needle !== ''
    && liveMessages.some((m) => extractText(m).includes(needle));
  const plan = alreadyVisible ? undefined : stored;
  const files = latestWorkingSet(store, sessionId);
  if (plan === undefined && !files) return '';

  const sections: string[] = [];
  // Named with its file, because after approval this block is the ONLY thing that mentions the plan at
  // all — the plan-mode directive is gone in build mode, so a model implementing the plan would otherwise
  // have no way to re-read it or record progress against it, having been handed the text and not the path.
  if (plan !== undefined) {
    sections.push(`<active-plan file="${planFilePath(process.env, sessionId)}">\n${plan}\n</active-plan>`);
  }
  if (files) {
    const rows = files.map((f) => `- ${f.path} (${f.wrote ? 'edited' : 'read'})`).join('\n');
    sections.push(`<working-set>\n${rows}\n</working-set>`);
  }
  return '<system-reminder>\n<post-compaction-context>\n'
    + 'The conversation was compacted; earlier messages are gone.\n'
    + `${sections.join('\n')}\n`
    + '</post-compaction-context>\n'
    + '<instruction>Re-read what you still need before acting; do not assume file contents from the '
    + 'summary.</instruction>\n'
    + '</system-reminder>';
}
