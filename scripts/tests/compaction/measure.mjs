#!/usr/bin/env node
// MEASURE what actually occupies the context right after a PI auto-compaction in a REAL Elowen session.
//
// The compaction percentage Elowen hands to PI becomes reserveTokens = contextWindow * (1 - pct/100),
// and PI uses that SAME reserve as the summary-output budget while keeping `keepRecentTokens` of recent
// messages (PI's default 20000 — Elowen never sets it). This harness answers, with real numbers: what
// does the post-compaction context consist of (system prompt / tool definitions / summary / kept recent
// messages), and does the floor alone sit above the trigger threshold?
//
// It boots a REAL daemon against a scripted model (same pattern as subagent-parity), pins the model's
// context window to 200k, sets the owner's auto-compact to 40%, grows the session past the 80k trigger
// with plain-text turns, lets PI auto-compact at the between-turn boundary, then captures the NEXT
// provider request and splits it into the four parts. Then it sends another turn and checks whether a
// SECOND compaction fires — the thrash symptom of an unreachable threshold.
//
// Usage: node scripts/tests/compaction/measure.mjs [--pct=40] [--window=200000] [--summaryChars=4000]
//
// SAFETY: scratch port, scratch data dir, scratch database. Never touches 4400/4500, the production
// database, or systemd.

import { createServer } from 'node:http';
import { spawnRealDaemon } from '../brain-e2e/spawn-daemon.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v = 'true'] = a.replace(/^--/, '').split('=');
  return [k, v];
}));
const PCT = Number(args.pct ?? 40);
const WINDOW = Number(args.window ?? 200_000);
const SUMMARY_CHARS = Number(args.summaryChars ?? 4_000);
/** Each turn adds one user message of this size; at chars/4 that is ~TURN_CHARS/4 tokens per turn. */
const TURN_CHARS = 28_000;
const TURN_DEADLINE_MS = 60_000;
const THRASH_WAIT_MS = 15_000;
const MAX_TURNS = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── token accounting ────────────────────────────────────────────────────────────────────────────────
// chars/4 heuristic — the same estimate PI uses (estimateTokens) and the closest stand-in for the
// provider-reported token count, so the parts reconcile with the usage numbers that drive shouldCompact.
const textChars = (content) => {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((n, b) => {
      if (b.type === 'text' && b.text) n += b.text.length;
      else if (b.type === 'toolCall' && b.arguments) n += b.name.length + JSON.stringify(b.arguments).length;
      return n;
    }, 0);
  }
  return 0;
};
const tokens = (chars) => Math.ceil(chars / 4);
const msgText = (m) => {
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b.type === 'text' && b.text ? b.text : '')).join('');
  return '';
};
const msgChars = (m) => (m.role === 'assistant'
  ? textChars(m.content) + (Array.isArray(m.tool_calls) ? m.tool_calls.reduce((n, tc) => n + tc.function.name.length + tc.function.arguments.length, 0) : 0)
  : textChars(m.content));

const COMPACTION_PREFIX = 'The conversation history before this point was compacted into the following summary:';

/** Split one wire request into the four post-compaction parts, in the heuristic both sides share. */
function splitRequest(body) {
  const system = (body.messages ?? []).filter((m) => m.role === 'system');
  const rest = (body.messages ?? []).filter((m) => m.role !== 'system');
  const systemChars = system.reduce((n, m) => n + textChars(m.content), 0);
  const toolsChars = Array.isArray(body.tools) ? JSON.stringify(body.tools).length : 0;
  let summaryChars = 0;
  let keptChars = 0;
  for (const m of rest) {
    const chars = msgChars(m);
    if (msgText(m).includes(COMPACTION_PREFIX)) summaryChars += chars;
    else keptChars += chars;
  }
  return {
    systemTokens: tokens(systemChars), systemChars,
    toolsTokens: tokens(toolsChars), toolsChars,
    summaryTokens: tokens(summaryChars), summaryChars,
    keptTokens: tokens(keptChars), keptChars,
    totalTokens: tokens(systemChars + toolsChars + summaryChars + keptChars),
    requestTokens: tokens(systemChars + toolsChars + rest.reduce((n, m) => n + msgChars(m), 0)),
  };
}

// ── scripted model ───────────────────────────────────────────────────────────────────────────────────
function startModel() {
  const requests = []; // every request: { promptTokens, summary, body }
  let summaryCount = 0;
  const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(80); // ~5k chars
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* housekeeping pings */ }
      const promptChars = (body.messages ?? []).reduce((n, m) => n + msgChars(m), 0)
        + (Array.isArray(body.tools) ? JSON.stringify(body.tools).length : 0);
      const promptTokens = tokens(promptChars);

      const isSummary = (body.messages ?? []).some((m) => m.role === 'system'
        && typeof m.content === 'string' && m.content.startsWith('You are a context summarization assistant'));
      requests.push({ promptTokens, summary: isSummary, promptChars, body });

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      const base = { id: 'chatcmpl-measure', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-model' };
      const frame = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      const delta = (d, finish = null) => frame({ ...base, choices: [{ index: 0, delta: d, finish_reason: finish }] });
      const usage = (p, c) => frame({ ...base, choices: [], usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c } });

      if (isSummary) {
        summaryCount += 1;
        // A realistic structured checkpoint summary, ~SUMMARY_CHARS chars.
        const summary = `## Goal\n${filler.slice(0, 600)}\n\n## Constraints & Preferences\n- (none)\n\n`
          + `## Progress\n### Done\n- [x] Long-running measurement conversation.\n\n`
          + `## Key Decisions\n- **Keep measuring**: stay on task.\n\n## Next Steps\n1. Continue the conversation.\n\n`
          + `## Critical Context\n- ${filler.slice(0, SUMMARY_CHARS - 700)}\n`;
        const text = summary.slice(0, SUMMARY_CHARS);
        delta({ role: 'assistant', content: text });
        delta({}, 'stop');
        usage(promptTokens, tokens(text.length));
      } else {
        // Plain-text turn: answer and stop, no tool calls. Short reply so the turn itself adds almost
        // nothing beyond the user message.
        delta({ role: 'assistant', content: 'Acknowledged, continuing.' });
        delta({}, 'stop');
        usage(promptTokens, 5);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      requests,
      get summaryCount() { return summaryCount; },
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

/** Count `idle` events so a send can be awaited to settlement (POST /brain/send returns on admission). */
async function watchIdle(baseUrl, token, session) {
  const res = await fetch(`${baseUrl}/brain/stream?session=${encodeURIComponent(session)}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
  });
  const reader = res.body.getReader();
  const state = { idle: 0, compacted: 0, unreachableNotices: 0 };
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
        for (const line of lines) {
          if (line.includes('"idle"')) state.idle += 1;
          if (line.includes('"compacted"')) state.compacted += 1;
          // The unreachable-threshold guard reports through the terminal-error channel; seeing it here
          // proves the user was actually told, not just that a log line exists.
          if (line.includes('cannot shrink this conversation below its threshold')) state.unreachableNotices += 1;
        }
      }
    } catch { /* torn down with the daemon */ }
  })();
  state.stop = () => reader.cancel().catch(() => {});
  return state;
}

async function main() {
  const model = await startModel();
  let daemon = null;
  try {
    daemon = await spawnRealDaemon({ providerBaseUrl: `http://127.0.0.1:${model.port}/v1` });
    const { baseUrl, token } = daemon;
    const api = async (path, body, method = 'POST') => {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
      try { return text ? JSON.parse(text) : null; } catch { return null; }
    };

    // Pin the model's context window to the scenario under test, then set the owner's auto-compact to
    // the percentage under test. Both ride the operator/user paths, no test-only back door.
    await api('/config', { brain: { modelContextWindows: { 'e2e/mock-model': WINDOW } } }, 'PUT');
    await api('/auth/me/cli-settings', { autoCompact: true, autoCompactAt: PCT }, 'PATCH');

    const start = await api('/brain/start', { fresh: true });
    const session = start.sessionId;
    const idle = await watchIdle(baseUrl, token, session);
    await sleep(200);

    const turn = async (text) => {
      const before = idle.idle;
      await api('/brain/send', { text, session, mode: 'build' });
      const until = Date.now() + TURN_DEADLINE_MS;
      while (idle.idle === before && Date.now() < until) await sleep(200);
      if (idle.idle === before) throw new Error(`turn never settled (compacted=${idle.compacted})`);
    };

    const reserve = Math.max(2, Math.round(WINDOW * (1 - PCT / 100)));
    const threshold = WINDOW - reserve;
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. '.repeat(Math.ceil(TURN_CHARS / 118));

    // Grow the session past the trigger with plain-text turns; stop as soon as PI ran a compaction
    // summary request (visible in the model server's request log).
    let fired = false;
    for (let i = 1; i <= MAX_TURNS && !fired; i += 1) {
      await turn(`Measurement turn ${i}: ${filler}`);
      const last = model.requests.at(-1);
      console.log(`  turn ${i}: prompt tokens ${last.promptTokens} (usage reported by the scripted model)`);
      fired = model.summaryCount > 0;
    }
    if (!fired) throw new Error(`auto-compaction never fired within ${MAX_TURNS} turns — threshold ${threshold} not crossed`);
    console.log(`auto-compaction fired (threshold ${threshold} tokens, reserve ${reserve} handed to PI)`);

    // The post-compaction context materializes in the NEXT provider request.
    await turn('Continue.');
    const post = model.requests.at(-1);
    if (post.summary) throw new Error('the post-compaction turn itself was a summary request — the session re-compacted before the next turn');
    const split = splitRequest(post.body);
    const lastMsg = post.body.messages.at(-1);
    const lastMsgTokens = tokens(msgChars(lastMsg));
    const floor = split.totalTokens - lastMsgTokens; // without the new continuation message
    const summaryReq = model.requests.find((r) => r.summary);
    console.log(`  summarization request prompt tokens: ${summaryReq?.promptTokens ?? 'n/a'} (the discarded history serialized)`);
    console.log('  post-compaction request messages:');
    for (const m of post.body.messages) {
      console.log(`    ${String(m.role).padEnd(10)} ${String(tokens(msgChars(m))).padStart(6)} tok  ${msgText(m).slice(0, 60).replace(/\n/g, ' ')}`);
    }

    // Thrash probe: several FULL-SIZE turns. A single tiny turn cannot re-arm PI's cut-point search —
    // prepareCompaction silently no-ops while the post-compaction tail holds less than keepRecentTokens
    // of cuttable history — so an unreachable threshold only shows its repeat cost once new turns have
    // accumulated another cuttable span. Count every further summarization these turns provoke: each one
    // is a full-price request that cannot get the context below the trigger.
    const beforeThrash = model.summaryCount;
    const THRASH_TURNS = 3;
    for (let i = 1; i <= THRASH_TURNS; i += 1) {
      await turn(`Thrash probe turn ${i}: ${filler}`);
    }
    await sleep(THRASH_WAIT_MS);
    const reFires = model.summaryCount - beforeThrash;
    const reFired = reFires > 0;

    console.log(`\n=== post-compaction context, autoCompactAt=${PCT}%, window=${WINDOW} ===`);
    console.log(`trigger threshold (contextWindow − reserveTokens): ${threshold}`);
    console.log(`summary budget PI allowed (0.8 × reserveTokens):     ${Math.floor(0.8 * reserve)} tokens`);
    console.log('');
    console.log('component                  tokens    chars');
    console.log('────────────────────────────────────────────');
    console.log(`system prompt               ${String(split.systemTokens).padStart(6)}  ${String(split.systemChars).padStart(6)}`);
    console.log(`tool definitions            ${String(split.toolsTokens).padStart(6)}  ${String(split.toolsChars).padStart(6)}`);
    console.log(`summary                     ${String(split.summaryTokens).padStart(6)}  ${String(split.summaryChars).padStart(6)}`);
    console.log(`kept recent messages        ${String(split.keptTokens).padStart(6)}  ${String(split.keptChars).padStart(6)}`);
    console.log('────────────────────────────────────────────');
    console.log(`floor total (no new msg)    ${String(floor).padStart(6)}`);
    console.log(`full request                ${String(split.requestTokens).padStart(6)}`);
    console.log('');
    const reachable = floor < threshold;
    console.log(`floor total ${floor}: ${reachable ? 'below' : 'EXCEEDS'} the ${threshold}-token trigger point`);
    console.log(reachable
      ? 'trigger point reachable — the percentage can be honored (post-compaction context sits below it)'
      : 'trigger point UNREACHABLE — the post-compaction context is already past the percentage the user set; only a smaller system prompt/tool set could fix this, no compaction setting can');
    console.log(`thrash probe: ${reFired ? `${reFires} further summarization(s) FIRED` : 'no further summarization fired'} across ${THRASH_TURNS} full-size post-compaction turns`);
    console.log(`unreachable-threshold notices delivered to the user: ${idle.unreachableNotices}`);
    idle.stop();
    return reachable ? 0 : 1;
  } finally {
    if (daemon) await daemon.stop();
    await model.close();
  }
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
