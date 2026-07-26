// Scripted OpenAI-compatible model for the plugin-hook E2E suite.
//
// One shape of turn is all this scenario needs: read the file the test points at, then answer. What is
// being tested is not the model's behaviour but what the HOST does between the model asking for a tool
// and the tool running — so the model stays deliberately dumb and predictable, and every assertion is
// made against the traffic it recorded.

import { createServer } from 'node:http';

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

/**
 * @returns {Promise<{ baseUrl: string, requests: object[], setTarget: (p: string) => void, close: () => Promise<void> }>}
 */
export async function startScriptedModel() {
  const requests = [];
  let target = '';
  let toolCallSeq = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const body = await readJson(req);
    requests.push({ path: url.pathname, target, body });

    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `unhandled ${req.method} ${url.pathname}` }));
      return;
    }

    const messages = Array.isArray(body?.messages) ? body.messages : [];
    // Is THIS request the follow-up to a tool call, i.e. does the conversation END in a tool result?
    // Asking whether one exists ANYWHERE is the subtle version of this that looks right and is not: once
    // any turn has used a tool, every later turn would answer "yes" on its first request and skip
    // straight to the reply — the suite would then assert against tool calls that never happened.
    const hasToolResult = messages.at(-1)?.role === 'tool';

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    const base = { id: 'chatcmpl-hooks', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-model' };
    const delta = (d, finish = null) => frame({ ...base, choices: [{ index: 0, delta: d, finish_reason: finish }] });
    const usage = () => frame({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });

    if (hasToolResult) {
      res.write(delta({ role: 'assistant', content: 'E2E-HOOKS-TURN-DONE.' }));
      res.write(delta({}, 'stop'));
      res.write(usage());
    } else {
      toolCallSeq += 1;
      res.write(delta({ role: 'assistant', content: 'Reading it. ' }));
      res.write(delta({ tool_calls: [{ index: 0, id: `call_${toolCallSeq}`, type: 'function', function: { name: 'Read', arguments: JSON.stringify({ path: target }) } }] }));
      res.write(delta({}, 'tool_calls'));
      res.write(usage());
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
    requests,
    setTarget: (p) => { target = p; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
