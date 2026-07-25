// Pure text/format helpers shared by every platform adapter (Discord / Telegram / WhatsApp), their
// streaming renderers and the tests. Genuinely per-surface pieces — the chunk size, the footer style, the
// reply-quote shape, Discord's mention resolution — stay in each plugin's own format.mjs; only the
// transport-neutral logic lives here. Every entry guards a null/undefined body (an empty daemon reply must
// never crash a send).

/** Flatten a markdown reply into plain prose for text-to-speech: drop code blocks, links, images and
 *  markdown punctuation so the voice reads the words, not the syntax. */
export function stripForSpeech(md) {
  return String(md ?? '')
    .replace(/```[\s\S]*?```/g, ' ')          // fenced code — unspeakable
    .replace(/`([^`]+)`/g, '$1')              // inline code → its text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')    // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')  // links → label
    .replace(/^#{1,6}\s+/gm, '')              // heading markers
    .replace(/https?:\/\/\S+/g, ' ')          // bare URLs
    .replace(/[*_>#~|`]+/g, ' ')              // leftover md punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

/** Find generated-image markdown links — `![…](…/brain/images/<name>.png)`, relative or absolute — and
 *  return the text with them removed plus the extracted file names. The name rule mirrors the daemon's
 *  GET /brain/images/:file validation (`[a-z0-9]+.png`), so path tricks never match. */
export function extractImageRefs(text) {
  const files = [];
  const cleaned = String(text ?? '').replace(/!\[[^\]]*\]\([^)\s]*\/brain\/images\/([a-z0-9]+\.png)\)/g, (_, name) => {
    files.push(name);
    return '';
  });
  return { cleaned, files };
}

/** Strip inline chain-of-thought (`<think>…</think>` / `<thinking>…</thinking>`) that some vision-fallback
 *  models emit into the text stream instead of a separate reasoning channel. Mirrors the daemon's
 *  `stripInlineReasoning` so an adapter's text-fallback path never leaks reasoning into the visible answer. */
export function stripThinking(text) {
  const s = String(text ?? '');
  if (!/<\/?think(?:ing)?\b/i.test(s)) return s;
  let out = s
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*$/i, '');
  const lead = /^[\s\S]*?<\/think(?:ing)?>/i.exec(out);
  if (lead) out = out.slice(lead[0].length);
  return out.trim();
}

/**
 * The runtime footer a turn settles with (`model · context %`), wrapped in the surface's own subtext
 * markup. `fence` is that markup: Discord `{ open: '-# ' }`, Telegram `{ open: '— ' }`, WhatsApp
 * `{ open: '_', close: '_' }`, Teams `{ open: '' }` (bot messages there have no small-text style at all).
 * The provider prefix is dropped (`anthropic/claude-sonnet-5` → the model name alone) and the percentage
 * rounded; missing data simply omits its fragment, and an idle event carrying neither yields '' so no
 * empty subtext line is posted. The percentage is checked for finiteness, not merely for being a number:
 * it reaches us from the agent runtime's context accounting, where a zero-sized window would divide out
 * to Infinity and print as `Infinity %`.
 */
export function runtimeFooter(idle, fence) {
  const parts = [];
  const model = typeof idle?.model === 'string' ? idle.model.split('/').pop() : '';
  if (model) parts.push(model);
  const pct = idle?.usage?.percent;
  if (Number.isFinite(pct) && pct >= 0) parts.push(`${Math.round(pct)} %`);
  return parts.length ? `${fence.open}${parts.join(' · ')}${fence.close ?? ''}` : '';
}

/**
 * Drop a trailing {@link runtimeFooter} from a message body — for feeding channel history back into a
 * prompt, where the footer is our own runtime metadata rather than anything a person said.
 *
 * Without this the model reads "messages in this thread end with `-# <model> · <n> %`" as part of the
 * house style and starts writing that line ITSELF, inventing a model name it never ran on. The forged
 * footer then lands in the next history window and reinforces the pattern.
 *
 * Matched structurally, not by pattern: the last non-blank line must open (and, where the surface closes
 * its markup, close) with the SAME fence we emit, and hold something between the two. So a bare `_` is
 * not mistaken for an empty WhatsApp footer. Caller-restricted to messages we authored — a person's own
 * subtext line is theirs to keep.
 */
export function stripRuntimeFooter(text, fence) {
  const body = String(text ?? '');
  // An unfenced surface (Teams) has nothing to recognise a footer BY: every line "starts with" the empty
  // string, so a reader there would eat the last line of every message it was handed. Refuse rather than
  // guess — a surface that wants its footer back off has to mark it on the way out first.
  if (!fence.open && !(fence.close ?? '')) return body;
  const lines = body.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') last--;
  if (last < 0) return body;
  const line = lines[last].trim();
  const close = fence.close ?? '';
  if (line.length <= fence.open.length + close.length) return body;
  if (!line.startsWith(fence.open)) return body;
  if (close && !line.endsWith(close)) return body;
  return lines.slice(0, last).join('\n').trimEnd();
}

/** Parse a picker exec (`elowen:<provider>/<model>`, `<provider>/<model>`, or bare model) into the brain's
 *  model selection shape. */
export function parseModelExec(spec) {
  const s = typeof spec === 'string' ? spec.trim().replace(/^elowen:/, '') : '';
  if (!s) return null;
  const slash = s.indexOf('/');
  return slash > 0 ? { provider: s.slice(0, slash), model: s.slice(slash + 1) } : { model: s };
}

/** Split text into ≤`chunk` pieces WITHOUT breaking a fenced code block: if a cut lands inside ``` … ```,
 *  close the fence on this piece and reopen it (same language) on the next. Prefers newline cuts. `chunk`
 *  is per-surface (Discord 1990, Telegram/WhatsApp 4000), so each adapter passes its own. */
export function splitContent(text, chunk) {
  const pieces = [];
  let rest = String(text ?? '');
  let reopen = '';
  while (rest.length > chunk) {
    let cut = rest.lastIndexOf('\n', chunk);
    if (cut < chunk * 0.5) cut = chunk; // no good newline → hard cut
    let piece = reopen + rest.slice(0, cut);
    rest = rest.slice(cut);
    // Count fences in this piece; an odd count means we're mid-block → close + remember to reopen.
    const fences = piece.match(/```/g)?.length ?? 0;
    if (fences % 2 === 1) {
      const lang = /```([^\n`]*)\n[^]*$/.exec(piece)?.[1] ?? '';
      piece += '\n```';
      reopen = '```' + lang + '\n';
    } else {
      reopen = '';
    }
    pieces.push(piece);
  }
  pieces.push(reopen + rest);
  return pieces;
}
