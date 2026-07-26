/** The block a planning turn ends with, per `prompts/cli/plan-mode.md`. Two consumers read it: the
 *  daemon captures the plan so a later compaction cannot destroy it, and the CLI renders it as a framed
 *  panel. They must agree on the shape forever, so the source lives here once.
 *
 *  A FACTORY, not a shared instance: a `/g/` regex carries `lastIndex` between uses, so one exported
 *  object would have the CLI's render loop and the daemon's extractor silently corrupt each other's
 *  scan position. */
const BLOCK_SOURCE = String.raw`<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>`;

/** Fresh global matcher for complete blocks — for iterating every block in a text. */
export function proposedPlanMatcher(): RegExp {
  return new RegExp(BLOCK_SOURCE, 'gi');
}

/** Fresh matcher for a BARE opening tag, i.e. a block still being streamed. The CLI uses it to start
 *  framing a plan before its closing tag arrives; capture deliberately ignores such a block, because a
 *  half-written plan is worse than none. */
export function proposedPlanOpenMatcher(): RegExp {
  return /<proposed_plan>\s*/i;
}

/** The plan a turn proposed, or null when it proposed none.
 *
 *  The LAST complete block wins: a turn that revises its plan mid-answer means the later one, and an
 *  unterminated trailing block is ignored — it is a truncated or still-streaming plan, and storing half
 *  a plan would put a document into the next prompt that reads as complete but is not. */
export function extractProposedPlan(text: string): string | null {
  const matcher = proposedPlanMatcher();
  let found: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text))) {
    const body = (match[1] ?? '').trim();
    if (body) found = body;
  }
  return found;
}
