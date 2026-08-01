import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { LiveSessionSpawner } from '../../src/brain/service/spawner.js';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import type { Policy } from '../../src/plugins/policy.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import type { RuntimeConfig } from '../../src/store/configStore.js';

/** Deferred-tool policy against the OPERATOR'S settings (Elowen AI → Runtime): the spawner used to call
 *  computeDeferredToolNames with the policy's own defaults, so a session with 12 bridged MCP tools always
 *  deferred and there was no way to turn it off. These drive the real spawn path — `live.toolSearch` is
 *  undefined exactly when nothing is withheld. */
let sharedRuntime: ModelRuntime;
beforeAll(async () => { sharedRuntime = await inMemoryModelRuntime(); });

const policy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };

/** A registry holding `count` bridged MCP tools — the only tools the policy ever defers. */
function registryWithMcpTools(count: number): PluginRegistry {
  const reg = new PluginRegistry();
  const ctx = reg.contextFor('mcp', {}, { info() {}, warn() {}, error() {} });
  for (let i = 0; i < count; i++) {
    ctx.registerTool(defineTool({
      name: `mcp__github__op_${i}`, label: `op ${i}`, description: `GitHub operation ${i}`,
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: {} }),
    }));
  }
  return reg;
}

function makeSpawner(tools: number, runtimeConfig?: () => RuntimeConfig) {
  const fakeSession = { sessionId: 'sess-1', subscribe: () => () => {} };
  const create = vi.fn(async () => ({
    session: fakeSession as unknown as AgentSession,
    applyCompaction: vi.fn(),
  }));
  const registry = registryWithMcpTools(tools);
  const spawner = new LiveSessionSpawner({
    config: { providers: [{ id: 'relay', label: 'Relay', type: 'openai' as const, baseUrl: 'http://relay.example/v1', models: ['gpt-5'], apiKey: 'k' }] },
    store: new BrainStore(openDb(':memory:')),
    runtime: sharedRuntime,
    users: { ensureAdvisorToken: () => 'token', get: () => ({ name: 'Filip', username: 'filip' }) },
    prompts: { render: () => 'PERSONA' },
    url: 'http://x',
    plugins: async () => registry,
    factory: { create },
    sessionTaps: () => [],
    ...(runtimeConfig ? { runtimeConfig } : {}),
  });
  return () => spawner.spawn({
    sessionId: 'sess-1', ownerUserId: 1, selection: {}, policy,
    autoCompact: false, autoCompactAtPct: 80,
  });
}

describe('LiveSessionSpawner — deferred-tool policy from the runtime config', () => {
  const runtime = (threshold: number, enabled = true): RuntimeConfig => ({
    limits: { localShellTimeoutMs: 30_000, memorySemanticFloorPerMille: 300, toolDeferThreshold: threshold, eventRetentionDays: 30 },
    toolDeferralEnabled: enabled,
  });

  it('defers once the MCP tool count exceeds the CONFIGURED threshold', async () => {
    const live = await makeSpawner(6, () => runtime(5))();
    expect(live.toolSearch?.deferred.size).toBe(6);
  });

  it('withholds nothing while the count is at or under the configured threshold', async () => {
    // 12 tools defer under the built-in threshold of 10, so a raised threshold that changes nothing here
    // would mean the configured value never reached the policy.
    const live = await makeSpawner(12, () => runtime(20))();
    expect(live.toolSearch).toBeUndefined();
  });

  it('the kill switch wins over the threshold', async () => {
    const live = await makeSpawner(12, () => runtime(5, false))();
    expect(live.toolSearch).toBeUndefined();
  });

  it('falls back to the policy defaults when no runtime config is wired', async () => {
    expect((await makeSpawner(12)()).toolSearch?.deferred.size).toBe(12); // above the built-in 10
    expect((await makeSpawner(4)()).toolSearch).toBeUndefined();
  });

  it('reads the config per spawn, so a settings change applies without a restart', async () => {
    let threshold = 20;
    const spawn = makeSpawner(12, () => runtime(threshold));
    expect((await spawn()).toolSearch).toBeUndefined();
    threshold = 3;
    expect((await spawn()).toolSearch?.deferred.size).toBe(12);
  });
});
