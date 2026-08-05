/** Split a markdown file's leading `---` YAML frontmatter block from its body — the single parser for
 *  the three callers (skill routes, the skill-install service, the agent registry). Each used to carry
 *  its own regex and the copies drifted apart: one swallowed the newline after the closing marker, one
 *  broke entirely on CRLF files, one was the only one that tolerated a BOM. The block always ends at the
 *  FIRST `---` line after the opening marker, so a `---` horizontal rule later in the body is body,
 *  never a second delimiter. */
export interface FrontmatterSplit {
  /** Raw YAML between the delimiters — '' when the file has no frontmatter block. */
  frontmatter: string;
  /** Everything after the closing `---` line, or the whole source when there is no frontmatter. */
  body: string;
}

const FRONTMATTER_RE = /^\uFEFF?---[ \t]*(?:\r?\n)([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

export function splitFrontmatter(source: string): FrontmatterSplit {
  const m = FRONTMATTER_RE.exec(source);
  if (!m) return { frontmatter: '', body: source };
  return { frontmatter: m[1] ?? '', body: m[2] ?? '' };
}
