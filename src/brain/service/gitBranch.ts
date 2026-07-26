import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import type { Policy } from '../../plugins/policy.js';
import { realPathWithin } from '../../plugins/pathGuard.js';

/** How long one directory's resolved branch is reused. `/brain/status` is polled by every attached chat
 *  client, so the branch must never cost a `git` process (nor a tree walk) per request; a few seconds of
 *  staleness on a label is invisible, while forking per poll is not. */
export const GIT_BRANCH_TTL_MS = 5_000;

/** Bound on distinct directories remembered at once. A daemon serves a handful of worktrees; the cap only
 *  exists so a pathological caller cannot grow the map without limit. */
const CACHE_LIMIT = 64;

const cache = new Map<string, { at: number; branch: string | null }>();

/** The roots this caller may read git state from. A scoped session gets its assigned repo paths; an
 *  all-access (admin) session is bounded only by the filesystem root, which is the same freedom `git`
 *  itself has. Read fresh on every call so revoked project access takes effect immediately. */
function rootsOf(policy: Policy): string[] {
  return policy.allowedProjectIds === 'all' ? [parse(process.cwd()).root] : policy.allowedPaths();
}

/** The git directory governing `dir`, walking up until a `.git` entry is found. `.git` is a directory in
 *  an ordinary clone and a `gitdir: <path>` FILE in a linked worktree or submodule.
 *
 *  Every step is contained: the walk stops as soon as the parent leaves `roots`, and the `.git` entry it
 *  lands on is accepted only when its REAL path is still inside them. Without both, anyone who can write
 *  in their own project could plant a `.git` symlink — or a `gitdir:` pointer to an absolute path — and
 *  have this read a foreign repository's HEAD on their behalf. `dir` must already be contained. */
function gitDirOf(dir: string, roots: string[]): string | null {
  let current = dir;
  for (;;) {
    const dotGit = join(current, '.git');
    try {
      if (statSync(dotGit).isDirectory()) return realPathWithin(dotGit, roots);
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim();
      if (pointer) return realPathWithin(isAbsolute(pointer) ? pointer : resolve(current, pointer), roots);
    } catch { /* no `.git` at this level — keep walking up */ }
    const parent = dirname(current);
    if (parent === current) return null;
    const contained = realPathWithin(parent, roots);
    if (!contained) return null;
    current = contained;
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

/** The git branch of the worktree containing `dir`, or null when it is not a repository the caller may
 *  read. Reads `.git/HEAD` directly instead of forking `git`, and memoizes each answer for
 *  {@link GIT_BRANCH_TTL_MS} — both matter because this feeds a hot status poll. `now` is injectable so
 *  the cache is testable without fake timers.
 *
 *  `policy` is the caller's CURRENT repo access, and it is authorization, not a hint: `dir` itself must
 *  resolve inside it, and so must the git directory eventually found. Cached per root set, so one
 *  caller's answer can never be served to another whose access differs. */
export function gitBranch(dir: string, policy: Policy, now = Date.now()): string | null {
  const roots = rootsOf(policy);
  const real = realPathWithin(dir, roots);
  if (!real) return null;
  const key = `${roots.join('\0')}\0${real}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < GIT_BRANCH_TTL_MS) return hit.branch;
  const gitDir = gitDirOf(real, roots);
  const branch = gitDir ? branchOf(gitDir) : null;
  if (cache.size >= CACHE_LIMIT && !cache.has(key)) cache.clear();
  cache.set(key, { at: now, branch });
  return branch;
}
