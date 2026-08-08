import { describe, it, expect } from 'vitest';
import { parseDaemonMessage, parseRunnerMessage } from '../../src/subagent/protocol.js';

const boot = (extra: Record<string, unknown> = {}): unknown => ({
  type: 'boot',
  buildId: 'v1:1:1',
  dbPath: '/tmp/elowen.db',
  project: { id: 1, slug: 'e2e', path: '/tmp/project' },
  ...extra,
});

describe('parseDaemonMessage — boot', () => {
  it('parses a boot frame without a snapshot, and leaves the field absent', () => {
    const msg = parseDaemonMessage(boot());
    expect(msg).toEqual({ type: 'boot', buildId: 'v1:1:1', dbPath: '/tmp/elowen.db', project: { id: 1, slug: 'e2e', path: '/tmp/project' } });
    // Absent, not `undefined`: it is what the mcp plugin branches on, and "the daemon bridges nothing"
    // (an empty array) must stay distinguishable from "the daemon said nothing" (connect at boot).
    expect(msg && 'mcp' in msg).toBe(false);
  });

  it('carries a bridged-MCP snapshot through', () => {
    const mcp = [{ serverName: 'parity', tools: [{ name: 'echo_text', description: 'Echo it' }] }];
    expect(parseDaemonMessage(boot({ mcp }))).toMatchObject({ type: 'boot', mcp });
  });

  it('keeps an EMPTY snapshot, which means "connect nothing" rather than "connect everything"', () => {
    expect(parseDaemonMessage(boot({ mcp: [] }))).toMatchObject({ type: 'boot', mcp: [] });
  });

  it('refuses the whole frame when the snapshot is malformed', () => {
    // Booting without it would look identical from outside while composing a DIFFERENT tool list, so the
    // frame is dropped rather than degraded — the host's boot timeout then reports a runner that never came
    // up, which is loud, instead of a runner that quietly serves the wrong prompt.
    expect(parseDaemonMessage(boot({ mcp: 'nope' }))).toBeUndefined();
    expect(parseDaemonMessage(boot({ mcp: [{ serverName: 'parity' }] }))).toBeUndefined();
    expect(parseDaemonMessage(boot({ mcp: [{ serverName: 'parity', tools: [{ title: 'unnamed' }] }] }))).toBeUndefined();
  });

  it('still refuses a boot frame that is broken for the old reasons', () => {
    expect(parseDaemonMessage({ ...(boot() as object), dbPath: undefined })).toBeUndefined();
    expect(parseDaemonMessage({ ...(boot() as object), project: { id: 1.5, slug: 'e2e', path: '/tmp' } })).toBeUndefined();
  });
});

describe('steer verb — daemon → runner and back', () => {
  it('parses a steer frame', () => {
    expect(parseDaemonMessage({ type: 'steer', steerId: 's-1', channelId: 'subagent-sub-dlg-1', text: 'also check docs' }))
      .toEqual({ type: 'steer', steerId: 's-1', channelId: 'subagent-sub-dlg-1', text: 'also check docs' });
  });

  it('refuses a steer frame missing its id, channel or text', () => {
    expect(parseDaemonMessage({ type: 'steer', channelId: 'c', text: 't' })).toBeUndefined();
    expect(parseDaemonMessage({ type: 'steer', steerId: 's', text: 't' })).toBeUndefined();
    expect(parseDaemonMessage({ type: 'steer', steerId: 's', channelId: 'c' })).toBeUndefined();
    // An empty text would queue a blank user message and still be reported 'delivered' — refused whole.
    expect(parseDaemonMessage({ type: 'steer', steerId: 's', channelId: 'c', text: '' })).toBeUndefined();
  });

  it('parses every steered verdict and nothing else', () => {
    for (const outcome of ['delivered', 'idle', 'aborted'] as const) {
      expect(parseRunnerMessage({ type: 'steered', steerId: 's-1', outcome }))
        .toEqual({ type: 'steered', steerId: 's-1', outcome });
    }
    // The daemon ACTS on this verdict (falls back and re-delivers, or reports the delegation aborted), so
    // an unknown outcome must drop the frame rather than be coerced into a wrong obligation.
    expect(parseRunnerMessage({ type: 'steered', steerId: 's-1', outcome: 'maybe' })).toBeUndefined();
    expect(parseRunnerMessage({ type: 'steered', outcome: 'delivered' })).toBeUndefined();
  });
});
