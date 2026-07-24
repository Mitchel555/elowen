// WhatsApp text/format helpers. The transport-neutral pieces (extractImageRefs, stripThinking,
// parseModelExec, the fenced-split core) live in ../../_shared/format.mjs; only WhatsApp's own chunk size,
// reply-quote and footer stay here.
import { splitContent as splitAtChunk, extractImageRefs, stripThinking, parseModelExec, runtimeFooter } from '../../_shared/format.mjs';
export { extractImageRefs, stripThinking, parseModelExec };

export const CHUNK = 4000;            // split long replies into readable pieces
const REPLY_EXCERPT = 300;               // quoted-reply excerpt length

/** Split a WhatsApp reply into ≤CHUNK pieces without breaking a fenced code block (shared core + our size). */
export const splitContent = (text) => splitAtChunk(text, CHUNK);

/** Quote context for a reply: who is being answered + a capped excerpt of what they said. */
export function buildReplyContext(name, body) {
  const content = String(body ?? '').trim();
  if (!content) return '';
  const excerpt = content.length > REPLY_EXCERPT ? `${content.slice(0, REPLY_EXCERPT)}…` : content;
  return `[Replying to ${name || 'someone'}: "${excerpt}"]`;
}

/** The italic markup WhatsApp's runtime footer is wrapped in — consumed by `footerLine` here and by
 *  `stripRuntimeFooter` should this surface ever read its channel history back into a prompt. */
const FOOTER_FENCE = { open: '_', close: '_' };

/** Runtime footer: `model · 42 %`. Empty when the idle event carried no usable data. */
export const footerLine = (idle) => runtimeFooter(idle, FOOTER_FENCE);

