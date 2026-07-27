/** Mirror of `src/shared/toolGlyph.ts`, which is the canonical copy.
 *
 *  It is duplicated rather than imported because Turbopack's root is pinned to `web/` (next.config.ts), so
 *  nothing outside this directory resolves at runtime — the same boundary that makes `web/lib/types.ts`
 *  hand-mirror the daemon's wire types. `tests/lib/toolGlyph.test.ts` imports BOTH copies and fails if they
 *  ever disagree, so the duplication cannot silently drift.
 *
 *  Keep the bodies identical; edit the canonical file first. */
export function toolGlyph(name: string): string {
  if (/(search|grep|glob)/i.test(name)) return '✱';
  if (/(edit|patch|update|modify|replace)/i.test(name)) return '←';
  if (/(write|create)/i.test(name)) return '←';
  if (/(read|open|cat)/i.test(name)) return '→';
  if (/list_?dir/i.test(name)) return '→';
  if (/diff/i.test(name)) return '←';
  if (/(lsp|diagnostic)/i.test(name)) return '⚙';
  if (/(fetch|web|http|url)/i.test(name)) return '%';
  return '⚙';
}
