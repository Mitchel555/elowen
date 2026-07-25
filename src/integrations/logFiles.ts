import { readdirSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { LOG_DIR } from '../shared/logger.js';

/**
 * The daily log files the daemon and the web process write (see src/shared/logger.ts and
 * web/lib/serverLogger.ts). This module owns every rule for touching them — which names exist, how much
 * may be read, and what deletion means — so the route layer stays thin and the rules are unit-testable in
 * one place (the same split `integrations/projectFiles.ts` uses for project files).
 *
 * The security rule: callers name a FILE, never a path. A name must match the exact daily-log pattern and
 * the resolved path must sit directly in the log directory, so no traversal, absolute path or symlink can
 * reach a file the log viewer was never meant to expose.
 */

export type LogSource = 'daemon' | 'web';

export interface LogFileInfo {
  name: string;
  source: LogSource;
  bytes: number;
  /** Epoch millis of the last write — the list is sorted by it, newest first. */
  modifiedAt: number;
}

export interface LogFileContent {
  name: string;
  /** The tail: at most `limit` lines, in file order. */
  lines: string[];
  totalLines: number;
  /** True when older lines were dropped, so the UI can offer to load the whole file. */
  truncated: boolean;
  bytes: number;
}

export type ReadLogResult =
  | { ok: true; content: LogFileContent }
  | { ok: false; reason: 'invalid' | 'missing' | 'too-large' };

export type DeleteLogResult = { ok: true } | { ok: false; reason: 'invalid' | 'missing' };

/** `daemon-2026-07-25.log` / `web-2026-07-25.log` — the only shapes either logger ever produces. */
const LOG_NAME = /^(daemon|web)-\d{4}-\d{2}-\d{2}\.log$/;

/** A whole file is read to serve a tail, so cap what may be pulled into memory at once. Well above any
 *  real daily log (the largest observed is single-digit MB) and far below anything that could OOM. */
export const MAX_LOG_READ_BYTES = 64 * 1024 * 1024;
export const DEFAULT_LOG_TAIL_LINES = 2_000;
export const MAX_LOG_TAIL_LINES = 50_000;

export function isLogFileName(name: string): boolean {
  return LOG_NAME.test(name);
}

/** Resolve a caller-supplied NAME to an absolute path inside `dir`, or null if it is not a legal log
 *  name or would land anywhere other than directly in that directory. */
function safeLogPath(name: string, dir: string): string | null {
  if (!isLogFileName(name)) return null;
  const full = resolve(dir, name);
  // The name pattern already excludes separators and dots, so this can only fail if `dir` itself is odd —
  // assert it anyway: it is the invariant the whole module rests on, and it costs one comparison.
  if (dirname(full) !== resolve(dir)) return null;
  return full;
}

/** A regular file (not a symlink, not a directory) — `lstat` deliberately does NOT follow links, so a
 *  symlink planted in the log directory reports as a link here and is skipped rather than followed. */
function statRegular(path: string): { bytes: number; modifiedAt: number } | null {
  try {
    const st = lstatSync(path);
    return st.isFile() ? { bytes: st.size, modifiedAt: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

/** Every readable daily log in `dir`, newest first. A missing directory is not an error — nothing has
 *  been logged there yet, which is an empty list, not a failure. */
export function listLogFiles(dir: string = LOG_DIR): LogFileInfo[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: LogFileInfo[] = [];
  for (const name of names) {
    if (!isLogFileName(name)) continue;
    const path = safeLogPath(name, dir);
    if (!path) continue;
    const st = statRegular(path);
    if (!st) continue;
    files.push({ name, source: name.startsWith('daemon-') ? 'daemon' : 'web', bytes: st.bytes, modifiedAt: st.modifiedAt });
  }
  return files.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/** The last `limit` lines of one log file. `limit` is clamped to [1, MAX_LOG_TAIL_LINES]. */
export function readLogFile(name: string, limit: number = DEFAULT_LOG_TAIL_LINES, dir: string = LOG_DIR): ReadLogResult {
  const path = safeLogPath(name, dir);
  if (!path) return { ok: false, reason: 'invalid' };
  const st = statRegular(path);
  if (!st) return { ok: false, reason: 'missing' };
  if (st.bytes > MAX_LOG_READ_BYTES) return { ok: false, reason: 'too-large' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, reason: 'missing' };
  }
  // A trailing newline ends the last record; it is not an extra blank line.
  const all = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const take = Math.min(Math.max(1, Math.floor(limit)), MAX_LOG_TAIL_LINES);
  const lines = all.length > take ? all.slice(all.length - take) : all;
  return { ok: true, content: { name, lines, totalLines: all.length, truncated: lines.length < all.length, bytes: st.bytes } };
}

/** Delete one log file. Deleting the CURRENT day's file is safe and supported: both loggers append with
 *  `appendFileSync`, which recreates the file on the very next line they write. */
export function deleteLogFile(name: string, dir: string = LOG_DIR): DeleteLogResult {
  const path = safeLogPath(name, dir);
  if (!path) return { ok: false, reason: 'invalid' };
  if (!statRegular(path)) return { ok: false, reason: 'missing' };
  try {
    unlinkSync(path);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  return { ok: true };
}

/** Delete every daily log, returning how many went. Anything else in the directory is left untouched —
 *  only files matching the log-name pattern are ever removed. */
export function deleteAllLogFiles(dir: string = LOG_DIR): number {
  let deleted = 0;
  for (const file of listLogFiles(dir)) {
    if (deleteLogFile(file.name, dir).ok) deleted += 1;
  }
  return deleted;
}
