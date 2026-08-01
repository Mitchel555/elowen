import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../../shared/paths.js';

/** Persisted ↑-recall prompt history for the chat TUI, keyed by project (workDir) like the todo
 *  checklist — recalling another project's prompts in this one would just be noise. The file lives
 *  beside cli-prefs.json; the in-session walk (back/forward, draft restore, edit-exits) is the
 *  editor's own history navigation, seeded from here at startup. Corrupt or missing file degrades
 *  to an empty history, never crashes the TUI. */

/** Depth used when no per-user setting reached the CLI (an older daemon, or an offline boot). Matches
 *  `TERMINAL_DEFAULTS.promptHistoryDepth`, which is where the configured value comes from. */
export const MAX_PROMPT_HISTORY = 100;

/** Bounds mirroring the daemon's own clamp (`PROMPT_HISTORY_DEPTH_BOUNDS` in store/terminalSettings.ts).
 *  Re-applied on this side because the value arrives over the wire from a daemon whose version the CLI
 *  does not control, and because both the reader and the writer below cap with it — a depth of 0 would
 *  silently erase the file's contents on the next sent prompt. */
const PROMPT_HISTORY_DEPTH_BOUNDS: [min: number, max: number] = [20, 1000];

/** The effective recall depth: the user's Account → Terminal value held inside the bounds above, or the
 *  built-in default when the daemon served none. */
export function resolvePromptHistoryDepth(depth: number | undefined): number {
  if (typeof depth !== 'number' || !Number.isFinite(depth)) return MAX_PROMPT_HISTORY;
  const [min, max] = PROMPT_HISTORY_DEPTH_BOUNDS;
  return Math.min(max, Math.max(min, Math.round(depth)));
}

/** Session-local draft stash depth (ctrl+s) — LIFO, oldest dropped beyond this. */
export const MAX_STASH_ENTRIES = 10;

function historyFile(env: NodeJS.ProcessEnv): string {
  return join(dataDir(env), 'cli-history.json');
}

function loadAll(env: NodeJS.ProcessEnv): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(historyFile(env), 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch { return {}; }
}

function entriesFor(all: Record<string, unknown>, workDir: string, depth: number): string[] {
  const raw = all[workDir];
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is string => typeof e === 'string' && e.length > 0).slice(-depth);
}

/** This project's sent prompts, oldest → newest (feed them to `Editor.addToHistory` in order). `depth` is
 *  the user's configured recall depth (Account → Terminal); omitted keeps {@link MAX_PROMPT_HISTORY}. */
export function loadPromptHistory(workDir: string, env: NodeJS.ProcessEnv = process.env, depth?: number): string[] {
  return entriesFor(loadAll(env), workDir, resolvePromptHistoryDepth(depth));
}

/** Record one sent prompt: consecutive duplicates collapse, the list caps at `depth` (default
 *  {@link MAX_PROMPT_HISTORY}). Best-effort — a read-only config dir must not break the TUI. */
export function appendPromptHistory(workDir: string, text: string, env: NodeJS.ProcessEnv = process.env, depth?: number): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const capacity = resolvePromptHistoryDepth(depth);
  try {
    const all = loadAll(env);
    const entries = entriesFor(all, workDir, capacity);
    if (entries[entries.length - 1] === trimmed) return; // dedupe consecutive
    entries.push(trimmed);
    all[workDir] = entries.slice(-capacity);
    mkdirSync(dirname(historyFile(env)), { recursive: true });
    writeFileSync(historyFile(env), JSON.stringify(all));
  } catch { /* best-effort persistence */ }
}

/** Session-local prompt stash (opencode-style): ctrl+s with a draft parks it, ctrl+s on an empty
 *  input pops the most recent one back. LIFO, never persisted — a stash is a "let me ask something
 *  else first" pocket, not long-term storage. */
export class PromptStash {
  private entries: string[] = [];

  get size(): number { return this.entries.length; }

  push(text: string): void {
    if (!text.trim()) return;
    this.entries.push(text);
    if (this.entries.length > MAX_STASH_ENTRIES) this.entries.shift();
  }

  pop(): string | undefined {
    return this.entries.pop();
  }
}
