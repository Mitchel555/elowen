/**
 * Parsing and filtering for the log viewer. Pure functions, no React and no Monaco — the viewer is thin
 * glue on top of this, and every rule that decides what the user sees is tested here.
 *
 * Both loggers emit one fixed, column-aligned shape (src/shared/logger.ts, web/lib/serverLogger.ts):
 *
 *   2026-07-25 17:33:34.120  INFO   [brain-stop]  stop …: disposed
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export interface LogLine {
  /** 1-based line number in the ORIGINAL file. Survives filtering, so the gutter keeps showing the real
   *  position in the log rather than renumbering the filtered view. */
  n: number;
  text: string;
  level: LogLevel | null;
  scope: string | null;
}

export interface LogFilterOptions {
  query: string;
  /** Levels to keep. Empty = no level filter at all (show everything). */
  levels: ReadonlySet<LogLevel>;
}

const RECORD = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\s+(DEBUG|INFO|WARN|ERROR)\s+\[([^\]]*)\]/;

/** Split raw log lines into records. A line without the timestamp+level header is a CONTINUATION — a
 *  stack-trace frame or a wrapped payload — so it inherits the level and scope of the record it belongs
 *  to. Without that, filtering to `error` would show the error's first line and drop its whole stack. */
export function parseLogLines(lines: readonly string[]): LogLine[] {
  const out: LogLine[] = [];
  let level: LogLevel | null = null;
  let scope: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    const m = RECORD.exec(text);
    if (m) {
      level = m[1].toLowerCase() as LogLevel;
      scope = m[2] || null;
    }
    out.push({ n: i + 1, text, level, scope });
  }
  return out;
}

/** The records matching both filters. The query matches anywhere in the line (case-insensitive), which
 *  covers the scope too — `[brain-stop]` is part of the text — so no separate scope control is needed. */
export function filterLogLines(lines: readonly LogLine[], { query, levels }: LogFilterOptions): LogLine[] {
  const needle = query.trim().toLowerCase();
  if (!needle && levels.size === 0) return [...lines];
  return lines.filter((line) => {
    // A continuation inherits its record's level, so an unparsed leading line (level null) is only ever
    // filtered out when the user actually picked levels.
    if (levels.size > 0 && (line.level === null || !levels.has(line.level))) return false;
    return !needle || line.text.toLowerCase().includes(needle);
  });
}

/** Human byte size for the file list — matches the compact style used elsewhere in Settings. */
export function formatLogSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
