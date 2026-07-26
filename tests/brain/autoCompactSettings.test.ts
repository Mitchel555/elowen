import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { BrainService } from '../../src/brain/brainService.js';
import { BrainWorkerService } from '../../src/brain/worker/brainWorker.js';
import { compactionReserveTokens } from '../../src/brain/session/factory.js';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { EventBus } from '../../src/api/sse.js';

let sharedRuntime: ModelRuntime;
beforeAll(async () => { sharedRuntime = await inMemoryModelRuntime(); });

type CliSettings = {
  autoCompact?: boolean;
  autoCompactAt?: number;
  autoCompactAtByModel?: Record<string, number>;
};

/** A fake PI session that answers `echo:<text>`, plus the surfaces the turn pipeline touches. */
function fakeSession() {
  const listeners: ((e: unknown) => void)[] = [];
  const messages: { role: string; content: string }[] = [];
  const session = {
    sessionId: 'sess-1',
    prompt: vi.fn(async (t: string, options?: { preflightResult?: (success: boolean) => void }) => {
      options?.preflightResult?.(true);
      messages.push({ role: 'user', content: t }, { role: 'assistant', content: `echo:${t}` });
      listeners.forEach((l) => l({ type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', content: `echo:${t}` }] }));
    }),
    subscribe: (l: (e: unknown) => void) => { listeners.push(l); return () => {}; },
    setModel: vi.fn(), dispose: vi.fn(), abort: vi.fn(async () => {}),
    abortCompaction: vi.fn(), abortBranchSummary: vi.fn(),
    messages, isStreaming: false, isCompacting: false,
    steer: vi.fn(async () => {}),
    getSteeringMessages: () => [] as string[],
    getFollowUpMessages: () => [] as string[],
    pendingMessageCount: 0,
    clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
    getContextUsage: () => undefined,
    compact: vi.fn(async () => {}),
    __tools: [] as { name: string }[],
    __active: [] as string[],
    getAllTools(this: { __tools: { name: string }[] }) { return this.__tools; },
    getActiveToolNames(this: { __active: string[] }) { return this.__active; },
    setActiveToolsByName: vi.fn(function (this: { __active: string[] }, names: string[]) { this.__active = names; }),
    model: undefined as unknown,
    agent: { streamFunction: vi.fn() },
    thinkingLevel: '',
    supportsThinking: () => true,
    getAvailableThinkingLevels: () => ['minimal', 'low', 'medium', 'high'],
    setThinkingLevel: vi.fn(),
  };
  return session;
}

/** Minimal BrainService wiring. `settings` is read live, so a test can change it mid-conversation
 *  exactly like a saved Account edit does. Every spawned session's SettingsManager and resolved model
 *  are captured in creation order. */
function brainHarness(settings: () => CliSettings | undefined) {
  const session = fakeSession();
  const spawned: { settings: SettingsManager }[] = [];
  const models: { contextWindow: number }[] = [];
  const createSession = vi.fn(async (opts: { customTools?: { name: string }[]; model?: { contextWindow: number } }) => {
    session.__tools = opts.customTools ?? [];
    session.__active = session.__tools.map((t) => t.name);
    if (opts.model) models.push(opts.model);
    return { session };
  });
  const d = {
    store: new BrainStore(openDb(':memory:')),
    runtime: sharedRuntime,
    users: { ensureAdvisorToken: () => 'tok', get: () => ({ name: 'Filip', username: 'filip' }) },
    config: { providers: [{ id: 'relay', label: 'Relay', type: 'openai' as const, baseUrl: 'http://x/v1', models: ['m'], apiKey: 'k' }] },
    prompts: { render: () => 'PERSONA' },
    url: 'http://x',
    createSession,
    userSettings: () => settings(),
    resourceLoaderFactory: (o: { settingsManager: SettingsManager }) => { spawned.push({ settings: o.settingsManager }); return undefined; },
  };
  return { svc: new BrainService(d as never), createSession, spawned, models };
}

const reserveOf = (manager: SettingsManager): number => manager.getCompactionReserveTokens();
const policy = { allowedProjectIds: 'all' as const, allowedPaths: () => [] };

describe('auto-compact threshold on channel sessions', () => {
  it('spawns a channel at the OWNER’S percentage instead of the built-in default', async () => {
    // Regression: channels hardcoded DEFAULT_AUTO_COMPACT_PCT, so an owner running their clients on
    // Discord never got the threshold they configured in Account → CLI.
    const { svc, spawned, models } = brainHarness(() => ({ autoCompact: true, autoCompactAt: 50 }));

    await svc.channelSend({ channelId: 'c-1', ownerUserId: 1, policy }, 'ahoj');

    expect(spawned).toHaveLength(1);
    expect(reserveOf(spawned[0]!.settings)).toBe(compactionReserveTokens(models[0]!.contextWindow, true, 50));
  });

  it('lets the owner’s per-model override win for a channel session', async () => {
    const { svc, spawned, models } = brainHarness(() => ({
      autoCompact: true, autoCompactAt: 50, autoCompactAtByModel: { 'relay/m': 35 },
    }));

    await svc.channelSend({ channelId: 'c-2', ownerUserId: 1, policy }, 'ahoj');

    expect(reserveOf(spawned[0]!.settings)).toBe(compactionReserveTokens(models[0]!.contextWindow, true, 35));
  });

  it('falls back to the default when the owner has no settings, and keeps compaction proactive', async () => {
    const { svc, spawned, models } = brainHarness(() => undefined);

    await svc.channelSend({ channelId: 'c-3', ownerUserId: 1, policy }, 'ahoj');

    // 80 % — and NOT the disabled-compaction emergency reserve: a channel must stay bounded.
    expect(reserveOf(spawned[0]!.settings)).toBe(compactionReserveTokens(models[0]!.contextWindow, true, 80));
  });
});

describe('auto-compact threshold on live sessions', () => {
  it('re-applies a saved threshold to running owner and channel conversations without respawning them', async () => {
    // Regression: applyOverrides ran only at spawn, so changing the percentage mid-conversation did
    // nothing until a model switch/rollover/restart — the user saw a setting that appeared broken.
    let settings: CliSettings = { autoCompact: true, autoCompactAt: 80 };
    const { svc, createSession, spawned, models } = brainHarness(() => settings);
    await svc.start(1);
    await svc.channelSend({ channelId: 'c-live', ownerUserId: 1, policy }, 'ahoj');
    expect(spawned).toHaveLength(2);
    const spawnCalls = createSession.mock.calls.length;

    settings = { autoCompact: true, autoCompactAt: 45 };
    svc.applyAutoCompactSettings(1);

    expect(reserveOf(spawned[0]!.settings)).toBe(compactionReserveTokens(models[0]!.contextWindow, true, 45));
    expect(reserveOf(spawned[1]!.settings)).toBe(compactionReserveTokens(models[1]!.contextWindow, true, 45));
    expect(createSession.mock.calls).toHaveLength(spawnCalls); // applied in place, no respawn
  });

  it('honours a per-model override and leaves another user’s live sessions untouched', async () => {
    let settings: CliSettings = { autoCompact: true, autoCompactAt: 80 };
    const { svc, spawned, models } = brainHarness(() => settings);
    await svc.start(1);
    await svc.start(2);

    settings = { autoCompact: true, autoCompactAt: 45, autoCompactAtByModel: { 'relay/m': 30 } };
    svc.applyAutoCompactSettings(1);

    expect(reserveOf(spawned[0]!.settings)).toBe(compactionReserveTokens(models[0]!.contextWindow, true, 30));
    expect(reserveOf(spawned[1]!.settings)).toBe(compactionReserveTokens(models[1]!.contextWindow, true, 80));
  });
});

describe('auto-compact threshold on task workers', () => {
  function workerHarness(userSettings?: (userId: number) => CliSettings) {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/repo')").run();
    const tasks = new TaskStore(db);
    tasks.create({ id: 'T-1', project_id: 1, title: 'Fix bug' });
    tasks.setStatus('T-1', 'in_progress');
    const spawned: { settings: SettingsManager }[] = [];
    const models: { contextWindow: number }[] = [];
    const session = fakeSession();
    const svc = new BrainWorkerService({
      store: new BrainStore(db), tasks, bus: new EventBus(),
      runtime: sharedRuntime,
      config: () => ({ providers: [{ id: 'relay', label: 'Relay', type: 'openai', baseUrl: 'http://x/v1', models: ['m'], apiKey: 'k' }] }),
      url: 'http://daemon', token: 'tok',
      userSettings,
      createSession: vi.fn(async (opts: { model?: { contextWindow: number } }) => {
        if (opts.model) models.push(opts.model);
        return { session };
      }) as never,
      resourceLoaderFactory: (o) => { spawned.push({ settings: o.settingsManager }); return undefined; },
    });
    const launch = { projectId: 1, projectPath: '/repo', taskId: 'T-1', agentName: 'a1', spec: { program: 'elowen', model: 'relay/m' } };
    return { svc, launch, spawned, models };
  }

  it('compacts at the task owner’s threshold, per-model override included', async () => {
    const { svc, launch, spawned, models } = workerHarness(() => ({ autoCompactAt: 50, autoCompactAtByModel: { 'relay/m': 40 } }));

    await svc.launch({ ...launch, ownerId: 7 });

    expect(reserveOf(spawned[0]!.settings)).toBe(compactionReserveTokens(models[0]!.contextWindow, true, 40));
  });

  it('falls back to the default for an ownerless task', async () => {
    const { svc, launch, spawned, models } = workerHarness(() => ({ autoCompactAt: 50 }));

    await svc.launch(launch);

    expect(reserveOf(spawned[0]!.settings)).toBe(compactionReserveTokens(models[0]!.contextWindow, true, 80));
  });
});
