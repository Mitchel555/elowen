import * as p from '../../ui/prompts.js';
import type { BrainProviderType } from '../../../store/configStore.js';
import { apiJson } from '../http.js';
import { guard, type StepResult, type WizardCtx } from '../types.js';

/** The autopilot relay is OpenAI-compatible and needs a key — only an openai-type provider WITH a key can
 *  back it (autopilotRelay() returns null without a key; Anthropic/OAuth can't speak the protocol). */
export function shouldWireAutopilot(type: BrainProviderType | undefined, hasKey: boolean | undefined): boolean {
  return type === 'openai' && hasKey === true;
}

/** Final step — autopilot (planner/overseer for autonomous missions). Optional: everyday chat, tasks,
 *  memory and code intelligence all work without it, so this only offers to wire the relay and skips in a
 *  single keypress. The relay reuses the AI provider connected earlier; if that provider can't back it
 *  (not an openai-type endpoint with a key) there is nothing to ask, so it says so plainly and moves on.
 *  Enabling PUTs the exact same `autopilot` patch the AI step used to write inline. */
export async function runAutopilotStep(ctx: WizardCtx): Promise<StepResult> {
  p.note('Autopilot lets Elowen plan and oversee long autonomous missions on its own. Optional — everyday chat, tasks, memory and diagnostics all work without it.', 'Autopilot');

  const ai = ctx.answers.ai;
  if (ai?.status !== 'done' || !ai.providerId || !shouldWireAutopilot(ai.providerType, ai.hasKey)) {
    // No eligible provider means the relay simply cannot be configured here — don't pose a question that
    // can't be satisfied; the assistant is fully usable regardless.
    p.log.info('Autopilot needs an OpenAI-compatible provider with an API key, which isn\'t set up — add one later in Settings to enable it.');
    return skip(ctx);
  }

  const enable = guard(await p.confirm({
    message: 'Enable autopilot using the AI provider you just connected?',
    initialValue: false,
  }));
  if (!enable) return skip(ctx);

  const r = await apiJson(ctx, 'PUT', '/config', { autopilot: { providerId: ai.providerId, ...(ai.model ? { model: ai.model } : {}) } });
  if (!r.ok) { p.log.error(`Enabling autopilot failed (${r.status}) — you can set it up later in Settings.`); return skip(ctx); }

  p.log.success('Autopilot enabled — it will use this provider.');
  ctx.answers.autopilot = { status: 'done', summary: 'enabled' };
  return { status: 'done' };
}

function skip(ctx: WizardCtx): StepResult {
  ctx.answers.autopilot = { status: 'skipped', summary: 'not enabled' };
  return { status: 'skipped' };
}
