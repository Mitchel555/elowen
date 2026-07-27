/** The monochrome marker a tool row leads with, inferred from the tool's NAME.
 *
 *  Shared by the CLI and the web on purpose. The daemon also resolves a colourful per-tool emoji for
 *  rich clients, but that one only exists on the LIVE `tool` frame — stored history carries no icon — so
 *  a client rendering it showed one thing while a turn streamed and another after a reload. Deriving the
 *  marker from the name instead is stable across both, and keeps the two surfaces looking alike.
 *
 *  The glyph is a direction hint, not an identity: the row prints the tool's real name beside it. Reading
 *  pulls in (→), writing pushes out (←), searching fans out (✱). Substring labels used to MISNAME tools —
 *  `CreateSkill` and `TodoWrite` both read as a file "Write" — which is why only the marker is inferred
 *  and never the label. */
export function toolGlyph(name: string): string {
  if (/(search|grep|glob)/i.test(name)) return '✱';
  if (/(edit|patch|update|modify|replace)/i.test(name)) return '←';
  if (/(write|create)/i.test(name)) return '←';
  if (/(read|open|cat)/i.test(name)) return '→';
  if (/list_?dir/i.test(name)) return '→';
  if (/diff/i.test(name)) return '←';
  // LSP (diagnostics / definitions / references / symbols) takes the universal marker. Deliberately NOT
  // the search ✱: an LSP check is not a search. Kept as an explicit branch — the default is also ⚙ — so
  // the intent survives someone reordering these.
  if (/(lsp|diagnostic)/i.test(name)) return '⚙';
  if (/(fetch|web|http|url)/i.test(name)) return '%';
  return '⚙';
}
