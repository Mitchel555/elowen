import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** How long one directory's resolved branch is reused. `/brain/status` is polled by every attached chat
 *  client, so the branch must never cost a `git` process (nor a tree walk) per request; a few seconds of
 *  staleness on a label is invisible, while forking per poll is not. */
export const GIT_BRANCH_TTL_MS = 5_000;

/** Bound on distinct directories remembered at once. A daemon serves a handful of worktrees; the cap only
 *  exists so a pathological caller cannot grow the map without limit. */
const CACHE_LIMIT = 64;

const cache = new Map<string, { at: number; branch: string | null }>();

/** The git directory governing `dir`, walking up until a `.git` entry is found. `.git` is a directory in
 *  an ordinary clone and a `gitdir: <path>` FILE in a linked worktree or submodule. */
function gitDirOf(dir: string): string | null {
  let current = dir;
  for (;;) {
    const dotGit = join(current, '.git');
    try {
      if (statSync(dotGit).isDirectory()) return dotGit;
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim();
      if (pointer) return isAbsolute(pointer) ? pointer : resolve(current, pointer);
    } catch { /* no `.git` at this level — keep walking up */ }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The branch recorded in `HEAD`: its ref name, or the short commit when HEAD is detached. */
function branchOf(gitDir: string): string | null {
  let head: string;
  try { head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim(); }
  catch { return null; }
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];
  if (ref) return ref;
  return /^[0-9a-f]{40,64}$/.test(head) ? head.slice(0, 7) : null;
}

/** The git branch of the worktree containing `dir`, or null when it is not a repository. Reads `.git/HEAD`
 *  directly instead of forking `git`, and memoizes each answer for {@link GIT_BRANCH_TTL_MS} — both matter
 *  because this feeds a hot status poll. `now` is injectable so the cache is testable without fake timers. */
export function gitBranch(dir: string, now = Date.now()): string | null {
  const hit = cache.get(dir);
  if (hit && now - hit.at < GIT_BRANCH_TTL_MS) return hit.branch;
  const gitDir = gitDirOf(dir);
  const branch = gitDir ? branchOf(gitDir) : null;
  if (cache.size >= CACHE_LIMIT && !cache.has(dir)) cache.clear();
  cache.set(dir, { at: now, branch });
  return branch;
}
