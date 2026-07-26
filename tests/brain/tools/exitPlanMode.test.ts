import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildExitPlanModeTool, EXIT_PLAN_MODE_TOOL } from '../../../src/brain/tools/exitPlanMode.js';
import { writePlan } from '../../../src/brain/continuity/planStore.js';
import { runWithPolicy } from '../../../src/plugins/policyContext.js';
import { planSlug } from '../../../src/shared/planSlug.js';
import type { Policy } from '../../../src/plugins/policy.js';
import type { TurnWorkMode } from '../../../src/shared/types.js';

const POLICY: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const SESSION = 'brain-ch-owner-1';

type ToolResult = { content: { type: string; text: string }[] };

function call(opts: { mode?: TurnWorkMode; sessionId?: string } = {}): Promise<ToolResult> {
  const tool = buildExitPlanModeTool();
  return runWithPolicy(
    POLICY,
    () => tool.execute('call-1', {} as never, undefined, undefined, {} as never) as Promise<ToolResult>,
    { sessionId: 'sessionId' in opts ? opts.sessionId : SESSION, mode: opts.mode },
  );
}

const textOf = (r: ToolResult) => r.content[0]!.text;

describe('ExitPlanMode', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'elowen-exitplan-'));
    vi.stubEnv('HOME', home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  // The name is what the model has seen elsewhere; a private spelling would waste that familiarity.
  it('is named exactly as the reference names it', () => {
    expect(EXIT_PLAN_MODE_TOOL).toBe('ExitPlanMode');
    expect(buildExitPlanModeTool().name).toBe('ExitPlanMode');
  });

  it('submits the plan written to the session plan file', async () => {
    writePlan(SESSION, '# Ship it\n\nStep one.');
    const text = textOf(await call({ mode: 'plan' }));
    expect(text).toContain('submitted');
    // It must not read as approval — the decision has not been taken yet.
    expect(text).toContain('Stop here');
    expect(text).toMatch(/do not begin implementing/i);
  });

  // Reading a stale plan file outside plan mode would let a build turn resurrect an old plan as fresh.
  it('refuses outside plan mode even when a plan file exists', async () => {
    writePlan(SESSION, '# Ship it');
    for (const mode of ['build', undefined] as const) {
      expect(textOf(await call({ mode }))).toContain('You are not in plan mode');
    }
  });

  it('refuses when there is no session to scope a plan to', async () => {
    expect(textOf(await call({ mode: 'plan', sessionId: undefined }))).toContain('You are not in plan mode');
  });

  it('names the file to write when the model calls it before writing a plan', async () => {
    const text = textOf(await call({ mode: 'plan' }));
    expect(text).toContain('No plan has been written yet');
    expect(text).toContain(`${planSlug(SESSION)}.md`);
    expect(text).toContain(EXIT_PLAN_MODE_TOOL);
  });

  it('treats a whitespace-only plan as no plan', async () => {
    writePlan(SESSION, '# Ship it');
    // writePlan ignores an all-whitespace body, so overwrite the file the way a model emptying its own
    // plan file would.
    writeFileSync(join(home, '.config/elowen/plans', `${planSlug(SESSION)}.md`), '   \n\n');
    expect(textOf(await call({ mode: 'plan' }))).toContain('No plan has been written yet');
  });

  it('takes no parameters, so there is nothing for the model to get wrong', () => {
    const params = buildExitPlanModeTool().parameters as { type?: string; properties?: object };
    expect(params.type).toBe('object');
    expect(Object.keys(params.properties ?? {})).toEqual([]);
  });
});
