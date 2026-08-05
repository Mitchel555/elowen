/** Fold the deferred tools the model had already fetched into the compaction divider, so they survive the
 *  rows that recorded them being deleted.
 *
 *  Why this is not merely a cache concern: `seedActivatedFromHistory` rebuilds `handle.activated` by
 *  scanning history for past ToolSearch results. A compaction deletes every row before the kept tail, so
 *  once the ToolSearch result that activated a tool falls before the cut, a later respawn re-seeds an
 *  EMPTY set — the tool drops out of the advertised slice while the model can still see its own past
 *  "Activated …" result and its later calls in the summary. It then calls a tool that is no longer there
 *  and gets an unknown-tool error. Rolling the names onto the divider keeps the two in agreement.
 *
 *  Must run DURING the compaction, for the same reason as the working-set rollup: `compactSessionMessages`
 *  deletes the rows first, and afterwards there is nothing left to reconstruct the set from. */

/** Read the activated names off the rows a compaction is about to delete, de-duplicated and in first-seen
 *  order. Returns null when nothing dropped carried any, which keeps the divider row clean.
 *
 *  Deliberately unbounded, unlike the working set: that block is orientation and may be truncated, whereas
 *  this one is an exact set the visibility pass is compared against. Silently dropping a name here would
 *  reintroduce the very unknown-tool error this exists to prevent. The set is bounded in practice by the
 *  session's deferred registry, and `seedActivatedFromHistory` discards names that are no longer deferred. */
export function rollupActivatedTools(dropped: readonly { content: string }[]): string[] | null {
  const names = new Set<string>();
  for (const row of dropped) {
    let parsed: { role?: unknown; toolName?: unknown; isError?: unknown; details?: unknown; activatedTools?: unknown } | undefined;
    try { parsed = JSON.parse(row.content) as typeof parsed; }
    catch { continue; } // a row we cannot parse costs one entry, never the whole rollup
    // An EARLIER compaction divider being dropped by this one carries its own rolled-up names. Fold them
    // in — exactly as the usage and working-set rollups chain — or a second compaction silently erases
    // what the first one preserved.
    if (Array.isArray(parsed?.activatedTools)) {
      for (const name of parsed.activatedTools) if (typeof name === 'string' && name) names.add(name);
      continue;
    }
    if (parsed?.role !== 'toolResult' || parsed.toolName !== 'ToolSearch' || parsed.isError === true) continue;
    const matched = (parsed.details as { matched?: unknown } | undefined)?.matched;
    if (!Array.isArray(matched)) continue;
    for (const name of matched) if (typeof name === 'string' && name) names.add(name);
  }
  return names.size === 0 ? null : [...names];
}
