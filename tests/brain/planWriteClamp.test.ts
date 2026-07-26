import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { composeSessionTools } from '../../src/brain/session/capabilities.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import { buildPermissionRuleset, sanitizePermissionSettings, type TurnPermissions } from '../../src/brain/toolPermissions.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { TurnWorkMode } from '../../src/shared/types.js';

const POLICY: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const SESSION = 'brain-ch-plan';

type ToolResult = { content: { type: string; text: string }[] };

function fakeTool(name: string): { tool: ToolDefinition; ran: () => number } {
  let runs = 0;
  const tool = {
    name, label: name, description: name, parameters: {} as never,
    execute: async () => { runs++; return { content: [{ type: 'text', text: `ran ${name}` }], details: {} }; },
  } as unknown as ToolDefinition;
  return { tool, ran: () => runs };
}

const composed = (name: string) => {
  const { tool, ran } = fakeTool(name);
  const [gated] = composeSessionTools({ kind: 'owner-chat', pluginTools: [tool] });
  return { gated: gated!, ran };
};

const perms = (): TurnPermissions => ({ ruleset: buildPermissionRuleset(sanitizePermissionSettings({})), yolo: false });

function call(
  tool: ToolDefinition,
  params: unknown,
  opts: { mode?: TurnWorkMode; permissions?: TurnPermissions } = {},
): Promise<ToolResult> {
  return runWithPolicy(
    POLICY,
    () => tool.execute('call-1', params as never, undefined, undefined, {} as never) as Promise<ToolResult>,
    { sessionId: SESSION, mode: opts.mode, permissions: opts.permissions },
  );
}

/** Plan mode keeps its read-only promise by WITHHOLDING every writing tool. `Write` is admitted back so
 *  the model can author its own plan file, and this clamp is the whole of what keeps that safe — without
 *  it, admitting the tool simply hands plan mode arbitrary write access. */
describe('plan-mode write clamp', () => {
  let home: string;
  const planPath = join('.config/elowen/plans', `${SESSION}.md`);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'elowen-clamp-'));
    vi.stubEnv('HOME', home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('lets a planning turn write its own plan file', async () => {
    const { gated, ran } = composed('Write');
    const res = await call(gated, { path: join(home, planPath) }, { mode: 'plan', permissions: perms() });
    expect(ran()).toBe(1);
    expect(res.content[0]!.text).toBe('ran Write');
  });

  it('refuses a planning write to anywhere else, and does not run the tool', async () => {
    const { gated, ran } = composed('Write');
    const res = await call(gated, { path: join(home, 'src/index.ts') }, { mode: 'plan', permissions: perms() });
    expect(ran()).toBe(0);
    expect(res.content[0]!.text).toContain('Plan mode is read-only');
  });

  // The ordering that matters: gatePermissions goes inert when a turn carries no TurnPermissions scope.
  // If the clamp sat behind that early return, "plan mode cannot write" would hold only for turns that
  // happen to have permissions configured.
  it('refuses even when the turn carries no permission scope at all', async () => {
    const { gated, ran } = composed('Write');
    const res = await call(gated, { path: join(home, 'src/index.ts') }, { mode: 'plan' });
    expect(ran()).toBe(0);
    expect(res.content[0]!.text).toContain('Plan mode is read-only');
  });

  it('refuses a write whose path is missing or not a string', async () => {
    const { gated, ran } = composed('Write');
    for (const params of [{}, { path: 42 }, { path: null }, null]) {
      const res = await call(gated, params, { mode: 'plan', permissions: perms() });
      expect(res.content[0]!.text).toContain('Plan mode is read-only');
    }
    expect(ran()).toBe(0);
  });

  // Edit is withheld from plan mode entirely; it is clamped anyway so that admitting it later cannot
  // silently reopen the hole.
  it('clamps Edit as well as Write', async () => {
    const { gated, ran } = composed('Edit');
    const res = await call(gated, { path: join(home, 'src/index.ts') }, { mode: 'plan', permissions: perms() });
    expect(ran()).toBe(0);
    expect(res.content[0]!.text).toContain('Plan mode is read-only');
  });

  it('leaves writes alone outside plan mode', async () => {
    const { gated, ran } = composed('Write');
    await call(gated, { path: join(home, 'src/index.ts') }, { mode: 'build', permissions: perms() });
    await call(gated, { path: join(home, 'src/index.ts') }, { permissions: perms() });
    expect(ran()).toBe(2);
  });

  it('leaves non-writing tools alone inside plan mode', async () => {
    const { gated, ran } = composed('Read');
    await call(gated, { path: join(home, 'src/index.ts') }, { mode: 'plan', permissions: perms() });
    expect(ran()).toBe(1);
  });

  it('refuses a traversal that leaves the plans directory', async () => {
    const { gated, ran } = composed('Write');
    const escape = join(home, '.config/elowen/plans', '..', '..', '..', 'victim.md');
    const res = await call(gated, { path: escape }, { mode: 'plan', permissions: perms() });
    expect(ran()).toBe(0);
    expect(res.content[0]!.text).toContain('Plan mode is read-only');
  });
});
