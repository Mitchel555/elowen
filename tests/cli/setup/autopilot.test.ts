import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { runAutopilotStep, shouldWireAutopilot } from '../../../src/cli/setup/steps/autopilot.js';
import type { WizardCtx, WizardAnswers } from '../../../src/cli/setup/types.js';

// The step drives the prompt adapter; only `confirm` matters here (enable / skip).
vi.mock('../../../src/cli/ui/prompts.js', () => ({
  confirm: vi.fn(),
  spinner: () => ({ start: () => {}, stop: () => {} }),
  log: { info: () => {}, success: () => {}, error: () => {}, warn: () => {}, step: () => {}, message: () => {} },
  note: () => {},
  isCancel: () => false,
}));
import * as p from '../../../src/cli/ui/prompts.js';

type Call = { method: string; path: string; body: unknown };
function routedFetch(routes: Record<string, unknown>): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    if (!(key in routes)) throw new Error(`unmocked route: ${key}`);
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const eligibleAi = (): WizardAnswers['ai'] => ({ status: 'done', summary: 'Relay (m1)', providerId: 'relay', providerType: 'openai', model: 'm1', hasKey: true });

describe('cli/setup.shouldWireAutopilot', () => {
  it('wires only an openai-type provider that has a key (the relay trap guard)', () => {
    expect(shouldWireAutopilot('openai', true)).toBe(true);
    expect(shouldWireAutopilot('openai', false)).toBe(false); // no key → relay unusable
    expect(shouldWireAutopilot('anthropic', true)).toBe(false); // relay is OpenAI-only
    expect(shouldWireAutopilot('oauth-anthropic', true)).toBe(false);
    expect(shouldWireAutopilot('oauth-openai-codex', true)).toBe(false); // no stored key
    expect(shouldWireAutopilot(undefined, undefined)).toBe(false); // AI step skipped
  });
});

describe('cli/setup wizard Autopilot step', () => {
  it('enables autopilot on the connected provider when the user opts in', async () => {
    (p.confirm as Mock).mockResolvedValueOnce(true);
    const { fetchFn, calls } = routedFetch({ 'PUT /config': { ok: true } });
    const ctx: WizardCtx = { base: 'http://x', fetchFn, token: 't', answers: { ai: eligibleAi() } };

    const r = await runAutopilotStep(ctx);

    expect(r).toEqual({ status: 'done' });
    expect(ctx.answers.autopilot).toEqual({ status: 'done', summary: 'enabled' });
    // Same patch the AI step used to write inline: providerId + the resolved model.
    expect(calls).toContainEqual({ method: 'PUT', path: '/config', body: { autopilot: { providerId: 'relay', model: 'm1' } } });
  });

  it('omits the model from the patch when the provider resolved none', async () => {
    (p.confirm as Mock).mockResolvedValueOnce(true);
    const { fetchFn, calls } = routedFetch({ 'PUT /config': { ok: true } });
    const ctx: WizardCtx = { base: 'http://x', fetchFn, token: 't', answers: { ai: { ...eligibleAi()!, model: '' } } };

    await runAutopilotStep(ctx);
    expect(calls).toContainEqual({ method: 'PUT', path: '/config', body: { autopilot: { providerId: 'relay' } } });
  });

  it('skips in a single keypress (default No) without touching config', async () => {
    (p.confirm as Mock).mockResolvedValueOnce(false);
    const { fetchFn, calls } = routedFetch({});
    const ctx: WizardCtx = { base: 'http://x', fetchFn, token: 't', answers: { ai: eligibleAi() } };

    const r = await runAutopilotStep(ctx);
    expect(r).toEqual({ status: 'skipped' });
    expect(ctx.answers.autopilot).toEqual({ status: 'skipped', summary: 'not enabled' });
    expect(calls).toHaveLength(0); // nothing PUT
  });

  it('never asks when no eligible provider exists — states it plainly and moves on', async () => {
    (p.confirm as Mock).mockReset();
    const { fetchFn, calls } = routedFetch({});
    // Anthropic reused: connected, but can't back the OpenAI-compatible relay.
    const ctx: WizardCtx = {
      base: 'http://x', fetchFn, token: 't',
      answers: { ai: { status: 'done', summary: 'Claude', providerId: 'claude', providerType: 'anthropic', model: 'x', hasKey: true } },
    };

    const r = await runAutopilotStep(ctx);
    expect(r).toEqual({ status: 'skipped' });
    expect(ctx.answers.autopilot?.status).toBe('skipped');
    expect(p.confirm).not.toHaveBeenCalled(); // no unanswerable question
    expect(calls).toHaveLength(0);
  });

  it('treats a skipped AI step as ineligible (no provider to relay through)', async () => {
    (p.confirm as Mock).mockReset();
    const { fetchFn } = routedFetch({});
    const ctx: WizardCtx = { base: 'http://x', fetchFn, token: 't', answers: { ai: { status: 'skipped', summary: 'not configured' } } };

    const r = await runAutopilotStep(ctx);
    expect(r).toEqual({ status: 'skipped' });
    expect(p.confirm).not.toHaveBeenCalled();
  });
});
