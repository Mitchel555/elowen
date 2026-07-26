/** The name the model sees for the plan-mode exit tool. Matches Claude Code exactly, on purpose: the
 *  models driven here have seen this tool under this name, and a private spelling would throw that
 *  familiarity away for nothing.
 *
 *  It lives in `shared` rather than beside the tool because it is shared VOCABULARY, not behaviour: the
 *  transcript view keys on it to recognise a submitted plan, and the plan-mode tool policy keys on it to
 *  admit the tool. Importing it from the tool module made both of those reach into `brain/tools`, which
 *  closed a dependency cycle through messageView. A leaf constant has no such pull. */
export const EXIT_PLAN_MODE_TOOL = 'ExitPlanMode';
