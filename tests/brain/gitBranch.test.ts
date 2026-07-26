import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitBranch, GIT_BRANCH_TTL_MS } from '../../src/brain/service/gitBranch.js';

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
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('gitBranch', () => {
  it('reads the symbolic branch name of the worktree containing the directory', () => {
    const root = repo('ref: refs/heads/feature/telemetry\n');
    const nested = join(root, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    expect(gitBranch(root, 1_000)).toBe('feature/telemetry');
    expect(gitBranch(nested, 1_000)).toBe('feature/telemetry');
  });

  it('reports the short commit for a detached HEAD', () => {
    const root = repo('9f1c2ad3b4e5f60718293a4b5c6d7e8f90a1b2c3\n');
    expect(gitBranch(root, 1_000)).toBe('9f1c2ad');
  });

  it('follows a `.git` FILE (worktree / submodule) to its real git dir', () => {
    const root = repo('ref: refs/heads/linked\n', { gitFile: true });
    expect(gitBranch(root, 1_000)).toBe('linked');
  });

  it('is null outside a repository and for an unreadable HEAD', () => {
    const plain = mkdtempSync(join(tmpdir(), 'git-branch-none-'));
    dirs.push(plain);
    expect(gitBranch(plain, 1_000)).toBeNull();
    const broken = mkdtempSync(join(tmpdir(), 'git-branch-broken-'));
    dirs.push(broken);
    mkdirSync(join(broken, '.git'));
    expect(gitBranch(broken, 1_000)).toBeNull();
  });

  // `/brain/status` is a hot poll: a second lookup inside the TTL must answer from the cache and touch no
  // filesystem at all. Rewriting HEAD underneath is the observable proof — a re-read would see the change.
  it('answers a repeat lookup from cache within the TTL and refreshes after it', () => {
    const root = repo('ref: refs/heads/before\n');
    expect(gitBranch(root, 10_000)).toBe('before');
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/after\n');
    expect(gitBranch(root, 10_000 + GIT_BRANCH_TTL_MS - 1)).toBe('before');
    expect(gitBranch(root, 10_000 + GIT_BRANCH_TTL_MS)).toBe('after');
  });

  it('caches the "not a repository" answer too, so a non-repo cwd never re-walks the tree', () => {
    const plain = mkdtempSync(join(tmpdir(), 'git-branch-cache-none-'));
    dirs.push(plain);
    expect(gitBranch(plain, 50_000)).toBeNull();
    mkdirSync(join(plain, '.git'));
    writeFileSync(join(plain, '.git', 'HEAD'), 'ref: refs/heads/late\n');
    expect(gitBranch(plain, 50_000 + GIT_BRANCH_TTL_MS - 1)).toBeNull();
    expect(gitBranch(plain, 50_000 + GIT_BRANCH_TTL_MS)).toBe('late');
  });
});
