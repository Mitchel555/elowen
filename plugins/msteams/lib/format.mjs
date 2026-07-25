// Teams-flavoured formatting: shared splitting/reply-context helpers sized for Teams message limits.
import { splitContent as splitAtChunk, parseModelExec, runtimeFooter } from '../../_shared/format.mjs';

export { parseModelExec };

/** Teams caps a message payload around 28KB; markdown text well under that keeps every client happy. */
export const CHUNK = 20000;

/** Split a Teams reply into ≤CHUNK pieces without breaking a fenced code block (shared core + our size). */
export const splitContent = (text) => splitAtChunk(text, CHUNK);

/** The quoted-original context line a reply carries into the shared conversation. */
export function buildReplyContext(name, body) {
  const quoted = String(body ?? '').replace(/\s+/g, ' ').trim();
  if (!quoted) return '';
  const clipped = quoted.length > 280 ? `${quoted.slice(0, 279)}…` : quoted;
  return `[In reply to ${name}: "${clipped}"]`;
}

/** The markup Teams' runtime footer is wrapped in — none. Bot messages there have no small-text style
 *  (`stream.mjs` renders every subtext plain for the same reason), so the footer rides as an ordinary
 *  line. Named and passed like every other surface's fence so the footer itself stays one shared shape. */
const FOOTER_FENCE = { open: '' };

/** The runtime footer under a final reply: `model · context %` from the idle event, or ''. */
export const footerLine = (idle) => runtimeFooter(idle, FOOTER_FENCE);
