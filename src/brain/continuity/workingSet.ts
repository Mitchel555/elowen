/** One file the conversation touched before a compaction dropped the evidence. `wrote` separates
 *  "you changed this" from "you looked at this" — the first is a much stronger signal about where the
 *  work actually was, and it is what the model needs to re-orient. */
export interface WorkingSetEntry { path: string; wrote: boolean }

/** How many files a rollup reports. The block is orientation, not a manifest: past a dozen entries it
 *  stops telling the model where the work was and starts costing the context the compaction reclaimed. */
export const WORKING_SET_MAX = 12;

/** Which tool results name a file, and whether that tool CHANGED it. Mirrors the files plugin's own
 *  VOUCHING_TOOLS: the same three results are the ones carrying a trustworthy `details.path`. */
const FILE_TOOLS: Record<string, boolean> = { Read: false, Write: true, Edit: true };

/** Fold the files named by the rows a compaction is about to delete into a de-duplicated, newest-first
 *  list. Returns null when nothing dropped named a file, which keeps the divider row clean.
 *
 *  Must run DURING the compaction: `compactSessionMessages` deletes every row before the kept tail, so
 *  once it returns there is nothing left to reconstruct a working set from.
 *
 *  Reads `details.path` rather than the assistant's `toolCall.arguments.path`: details carries the
 *  absolute, realpath-resolved path the tool actually used, survives tool-result clearing (which
 *  replaces only `content`), and — via `ok` — distinguishes a real read from one that failed. A failed
 *  read must not enter the set: it would point the model at a file it never actually saw. */
export function rollupWorkingSet(dropped: readonly { content: string }[]): WorkingSetEntry[] | null {
  const byPath = new Map<string, boolean>();
  const touch = (path: string, wrote: boolean): void => {
    // Re-insert so insertion order tracks the LAST touch, and OR the flag so a file that was edited at
    // any point keeps reading as edited even if a plain read came afterwards.
    const seen = byPath.get(path) ?? false;
    byPath.delete(path);
    byPath.set(path, seen || wrote);
  };
  for (const row of dropped) {
    let parsed: { details?: Record<string, unknown>; workingSet?: unknown } | undefined;
    try { parsed = JSON.parse(row.content) as typeof parsed; }
    catch { continue; } // a row we cannot parse costs one entry, never the whole rollup
    // An EARLIER compaction divider being dropped by this one carries its own rolled-up files. Fold
    // them in — exactly as rollupDroppedUsage chains prior usage buckets — or a second compaction
    // silently erases every file the first one recorded. Oldest-first, since the stored list is
    // newest-first and `touch` treats each call as more recent than the last.
    if (Array.isArray(parsed?.workingSet)) {
      for (const entry of [...parsed.workingSet].reverse()) {
        const e = entry as Partial<WorkingSetEntry>;
        if (typeof e?.path === 'string' && e.path) touch(e.path, e.wrote === true);
      }
      continue;
    }
    const details = parsed?.details;
    if (!details || details.ok !== true) continue;
    const { path, tool } = details;
    if (typeof path !== 'string' || !path || typeof tool !== 'string') continue;
    const wrote = FILE_TOOLS[tool];
    if (wrote === undefined) continue; // some other tool whose result happens to carry a path
    touch(path, wrote);
  }
  if (byPath.size === 0) return null;
  return [...byPath].reverse().slice(0, WORKING_SET_MAX).map(([path, wrote]) => ({ path, wrote }));
}
