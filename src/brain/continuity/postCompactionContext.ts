import { extractText } from '../messageView.js';
import { proposedPlanOpenMatcher } from './planCapture.js';
import { readPlan } from './planStore.js';
import type { WorkingSetEntry } from './workingSet.js';

/** The slice of BrainStore this needs: the conversation's rows, so the newest compaction divider can be
 *  found and its rolled-up working set read back. Structural so tests need no database. */
export interface PostCompactionStore {
  getMessages(sessionId: string): readonly { role: string; content: string }[];
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
export function drainPostCompactionContext(
  store: PostCompactionStore,
  live: { sessionId: string; pendingPostCompaction?: boolean; session: { messages: readonly unknown[] } },
): string {
  if (!live.pendingPostCompaction) return '';
  live.pendingPostCompaction = false; // one-shot: the model is oriented once, not every turn after
  return buildPostCompactionContext(store, live.sessionId, live.session.messages);
}

export function buildPostCompactionContext(
  store: PostCompactionStore,
  sessionId: string,
  liveMessages: readonly unknown[],
): string {
  const stored = readPlan(sessionId);
  const alreadyVisible = stored !== undefined
    && liveMessages.some((m) => proposedPlanOpenMatcher().test(extractText(m)));
  const plan = alreadyVisible ? undefined : stored;
  const files = latestWorkingSet(store, sessionId);
  if (plan === undefined && !files) return '';

  const sections: string[] = [];
  if (plan !== undefined) sections.push(`<active-plan>\n${plan}\n</active-plan>`);
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
