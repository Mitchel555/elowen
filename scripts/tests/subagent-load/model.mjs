// Scripted OpenAI-compatible model for the delegated-fan-out LOAD harness.
//
// Unlike the correctness suites next door, this one exists to generate a controlled amount of WORK — a
// known number of concurrent children, a known number of tool calls each, and a known tool-result size —
// so the daemon's event loop, its SQLite writes and its CPU can be attributed afterwards.
//
// Three kinds of completion, chosen the same way subagent-e2e/model.mjs chooses them:
//   1. PARENT turns follow the mode the runner sets (bloat / fanout / idle). Nothing is inferred.
//   2. CHILD turns are recognised by CONTENT (the host's sub-agent system prompt). A child issues
//      `toolCallsPerChild` Read calls against a fixture file of the configured size, then answers.
//   3. Toolless completions (conversation titling) are answered as plain text so a background inference
//      is never mistaken for an agent turn.
//
// Reported USAGE is deliberately small and constant: this harness must never trip auto-compaction, or
// the transcript size it manipulates as an independent variable would be silently reset mid-run. Stored
// transcript BYTES are the variable under test, not model tokens.

import { createServer } from 'node:http';

export const SUBAGENT_PROMPT = 'You are a focused sub-agent';

export const MARKERS = {
  task: 'LOAD-TASK',
  childDone: 'CHILD-DONE',
  parentFanoutDone: 'PARENT-FANOUT-DONE',
  bloatDone: 'PARENT-BLOAT-DONE',
};

export function contentText(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((part) => (typeof part?.text === 'string' ? part.text : '')).join(' ');
  return '';
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} opts
 * @param {number} opts.delegations         concurrent background delegations one fanout turn launches
 * @param {number} opts.toolCallsPerChild   Read calls each child makes before answering
 * @param {number} opts.bloatToolCalls      Read calls one `bloat` parent turn makes
 * @param {number} opts.latencyMs           artificial per-response provider latency
 *
 * The fixture path is set later, with `setFixture`: it lives inside the daemon's data dir, which does not
 * exist until the daemon has been spawned — and the daemon cannot be spawned before this server has a URL.
 */
export async function startScriptedModel(opts) {
  const { delegations, toolCallsPerChild, bloatToolCalls, latencyMs } = opts;

  let mode = 'idle';
  let fixturePath = opts.fixturePath ?? '';
  /** Counters the runner polls instead of reading the daemon's database — a harness that opened the
   *  scratch DB while measuring lock contention would be adding a reader to the thing it is measuring. */
  const counts = { childTurns: 0, childrenDone: 0, parentTurns: 0, completions: 0 };
  let toolCallSeq = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const body = await readJson(req);
    counts.completions += 1;

    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `unhandled ${req.method} ${url.pathname}` }));
      return;
    }

    if (latencyMs > 0) await sleep(latencyMs);

    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const allText = messages.map(contentText).join('\n');
    // Tool results of THIS TURN only. Counting the whole array would make every turn after the first see
    // the previous turns' results and stop immediately — which silently capped the parent transcript at
    // one turn's worth of growth and made the "large live session" cell a no-op.
    let turnStart = 0;
    for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]?.role === 'user') { turnStart = i; break; }
    const turn = messages.slice(turnStart);
    const toolResults = turn.filter((m) => m?.role === 'tool').length;

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    const base = { id: 'chatcmpl-load', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-model' };
    const delta = (d, finish = null) => frame({ ...base, choices: [{ index: 0, delta: d, finish_reason: finish }] });
    const usage = () => frame({ ...base, choices: [], usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 } });
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
    const readFixture = () => callTool('Read', { path: fixturePath });

    if (allText.includes(SUBAGENT_PROMPT)) {
      // A CHILD. Burn `toolCallsPerChild` tool results into its transcript, then finish.
      counts.childTurns += 1;
      if (toolResults < toolCallsPerChild) readFixture();
      else { counts.childrenDone += 1; say(`Handled it. ${MARKERS.childDone}`); }
    } else if (!Array.isArray(body?.tools) || body.tools.length === 0) {
      say('Load harness conversation');
    } else if (mode === 'bloat') {
      counts.parentTurns += 1;
      if (toolResults < bloatToolCalls) readFixture();
      else say(`Warm-up complete. ${MARKERS.bloatDone}`);
    } else if (mode === 'fanout') {
      counts.parentTurns += 1;
      // Background delegations return immediately, so ONE parent turn puts `delegations` children in
      // flight at once — which is exactly the shape of the incident.
      const launched = turn.filter((m) => m?.role === 'tool' && contentText(m).includes('Started background delegation')).length;
      if (launched < delegations) {
        callTool('Delegate', {
          task: `${MARKERS.task}-${launched + 1}: inspect the fixture and report. Read ${fixturePath} as many times as needed.`,
          background: true,
        });
      } else say(`Launched ${delegations} sub-agents. ${MARKERS.parentFanoutDone}`);
    } else {
      say('Nothing to do.');
    }

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
    counts,
    setMode: (m) => { mode = m; },
    setFixture: (p) => { fixturePath = p; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
