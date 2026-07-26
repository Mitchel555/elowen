#!/usr/bin/env node
// Stop-escalation E2E against a REAL built daemon: POST /brain/commands/kill must SIGKILL the WHOLE
// process tree of a running foreground Bash command and settle the tool as [killed].
//
// Proves the real wiring end to end: the scripted model emits a Bash tool call running a long,
// uniquely-marked command with a real parent/child pair (`sh -c 'sleep 300' <marker>` under the tool's
// own shell). The test waits for the processes to actually exist (polled with a hard deadline, no bare
// sleeps), fires the kill route with the session binding, and asserts that (1) every pid in the tree is
// gone — the group kill, not a single-pid kill —, (2) the tool result the model receives on the
// follow-up request reads as [killed], and (3) the turn still reaches idle (the loop unwinds instead of
// waiting the command out). A second kill returns { killed: 0 } — the escalation is idempotent.
// Run with: npm run test:e2e:stop-kill

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { startModelServer } from './model-server.mjs';
import { spawnRealDaemon } from './spawn-daemon.mjs';

const MARKER = `e2e-stop-kill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
// A real parent/child pair: the Bash tool's shell runs `sh` (cmdline carries the marker), which runs
// `sleep` as its own child — killing only the direct pid would leave the sleep alive.
const COMMAND = `sh -c 'sleep 300' ${MARKER}`;
const FINAL_MARKER = 'E2E-STOP-KILL-DONE';

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `probe` until it returns a truthy value or the hard deadline elapses. Never a bare sleep. */
async function waitFor(label, probe, timeoutMs, stepMs = 100) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
    await sleep(stepMs);
  }
}

function pidsMatching(marker) {
  try {
    return execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number);
  } catch { return []; } // pgrep exits 1 on no match
}

function childrenOf(pid) {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number);
  } catch { return []; }
}

/** The marker pids plus every transitive child — the tree the group kill must take down. */
function processTree(marker) {
  const seen = new Set(pidsMatching(marker));
  const queue = [...seen];
  while (queue.length > 0) {
    for (const child of childrenOf(queue.shift())) {
      if (!seen.has(child)) { seen.add(child); queue.push(child); }
    }
  }
  return [...seen];
}

function commOf(pid) {
  try { return readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return null; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Open a real SSE stream and expose the parsed brain events plus a deadline-bounded waitFor. */
async function openStream(baseUrl, path, token) {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) throw new Error(`stream open failed: HTTP ${res.status}`);
  const events = [];
  (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          let dataLine = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('data:')) dataLine += line.slice(5).trim();
          }
          if (!dataLine) continue;
          try { events.push(JSON.parse(dataLine)); } catch { /* non-JSON frame */ }
        }
      }
    } catch { /* stream aborted on close */ }
  })();
  return {
    events,
    waitFor(predicate, timeoutMs, label) {
      return waitFor(label, () => predicate(events), timeoutMs)
        .catch((e) => { throw new Error(`${e.message}\nevents so far: ${events.map((ev) => ev.type).join(', ')}`); });
    },
    close() { controller.abort(); },
  };
}

async function post(baseUrl, path, token, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  return { status: res.status, json, text };
}

async function main() {
  const model = await startModelServer({
    toolName: 'Bash',
    toolArgs: JSON.stringify({ command: COMMAND }),
    firstText: 'Starting the long command. ',
    finalText: `${FINAL_MARKER}: the command was killed.`,
  });
  let daemon = null;
  try {
    daemon = await spawnRealDaemon({ providerBaseUrl: model.baseUrl });
    const { baseUrl, token } = daemon;
    console.log(`daemon up on ${baseUrl}; model server on ${model.baseUrl}; marker ${MARKER}`);

    // 1) Fresh conversation, YOLO on (the built-in `bash * -> ask` rule would otherwise park the Bash
    //    call on an approval prompt instead of running it).
    const start = await post(baseUrl, '/brain/start', token, { fresh: true });
    assert(start.status === 201, `POST /brain/start → 201 (got ${start.status}: ${start.text})`);
    const sessionId = start.json?.sessionId;
    assert(typeof sessionId === 'string' && sessionId, 'start returned a sessionId');
    const yolo = await post(baseUrl, '/brain/yolo', token, { on: true, session: sessionId });
    assert(yolo.status === 200, `POST /brain/yolo → 200 (got ${yolo.status}: ${yolo.text})`);

    // 2) Stream open BEFORE the send so no event is missed.
    const stream = await openStream(baseUrl, `/brain/stream?session=${encodeURIComponent(sessionId)}`, token);
    await sleep(200); // let the session tap attach before the send (as in chat-turn.mjs)

    // 3) Send → the model orders the marked long command.
    const send = await post(baseUrl, '/brain/send', token, { text: 'Run the long job.', session: sessionId, mode: 'build' });
    assert(send.status === 202, `POST /brain/send → 202 (got ${send.status}: ${send.text})`);
    await stream.waitFor((evs) => evs.some((e) => e.type === 'tool' && e.name === 'Bash'), 30_000, 'Bash tool event');

    // 4) The process tree actually exists: the marked sh AND its sleep child (a real parent/child pair).
    const tree = await waitFor('the marked process tree (sh + sleep child)', () => {
      const pids = processTree(MARKER);
      return pids.length >= 2 && pids.some((pid) => commOf(pid) === 'sleep') ? pids : null;
    }, 30_000);
    console.log(`process tree up: ${tree.map((pid) => `${pid}(${commOf(pid) ?? '?'})`).join(' ')}`);

    // 5) The escalation: kill the session's foreground command(s).
    const kill = await post(baseUrl, '/brain/commands/kill', token, { session: sessionId });
    assert(kill.status === 200, `POST /brain/commands/kill → 200 (got ${kill.status}: ${kill.text})`);
    assert(kill.json?.killed === 1, `kill reported exactly one command (got ${kill.text})`);

    // 6) The WHOLE tree is gone — group kill, not a single-pid kill.
    await waitFor('every pid in the tree to die', () =>
      (tree.every((pid) => !alive(pid)) && pidsMatching(MARKER).length === 0) || null, 10_000);
    console.log('PASS tree: every process in the group is dead (parent AND child).');

    // 7) The turn unwinds: the tool settles as [killed], the model answers the follow-up, idle arrives.
    await stream.waitFor((evs) => evs.some((e) => e.type === 'idle'), 45_000, 'idle after the kill');
    const followUp = model.requests.find((req) =>
      Array.isArray(req?.body?.messages) && req.body.messages.some((m) => m.role === 'tool'));
    assert(followUp, 'the model received a follow-up request carrying the tool result');
    const toolMsg = followUp.body.messages.find((m) => m.role === 'tool');
    assert(JSON.stringify(toolMsg.content).includes('[killed]'),
      `the tool result the model received reads as [killed] (got: ${JSON.stringify(toolMsg.content).slice(0, 300)})`);
    console.log('PASS result: the model-facing tool result reads as [killed] and the turn reached idle.');

    // 8) TEETH: a second escalation finds nothing left to kill — the entry settled and was collected.
    const again = await post(baseUrl, '/brain/commands/kill', token, { session: sessionId });
    assert(again.status === 200 && again.json?.killed === 0, `repeat kill is a no-op (got ${again.text})`);
    console.log('PASS teeth: a repeated kill is idempotent ({ killed: 0 }).');

    stream.close();
  } finally {
    if (daemon) await daemon.stop();
    await model.close();
  }
}

main().then(() => {
  console.log('PASS test:e2e:stop-kill — a real foreground command tree was killed and the turn unwound.');
  process.exit(0);
}).catch((err) => {
  console.error(`FAIL test:e2e:stop-kill — ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
});
