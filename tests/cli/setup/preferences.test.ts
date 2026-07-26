import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { runPreferencesStep } from '../../../src/cli/setup/steps/preferences.js';
import type { WizardCtx } from '../../../src/cli/setup/types.js';

// The step drives the prompt adapter: one text field (timezone) then two confirms (reasoning, auto-compact).
vi.mock('../../../src/cli/ui/prompts.js', () => ({
  text: vi.fn(),
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

describe('cli/setup wizard Preferences step', () => {
  it('persists a timezone, a hidden-reasoning choice and enabled auto-compaction to their own endpoints', async () => {
    (p.text as Mock).mockResolvedValueOnce('Europe/Prague'); // timezone
    (p.confirm as Mock).mockResolvedValueOnce(false); // show reasoning? → No (hide)
    (p.confirm as Mock).mockResolvedValueOnce(true); // auto-compact? → Yes
    const { fetchFn, calls } = routedFetch({
      'PUT /config': { ok: true },
      'PATCH /auth/me/terminal-settings': { ok: true },
      'PATCH /auth/me/cli-settings': { ok: true },
    });
    const ctx: WizardCtx = { base: 'http://x', fetchFn, token: 't', answers: {} };

    const r = await runPreferencesStep(ctx);

    expect(r).toEqual({ status: 'done' });
    // Timezone → runtime-context plugin config (operator config).
    expect(calls).toContainEqual({ method: 'PUT', path: '/config', body: { plugins: { config: { 'runtime-context': { timezone: 'Europe/Prague' } } } } });
    // Reasoning visibility → terminal settings.
    expect(calls).toContainEqual({ method: 'PATCH', path: '/auth/me/terminal-settings', body: { showThoughtsCli: false } });
    // Auto-compaction → CLI settings, at the store default threshold.
    expect(calls).toContainEqual({ method: 'PATCH', path: '/auth/me/cli-settings', body: { autoCompact: true, autoCompactAt: 80 } });
    expect(ctx.answers.preferences?.summary).toBe('Europe/Prague · reasoning hidden · auto-compact on');
  });

  it('writes nothing but the timezone when the defaults are accepted (reasoning shown, compaction off)', async () => {
    (p.text as Mock).mockResolvedValueOnce('UTC');
    (p.confirm as Mock).mockResolvedValueOnce(true); // keep reasoning shown (default) → no terminal write
    (p.confirm as Mock).mockResolvedValueOnce(false); // leave auto-compaction off (default) → no cli write
    const { fetchFn, calls } = routedFetch({ 'PUT /config': { ok: true } });
    const ctx: WizardCtx = { base: 'http://x', fetchFn, token: 't', answers: {} };

    const r = await runPreferencesStep(ctx);

    expect(r).toEqual({ status: 'done' });
    expect(calls).toHaveLength(1); // only the timezone PUT
    expect(calls[0]).toEqual({ method: 'PUT', path: '/config', body: { plugins: { config: { 'runtime-context': { timezone: 'UTC' } } } } });
    expect(ctx.answers.preferences?.summary).toBe('UTC');
  });

  it('persists nothing when the timezone is cleared and both defaults are kept', async () => {
    (p.text as Mock).mockResolvedValueOnce('   '); // cleared → falls back to the server timezone
    (p.confirm as Mock).mockResolvedValueOnce(true);
    (p.confirm as Mock).mockResolvedValueOnce(false);
    const { fetchFn, calls } = routedFetch({});
    const ctx: WizardCtx = { base: 'http://x', fetchFn, token: 't', answers: {} };

    const r = await runPreferencesStep(ctx);

    expect(r).toEqual({ status: 'done' });
    expect(calls).toHaveLength(0);
    expect(ctx.answers.preferences?.summary).toBe('server timezone');
  });

  // A typo here is silent in production: the daemon falls back to the server's zone, so every scheduled
  // job just fires at the wrong hour with nothing to trace it back to. Reject it at the prompt instead.
  it('rejects a non-IANA timezone at the prompt and accepts a real one (blank = server zone)', async () => {
    (p.text as Mock).mockResolvedValueOnce('UTC');
    (p.confirm as Mock).mockResolvedValueOnce(true);
    (p.confirm as Mock).mockResolvedValueOnce(false);
    const { fetchFn } = routedFetch({ 'PUT /config': { ok: true } });

    await runPreferencesStep({ base: 'http://x', fetchFn, token: 't', answers: {} });

    const { validate } = (p.text as Mock).mock.calls[0][0] as { validate?: (v: string | undefined) => string | undefined };
    expect(validate).toBeTypeOf('function');
    expect(validate?.('Europe/Prague')).toBeUndefined();
    expect(validate?.('')).toBeUndefined();
    expect(validate?.('Prague')).toMatch(/IANA/);
    expect(validate?.('CET+2')).toMatch(/IANA/);
  });
});
