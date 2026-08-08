import { describe, it, expect, afterEach } from 'vitest';
import { buildBrainCore } from '../../src/daemon/brainCore.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import { setWorkflowLivenessProbe, probeWorkflowLiveness, workflowEngineProbeFrom } from '../../src/brain/service/statusService.js';

// The WIRING is the protection here (same reasoning as brainCoreCredentials.test.ts): the status
// service's workflow-liveness probe is module-level state that buildBrainCore must point at the loaded
// plugin registry's `workflow` control. The statusService tests all inject their own probe, so without
// THIS test, deleting the setWorkflowLivenessProbe call from brainCore would keep every one of them
// green while production silently fell back to guessing liveness from the origin PI session — the exact
// stale-anchor failure the probe exists to close.
describe('brainCore wires the workflow liveness probe', () => {
  afterEach(() => { setWorkflowLivenessProbe(() => undefined); });

  it('buildBrainCore replaces whatever probe was installed before it', async () => {
    // Sentinel: if brainCore did NOT re-wire the probe, this stale answer would survive construction.
    setWorkflowLivenessProbe(() => true);
    expect(probeWorkflowLiveness('wf-any')).toBe(true);

    const core = await buildBrainCore({
      dbPath: ':memory:',
      project: { id: 1, slug: 'wiring', path: '/tmp' },
      tmux: new FakeTmuxDriver(),
      bootstrap: null,
    });
    try {
      // The wired probe reads the lazily-loaded plugin registry, which has not loaded here — so it must
      // answer undefined (cannot tell), while the sentinel would still have answered true.
      expect(probeWorkflowLiveness('wf-any')).toBeUndefined();
    } finally {
      core.db.close();
    }
  });

  it('workflowEngineProbeFrom asks the workflow control and degrades to "cannot tell"', () => {
    const registryWithControl = {
      control: (name: 'workflow') => (name === 'workflow'
        ? { isWorkflowLive: ({ workflowId }: { workflowId: string }) => workflowId === 'wf-live' }
        : undefined),
    };
    const wired = workflowEngineProbeFrom(() => registryWithControl);
    expect(wired('wf-live')).toBe(true);
    expect(wired('wf-gone')).toBe(false);

    // No registry yet (lazy load has not happened) → undefined, never a guess.
    expect(workflowEngineProbeFrom(() => undefined)('wf-live')).toBeUndefined();
    // Registry loaded but the control absent (plugin disabled) → undefined too.
    expect(workflowEngineProbeFrom(() => ({ control: () => undefined }))('wf-live')).toBeUndefined();
  });
});
