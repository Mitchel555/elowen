import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { currentSessionId, currentTurnMode } from '../../plugins/policyContext.js';
import { readPlan } from '../continuity/planStore.js';
import { planFilePath } from '../../shared/paths.js';

/** The name the model sees. Matches Claude Code exactly, on purpose: the models being driven here have
 *  seen this tool under this name, and a private spelling would throw away that familiarity for nothing. */
export const EXIT_PLAN_MODE_TOOL = 'ExitPlanMode';

/** Refusal when the tool is called outside plan mode. Adapted from the reference's validateInput text,
 *  which already answers the question the model asks next ("was my plan approved earlier?"). */
const NOT_IN_PLAN_MODE = 'You are not in plan mode. This tool is only for exiting plan mode after writing a plan. '
  + 'If your plan was already approved, continue with implementation.';

const toolText = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} });

/** Present the finished plan for the user's decision — the explicit end of a planning turn.
 *
 *  This replaces sniffing the model's prose for a `<proposed_plan>` tag. A tag in streamed text cannot be
 *  told apart from the model merely QUOTING the tag while discussing it, which is how a conversation about
 *  plan mode used to raise a plan panel; a tool call is unambiguous by construction.
 *
 *  The plan is NOT a parameter. The model writes it to the session's plan file (the only path plan mode
 *  lets it write) and this tool reads it back from disk, so one document is the single source of truth for
 *  the model, the approval UI, the post-compaction re-injection and the user's own editor. */
export function buildExitPlanModeTool() {
  return defineTool({
    name: EXIT_PLAN_MODE_TOOL,
    label: 'Submit plan',
    description: 'Prompts the user to exit plan mode and start coding. Call this only after you have written your plan to the plan file named in the plan mode instructions — the plan is read from that file, not passed here.',
    parameters: Type.Object({}),
    execute: async () => {
      // Mode first. Outside plan mode there is nothing to exit, and reading a stale plan file would let a
      // build turn resurrect an old plan as though it were fresh.
      if (currentTurnMode() !== 'plan') return toolText(NOT_IN_PLAN_MODE);
      const sessionId = currentSessionId();
      if (!sessionId) return toolText(NOT_IN_PLAN_MODE);

      const plan = readPlan(sessionId);
      // An empty or missing file means the model reached for the tool before writing anything. Say where
      // the file is rather than just refusing, so the next attempt can succeed without guessing.
      if (!plan) {
        return toolText(`No plan has been written yet. Write your plan to ${planFilePath(process.env, sessionId)} first, then call ${EXIT_PLAN_MODE_TOOL} again.`);
      }
      // The turn ENDS here. The user's decision is taken after it settles, so the model must not read this
      // as permission to start — an approval it has not been given yet.
      return toolText('Your plan has been submitted for the user to review.\n\n'
        + 'Stop here and wait for their decision. Do NOT begin implementing, and do not ask whether the plan '
        + 'is acceptable — submitting it already asked. If they approve it, you will be told so and may then '
        + 'start; the plan stays on disk so you can re-read it while you work.');
    },
  });
}
