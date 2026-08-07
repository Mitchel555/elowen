#!/usr/bin/env node
// Sub-agent PARITY fingerprint — what does a delegated child actually receive?
//
// Boots a real daemon against a scripted model, delegates one task, and captures the child's FIRST
// request exactly as it went on the wire: the system prompt, the ordered tool names, and the request
// shape. That fingerprint is the thing a refactor must not change.
//
// Why it exists: moving sub-agent execution into a forked runner means the same session is constructed
// by a second code path. The system prompt is the prompt-cache key, so a single byte of drift silently
// re-bills the whole prefix at full price — and the tool list is what the model can actually do. Neither
// failure produces an error; both are invisible without a byte-for-byte comparison. A unit test cannot
// catch this, because the thing being compared is the OUTPUT of the entire wiring.
//
// Usage:
//   node scripts/tests/subagent-parity/run.mjs --save <file>    capture a fingerprint
//   node scripts/tests/subagent-parity/run.mjs --check <file>   capture and diff against one
//
// Volatile values (temp paths, dates, session ids, ports) are normalised, so two runs of the SAME code
// produce identical fingerprints and anything left over is real drift.

import { createServer } from 'node:http';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawnRealDaemon } from '../brain-e2e/spawn-daemon.mjs';

const TASK_MARKER = 'PARITY-TASK-4c8e1';
const SUBAGENT_PROMPT = 'You are a focused sub-agent';
const TURN_DEADLINE_MS = 120_000;

const args = process.argv.slice(2);
const mode = args[0] === '--check' ? 'check' : 'save';
const file = args[1] ?? 'scripts/tests/subagent-parity/baseline.json';
// Run the SAME check with delegated turns executing in the forked sub-agent runner. The fingerprint must
// not move: the runner composes the child's session through the same builder, and the system prompt is
// the prompt-cache key — one byte of drift re-bills every delegated turn at full price.
const useRunner = process.env.ELOWEN_SUBAGENT_RUNNER === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const contentText = (m) => {
  const c = m?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join(' ');
  return '';
};

/** Replace everything that legitimately differs between two runs, so what remains is real drift. */
function normalise(text, dataDir) {
  return text
    .split(dataDir).join('<DATADIR>')
    .replace(/brain-ch-subagent-sub-dlg-[0-9a-f-]+/g, '<CHILD-SESSION>')
    .replace(/brain-\d+-[0-9a-z]+/g, '<SESSION>')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<DATE>')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '<TIME>')
    .replace(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/g, '<WEEKDAY>')
    .replace(/\b\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\b/g, '<LONGDATE>')
    // The runtime-context plugin names the daypart (see its DAYPARTS table), so a fingerprint taken in
    // the morning would not match one taken after lunch — a false alarm that would teach us to ignore
    // this check, which is the one failure mode a parity harness must never have.
    .replace(/\b(?:early morning|morning|midday|afternoon|evening|night)\b/g, '<DAYPART>')
    .replace(/127\.0\.0\.1:\d+/g, '<HOST>')
    .replace(/\bdlg-[0-9a-f-]+/g, '<JOB>');
}

/** Scripted OpenAI-compatible model, streaming (the daemon drives SSE, exactly as the other E2E suites
 *  script it). The parent delegates once; the child answers once. The child's first request is recorded
 *  verbatim before anything is answered. */
function startModel(onChildRequest) {
  let captured = false;
  let seq = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* housekeeping pings */ }
      if (req.method !== 'POST' || !String(req.url).includes('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `unhandled ${req.method} ${req.url}` }));
        return;
      }
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const allText = messages.map(contentText).join('\n');
      const isChild = allText.includes(SUBAGENT_PROMPT);
      if (isChild && !captured) { captured = true; onChildRequest(body); }

      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
      const base = { id: 'chatcmpl-parity', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-model' };
      const frame = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      const delta = (d, finish = null) => frame({ ...base, choices: [{ index: 0, delta: d, finish_reason: finish }] });
      const usage = () => frame({ ...base, choices: [], usage: { prompt_tokens: 120, completion_tokens: 18, total_tokens: 138 } });
      const say = (text) => { delta({ role: 'assistant', content: text }); delta({}, 'stop'); usage(); };
      const callTool = (name, argsObj) => {
        seq += 1;
        delta({ role: 'assistant', content: `Calling ${name}. ` });
        delta({ tool_calls: [{ index: 0, id: `call_${seq}`, type: 'function', function: { name, arguments: JSON.stringify(argsObj) } }] });
        delta({}, 'tool_calls');
        usage();
      };

      if (isChild) say('child done');
      // A toolless completion is housekeeping (conversation titling), never an agent turn.
      else if (!Array.isArray(body?.tools) || body.tools.length === 0) say('Parity run');
      else if (messages.at(-1)?.role === 'tool') say('parent done');
      else callTool('Delegate', { task: `${TASK_MARKER} — answer with anything` });

      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) }));
  });
}

/** Count `idle` events so a send can be awaited to settlement (POST /brain/send returns on admission). */
async function watchIdle(baseUrl, token, session) {
  const res = await fetch(`${baseUrl}/brain/stream?session=${encodeURIComponent(session)}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
  });
  const reader = res.body.getReader();
  const state = { idle: 0 };
  (async () => {
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) if (line.includes('"idle"')) state.idle += 1;
      }
    } catch { /* torn down with the daemon */ }
  })();
  state.stop = () => reader.cancel().catch(() => {});
  return state;
}

async function main() {
  let childBody = null;
  const model = await startModel((body) => { childBody = body; });
  const daemon = await spawnRealDaemon({ providerBaseUrl: `http://127.0.0.1:${model.port}/v1` });
  try {
    const api = async (path, body) => {
      const res = await fetch(`${daemon.baseUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
      return res.json();
    };

    if (useRunner) {
      // The operator's own switch, set the way an operator would — no test-only back door.
      const res = await fetch(`${daemon.baseUrl}/config`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ runtime: { subagentRunnerEnabled: true } }),
      });
      if (!res.ok) throw new Error(`enabling the sub-agent runner failed: ${res.status} ${await res.text()}`);
      console.log('sub-agent runner: ON (delegated turns execute in a forked process)');
    } else {
      console.log('sub-agent runner: OFF (delegated turns execute in-process)');
    }

    const start = await api('/brain/start', { fresh: true });
    const session = start.sessionId;
    const idle = await watchIdle(daemon.baseUrl, daemon.token, session);
    const before = idle.idle;
    await api('/brain/send', { text: 'delegate one task please', session, mode: 'build' });
    const until = Date.now() + TURN_DEADLINE_MS;
    while (idle.idle === before && Date.now() < until) await sleep(200);
    idle.stop();
    if (!childBody) throw new Error('no delegated child request was captured — the parent never delegated');

    // The dispatcher falls back to in-process when the runner cannot START, which would turn this whole
    // check into a green run of the code it is meant to be testing. Prove the fork really served the turn.
    if (useRunner) {
      const log = daemon.logText();
      if (!log.includes('sub-agent runner ready')) throw new Error('the sub-agent runner never came up — this run proves nothing');
      if (log.includes('running this delegated turn in-process')) throw new Error('the dispatcher fell back in-process — this run proves nothing');
      console.log('  (verified: the delegated turn was served by the forked runner)');
    }

    const systemMessages = (childBody.messages ?? []).filter((m) => m?.role === 'system');
    const fingerprint = {
      systemPrompt: normalise(systemMessages.map(contentText).join('\n---\n'), daemon.dataDir),
      systemMessageCount: systemMessages.length,
      toolNames: (childBody.tools ?? []).map((t) => t?.function?.name ?? t?.name).sort(),
      toolCount: (childBody.tools ?? []).length,
      firstUserMessage: normalise(contentText((childBody.messages ?? []).find((m) => m?.role === 'user')), daemon.dataDir),
      requestKeys: Object.keys(childBody).sort(),
    };

    if (mode === 'save') {
      writeFileSync(file, `${JSON.stringify(fingerprint, null, 2)}\n`);
      console.log(`saved fingerprint → ${file}`);
      console.log(`  system prompt: ${fingerprint.systemPrompt.length} chars in ${fingerprint.systemMessageCount} message(s)`);
      console.log(`  tools (${fingerprint.toolCount}): ${fingerprint.toolNames.join(', ')}`);
      return 0;
    }

    if (!existsSync(file)) throw new Error(`no baseline at ${file} — run with --save first`);
    const baseline = JSON.parse(readFileSync(file, 'utf-8'));
    const diffs = [];
    if (baseline.systemPrompt !== fingerprint.systemPrompt) {
      let at = 0;
      while (at < baseline.systemPrompt.length && baseline.systemPrompt[at] === fingerprint.systemPrompt[at]) at += 1;
      diffs.push(`system prompt differs at char ${at} (baseline ${baseline.systemPrompt.length} chars, now ${fingerprint.systemPrompt.length})`
        + `\n      baseline: ${JSON.stringify(baseline.systemPrompt.slice(Math.max(0, at - 50), at + 70))}`
        + `\n      now:      ${JSON.stringify(fingerprint.systemPrompt.slice(Math.max(0, at - 50), at + 70))}`);
    }
    const added = fingerprint.toolNames.filter((t) => !baseline.toolNames.includes(t));
    const removed = baseline.toolNames.filter((t) => !fingerprint.toolNames.includes(t));
    if (added.length) diffs.push(`tools ADDED: ${added.join(', ')}`);
    if (removed.length) diffs.push(`tools REMOVED: ${removed.join(', ')}`);
    if (baseline.firstUserMessage !== fingerprint.firstUserMessage) diffs.push('first user message differs');
    if (baseline.requestKeys.join() !== fingerprint.requestKeys.join()) diffs.push(`request keys differ: ${baseline.requestKeys.join()} → ${fingerprint.requestKeys.join()}`);

    if (diffs.length === 0) {
      console.log(`PASS — the delegated child still receives a byte-identical prompt and the same ${fingerprint.toolCount} tools`);
      return 0;
    }
    console.log('FAIL — the delegated child no longer receives what it did:');
    for (const d of diffs) console.log(`  • ${d}`);
    return 1;
  } finally {
    await daemon.stop();
    await model.close();
  }
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
