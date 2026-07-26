// Scripted OpenAI-compatible model for the continuity E2E suite.
//
// The shared brain-e2e model server drives exactly one tool round-trip per turn and cannot tell one
// turn from the next, which this scenario needs: propose a plan, read a file, write a file, summarise
// on demand, then answer plainly so the test can inspect the prompt that last turn was actually sent.
//
// Rather than sniffing each request to guess which step it is (PI's compaction request is just another
// chat completion), the TEST sets `setMode(...)` before each step. Every response is therefore chosen,
// not inferred — the suite then fails for real reasons, never because a heuristic misread a payload.

import { createServer } from 'node:http';

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

/** The file the scripted Read targets — filled in by the runner once its temp file exists. */
export const PATHS = { read: '' };

/** Enough prose that the conversation outgrows PI's keepRecentTokens window — the cut point that
 *  decides whether there is anything to summarise at all. Compaction is the whole subject of this
 *  suite, so a session too small to compact would make every assertion below vacuously pass. It has to
 *  be genuinely bulky: a few sentences per turn never reaches that bar. */
const FILLER = Array.from({ length: 400 },
  (_, i) => `Step ${i + 1}: the widget pipeline reads its input, validates the shape, applies the configured transform, and forwards the result downstream to the next stage for accounting.`).join(' ');

const MODES = {
  // A turn ending in a plan block, exactly as a real planning turn produces.
  plan: ({ say }) => say(
    'Here is how I would do it.\n\n<proposed_plan>\n# Ship the widget\n\n1. Wire the store\n2. Cover it with tests\n</proposed_plan>',
  ),
  read: ({ say, callTool, hasToolResult }) => (hasToolResult ? say(`Read it. ${FILLER}`) : callTool('Read', { path: PATHS.read })),
  // Bulk, so the conversation is actually worth compacting — PI refuses a session that is too small.
  filler: ({ say }) => say(FILLER),
  // PI's compaction request is just another completion; this is the summary it gets back.
  summary: ({ say }) => say('Summary: the user asked for a widget and work started on it.'),
  plain: ({ say }) => say('E2E-CONTINUITY-DONE.'),
};

/**
 * @returns {Promise<{ baseUrl: string, requests: object[], setMode: (m: string) => void, close: () => Promise<void> }>}
 */
export async function startScriptedModel() {
  const requests = [];
  let mode = 'plain';
  let toolCallSeq = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const body = await readJson(req);
    requests.push({ path: url.pathname, mode, body });

    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `unhandled ${req.method} ${url.pathname}` }));
      return;
    }

    const messages = Array.isArray(body?.messages) ? body.messages : [];
    // Whether THIS request is the follow-up to a tool call — i.e. the conversation ends in a tool result.
    // Deliberately not "does one exist anywhere": that stays true for the rest of the session once any
    // turn has used a tool, so a later tool turn would skip its own call and answer immediately.
    const hasToolResult = messages.at(-1)?.role === 'tool';

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    const base = { id: 'chatcmpl-continuity', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-model' };
    const delta = (d, finish = null) => frame({ ...base, choices: [{ index: 0, delta: d, finish_reason: finish }] });
    // Usage is derived from the REAL request size, not a constant. PI decides whether a session is even
    // worth compacting from its token accounting, so a model that always reports 120 tokens keeps the
    // context looking microscopic and every compaction is refused — the suite would then pass vacuously.
    const promptTokens = Math.max(50, Math.ceil(JSON.stringify(messages).length / 4));
    const usage = (completion = 40) => frame({
      ...base, choices: [],
      usage: { prompt_tokens: promptTokens, completion_tokens: completion, total_tokens: promptTokens + completion },
    });
    const say = (text) => {
      res.write(delta({ role: 'assistant', content: text }));
      res.write(delta({}, 'stop'));
      res.write(usage());
    };
    const callTool = (name, args) => {
      toolCallSeq += 1;
      res.write(delta({ role: 'assistant', content: `Calling ${name}. ` }));
      res.write(delta({ tool_calls: [{ index: 0, id: `call_${toolCallSeq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }));
      res.write(delta({}, 'tool_calls'));
      res.write(usage());
    };

    const respond = MODES[mode];
    if (typeof respond === 'function') respond({ say, callTool, hasToolResult });
    else say(`Nothing scripted for mode "${mode}".`);

    res.write('data: [DONE]\n\n');
    res.end();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    setMode: (m) => { mode = m; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
