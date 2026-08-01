import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationLifecycle } from '../../src/brain/service/lifecycle.js';
import { ClientAttachments } from '../../src/brain/service/attachments.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { GoalLoopService } from '../../src/brain/service/goalLoop.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import type { LiveBrain, SpawnOpts } from '../../src/brain/session/liveBrain.js';

/** A web conversation sends no cwd with its turn, so a cold respawn (daemon restart, plugin reload,
 *  last client detach) used to resolve the policy root instead of the session's own home — the
 *  wrong-repo bug these tests pin down. They go through the REAL ensureLive with a real BrainStore and
 *  a real registry; only the spawn is a mock that captures the opts the conversation was respawned
 *  with, mirroring the wiring of respawnLifecycle.test.ts. */

function live(spec: { model: string; sessionId: string }): LiveBrain {
  return {
    session: { dispose: vi.fn(), isStreaming: false } as never,
    sessionId: spec.sessionId,
    model: spec.model,
    requestProfile: { fast: false },
    fastAvailable: false,
    thinkingLabels: {},
    policy: { allowedProjectIds: 'all', allowedPaths: () => [] },
    listeners: new Set(),
    replay: { publish: vi.fn() } as never,
    turnContext: () => ({ beforeUser: '', afterUser: '' }),
    pluginToolNames: new Set(),
  } as LiveBrain;
}

function harness(spawn: (opts: SpawnOpts) => Promise<LiveBrain>, extra: {
  projectModelPreference?: (userId: number, projectRoot: string) => { provider?: string; model?: string } | undefined;
} = {}) {
  const sessions = new LiveSessionRegistry<LiveBrain>();
  const attachments = new ClientAttachments();
  const store = new BrainStore(openDb(':memory:'));
  store.createSession({ id: 'brain-1', userId: 1, title: 'T', model: 'm' });

  let lifecycle!: ConversationLifecycle;
  const goals = new GoalLoopService({
    store,
    ownedUserSession: (userId, sessionId) => lifecycle.ownedUserSession(userId, sessionId),
    activeSessionId: (userId) => lifecycle.activeSessionId(userId),
    attachedCount: (sessionId) => attachments.attachedCount(sessionId),
    ensureLive: (userId, sessionId, o) => lifecycle.ensureLive(userId, sessionId, o),
    start: async (userId) => ({ sessionId: lifecycle.activeSessionId(userId) }),
    send: vi.fn(async () => {}),
    defaultTurnBudget: () => 8,
    goalMaxTurns: () => 64,
    isYolo: () => false,
    publishGoal: () => {},
  });
  lifecycle = new ConversationLifecycle({
    store,
    sessions,
    attachments,
    elicitation: { cancelForSession: vi.fn() },
    goals,
    spawn,
    policy: () => ({ allowedProjectIds: 'all', allowedPaths: () => [] }),
    userSettings: () => ({ autoCompact: false, autoCompactAt: 80 }),
    selectionAllowed: () => true,
    projectModelPreference: extra.projectModelPreference,
  } as never);
  return { sessions, attachments, store, lifecycle };
}

describe('ensureLive restores the stored work_dir on a cwd-less respawn', () => {
  let dirs: string[] = [];
  const tmpDir = (tag: string): string => { const p = mkdtempSync(join(tmpdir(), `elowen-workdir-${tag}-`)); dirs.push(p); return p; };
  afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

  it('restores the stored work_dir when the respawn carries no client or spawn cwd', async () => {
    const home = realpathSync(tmpDir('home'));
    let spawnedCwd: string | undefined;
    const spawn = vi.fn(async (o: SpawnOpts) => { spawnedCwd = o.clientCwd; return live({ model: 'm', sessionId: o.sessionId }); });
    const { sessions, store, lifecycle } = harness(spawn);
    store.setWorkDir('brain-1', home);

    await lifecycle.ensureLive(1, 'brain-1');

    expect(spawnedCwd).toBe(home);
    expect(sessions.get('brain-1')).toBeDefined();
  });

  it('a client-reported cwd still beats the stored work_dir', async () => {
    const stored = realpathSync(tmpDir('stored'));
    const client = realpathSync(tmpDir('client'));
    let spawnedCwd: string | undefined;
    const spawn = vi.fn(async (o: SpawnOpts) => { spawnedCwd = o.clientCwd; return live({ model: 'm', sessionId: o.sessionId }); });
    const { store, lifecycle } = harness(spawn);
    store.setWorkDir('brain-1', stored);

    await lifecycle.ensureLive(1, 'brain-1', { clientCwd: client });

    expect(spawnedCwd).toBe(client);
  });

  it('an empty stored work_dir stays cwd-less instead of resolving to an empty string', async () => {
    let spawnedCwd: string | undefined;
    const spawn = vi.fn(async (o: SpawnOpts) => { spawnedCwd = o.clientCwd; return live({ model: 'm', sessionId: o.sessionId }); });
    const { store, lifecycle } = harness(spawn);
    store.setWorkDir('brain-1', '');

    await lifecycle.ensureLive(1, 'brain-1');

    expect(spawnedCwd).toBeUndefined();
  });

  it('the restored directory is not stamped back into the session row as a fresh client report', async () => {
    // Seeded through a SYMLINK: stampWorkDir realpaths what it stamps, so a restamp would rewrite the
    // row from the link path to its target — leaving the row untouched is the observable proof that a
    // cwd-less respawn never re-confirmed the directory as client-reported.
    const target = realpathSync(tmpDir('target'));
    const link = join(realpathSync(tmpDir('link')), 'home');
    symlinkSync(target, link);
    let spawnedCwd: string | undefined;
    const spawn = vi.fn(async (o: SpawnOpts) => { spawnedCwd = o.clientCwd; return live({ model: 'm', sessionId: o.sessionId }); });
    const { store, lifecycle } = harness(spawn);
    store.setWorkDir('brain-1', link);

    await lifecycle.ensureLive(1, 'brain-1');

    expect(spawnedCwd).toBe(link);
    expect(store.getSession('brain-1')?.work_dir).toBe(link);
  });

  it('the restored work_dir also feeds the project-model pick, like any other respawn cwd', async () => {
    const home = realpathSync(tmpDir('home'));
    mkdirSync(join(home, '.git'));
    const projectPref = vi.fn(() => ({ provider: 'prov', model: 'project-model' }));
    const spawn = vi.fn(async (o: SpawnOpts) => live({ model: 'm', sessionId: o.sessionId }));
    const { store, lifecycle } = harness(spawn, { projectModelPreference: projectPref });
    store.setWorkDir('brain-1', home);

    await lifecycle.ensureLive(1, 'brain-1');

    expect(projectPref).toHaveBeenCalledWith(1, home);
  });
});
