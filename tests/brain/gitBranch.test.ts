import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitBranch, GIT_BRANCH_TTL_MS } from '../../src/brain/service/gitBranch.js';
import type { Policy } from '../../src/plugins/policy.js';

/** An admin session: unrestricted, exactly as before this call took a policy. */
const ALL: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
/** A project-scoped session that may only read git state inside `roots`. */
const scoped = (...roots: string[]): Policy => ({ allowedProjectIds: new Set([1]), allowedPaths: () => roots });

const dirs: string[] = [];
function repo(head: string, opts: { gitFile?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'git-branch-'));
  dirs.push(root);
  const gitDir = opts.gitFile ? join(root, '.real-git') : join(root, '.git');
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, 'HEAD'), head);
  if (opts.gitFile) writeFileSync(join(root, '.git'), 'gitdir: .real-git\n');
  return root;
}
/** A directory the caller is allowed to write in but which holds no repository of its own. */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'git-branch-work-'));
  dirs.push(root);
  return root;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('gitBranch', () => {
  it('reads the symbolic branch name of the worktree containing the directory', () => {
    const root = repo('ref: refs/heads/feature/telemetry\n');
    const nested = join(root, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    expect(gitBranch(root, ALL, 1_000)).toBe('feature/telemetry');
    expect(gitBranch(nested, ALL, 1_000)).toBe('feature/telemetry');
  });

  it('reports the short commit for a detached HEAD', () => {
    const root = repo('9f1c2ad3b4e5f60718293a4b5c6d7e8f90a1b2c3\n');
    expect(gitBranch(root, ALL, 1_000)).toBe('9f1c2ad');
  });

  it('follows a `.git` FILE (worktree / submodule) to its real git dir', () => {
    const root = repo('ref: refs/heads/linked\n', { gitFile: true });
    expect(gitBranch(root, ALL, 1_000)).toBe('linked');
    // …and a scoped caller still gets it, because the pointer stays inside their own root.
    expect(gitBranch(root, scoped(root), 1_000)).toBe('linked');
  });

  it('is null outside a repository and for an unreadable HEAD', () => {
    const plain = workspace();
    expect(gitBranch(plain, ALL, 1_000)).toBeNull();
    const broken = workspace();
    mkdirSync(join(broken, '.git'));
    expect(gitBranch(broken, ALL, 1_000)).toBeNull();
  });

  // `/brain/status` is a hot poll: a second lookup inside the TTL must answer from the cache and touch no
  // filesystem at all. Rewriting HEAD underneath is the observable proof — a re-read would see the change.
  it('answers a repeat lookup from cache within the TTL and refreshes after it', () => {
    const root = repo('ref: refs/heads/before\n');
    expect(gitBranch(root, ALL, 10_000)).toBe('before');
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/after\n');
    expect(gitBranch(root, ALL, 10_000 + GIT_BRANCH_TTL_MS - 1)).toBe('before');
    expect(gitBranch(root, ALL, 10_000 + GIT_BRANCH_TTL_MS)).toBe('after');
  });

  it('caches the "not a repository" answer too, so a non-repo cwd never re-walks the tree', () => {
    const plain = workspace();
    expect(gitBranch(plain, ALL, 50_000)).toBeNull();
    mkdirSync(join(plain, '.git'));
    writeFileSync(join(plain, '.git', 'HEAD'), 'ref: refs/heads/late\n');
    expect(gitBranch(plain, ALL, 50_000 + GIT_BRANCH_TTL_MS - 1)).toBeNull();
    expect(gitBranch(plain, ALL, 50_000 + GIT_BRANCH_TTL_MS)).toBe('late');
  });

  // Containment. Everything below is reachable by a user who merely has write access to their OWN
  // project directory, so each case pairs the refusal with an all-access control proving the branch
  // really would have been read — the scoping is what stops it, not a broken fixture.
  it('refuses a `gitdir:` pointer that leaves the caller\'s roots', () => {
    const foreign = repo('ref: refs/heads/foreign-secret\n');
    const mine = workspace();
    writeFileSync(join(mine, '.git'), `gitdir: ${join(foreign, '.git')}\n`);
    expect(gitBranch(mine, ALL, 2_000)).toBe('foreign-secret');
    expect(gitBranch(mine, scoped(mine), 2_000)).toBeNull();
  });

  it('refuses a `.git` symlink resolving outside the caller\'s roots', () => {
    const foreign = repo('ref: refs/heads/foreign-link\n');
    const mine = workspace();
    symlinkSync(join(foreign, '.git'), join(mine, '.git'), 'dir');
    expect(gitBranch(mine, ALL, 3_000)).toBe('foreign-link');
    expect(gitBranch(mine, scoped(mine), 3_000)).toBeNull();
  });

  it('stops the upward walk at the authorized root instead of reaching the enclosing repository', () => {
    const outer = repo('ref: refs/heads/enclosing\n');
    const inner = join(outer, 'projects', 'mine');
    mkdirSync(inner, { recursive: true });
    expect(gitBranch(inner, ALL, 4_000)).toBe('enclosing');
    expect(gitBranch(inner, scoped(inner), 4_000)).toBeNull();
  });

  // The bound is per step, not merely on the entry the walk lands on: an ancestor outside the roots must
  // not be inspected at all, even when the pointer it carries would resolve back inside them.
  it('does not describe an enclosing repository whose pointer resolves back into the root', () => {
    const outer = workspace();
    const inner = join(outer, 'mine');
    mkdirSync(join(inner, '.real-git'), { recursive: true });
    writeFileSync(join(inner, '.real-git', 'HEAD'), 'ref: refs/heads/mine\n');
    writeFileSync(join(outer, '.git'), `gitdir: ${join(inner, '.real-git')}\n`);
    expect(gitBranch(inner, ALL, 6_000)).toBe('mine');
    expect(gitBranch(inner, scoped(inner), 6_000)).toBeNull();
  });

  it('refuses a directory outside the caller\'s roots altogether', () => {
    const foreign = repo('ref: refs/heads/not-yours\n');
    const mine = workspace();
    expect(gitBranch(foreign, scoped(mine), 5_000)).toBeNull();
    // A user with no project access at all reads nothing, including the daemon's own worktree.
    expect(gitBranch(foreign, scoped(), 5_000)).toBeNull();
  });
});
