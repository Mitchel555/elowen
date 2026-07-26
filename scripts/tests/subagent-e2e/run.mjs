#!/usr/bin/env node
// Sub-agent persistence + continuation E2E — is a finished sub-agent really still there, and does it
// resume with its own context?
//
// Drives a REAL daemon: a parent conversation delegates one task, then FOUR unrelated ones so the live
// channel-session LRU (pinned to its minimum of 4 here) genuinely drops the first child from memory.
// Only then does the parent call DelegateList, pick that child OUT OF THE LISTING, and DelegateContinue
// it. Because the child is no longer live, the follow-up can only be answered from a transcript
// rehydrated out of SQLite — which is exactly what this suite exists to prove.
//
// The decisive assertion is made twice, from two independent angles:
//   * on the WIRE — the continuation request the daemon sent still carries the original task and the
//     child's own first answer;
//   * on BEHAVIOUR — the scripted child inspects that history itself and answers with a different marker
//     when it is missing, so a broken rehydration reaches the parent as "context lost".
//
// The listing's scope is a security boundary, so it is covered too: a SECOND conversation asking the
// same question sees none of the first one's children.
//
// Run with: npm run test:e2e:subagent

import { join } from 'node:path';
import { spawnRealDaemon } from '../brain-e2e/spawn-daemon.mjs';
import {
  startScriptedModel, contentText, MARKERS, SUBAGENT_PROMPT, LISTING_HEADER,
  CHANNEL_SESSION_CAP, FILLER_DELEGATIONS,
} from './model.mjs';

const TURN_DEADLINE_MS = 120_000;

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Subscribe to a session's SSE stream, counting `idle` events so a send can be awaited to settlement.
 *  POST /brain/send returns as soon as the turn is ADMITTED, so without this every assertion races the
 *  work it is meant to observe. */
async function openStream(baseUrl, token, session) {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/brain/stream?session=${encodeURIComponent(session)}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) throw new Error(`stream open failed: HTTP ${res.status}`);
  const state = { idles: 0, errors: [] };
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
          const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          if (!data) continue;
          try {
            const evt = JSON.parse(data);
            if (evt.type === 'idle') state.idles += 1;
            if (evt.type === 'error') state.errors.push(String(evt.message ?? 'unknown'));
          } catch { /* non-JSON frame */ }
        }
      }
    } catch { /* aborted on close */ }
  })();
  return { state, close: () => controller.abort() };
}

/** Every message of one captured model request, flattened — for marker matching. */
const requestText = (req) => (Array.isArray(req?.body?.messages) ? req.body.messages : [])
  .map(contentText).join('\n');
/** The same request WITHOUT its system prompt — what a failure detail should show (what the child was
 *  actually asked), rather than a few hundred characters of role prompt. */
const conversationText = (req) => (Array.isArray(req?.body?.messages) ? req.body.messages : [])
  .filter((m) => m?.role !== 'system').map((m) => `${m?.role}: ${contentText(m)}`).join('\n');
/** The tool result THIS request is answering, or '' when it is not a post-tool follow-up. */
const toolResultText = (req) => {
  const last = Array.isArray(req?.body?.messages) ? req.body.messages.at(-1) : undefined;
  return last?.role === 'tool' ? contentText(last) : '';
};
const excerpt = (text, limit = 400) => (text.length <= limit ? text : `${text.slice(0, limit)}…`);

async function getJson(baseUrl, path, token) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET ${path} failed: HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const model = await startScriptedModel();
  let daemon = null;
  try {
    daemon = await spawnRealDaemon({ providerBaseUrl: model.baseUrl, providerId: 'e2e-subagent' });
    const { baseUrl, token, dataDir } = daemon;

    const api = async (path, body) => {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`POST ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
      try { return text ? JSON.parse(text) : null; } catch { return null; }
    };

    // Shrink the live channel-session LRU to its minimum. The suite's whole claim is that a sub-agent
    // survives being dropped from memory, so the fillers below must be able to actually drop one — at the
    // default cap of 32 nothing is ever evicted and the continuation would be served from RAM.
    const limits = await fetch(`${baseUrl}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ brain: { limits: { channelSessionCap: CHANNEL_SESSION_CAP } } }),
    });
    if (!limits.ok) throw new Error(`config PUT failed: HTTP ${limits.status} ${await limits.text()}`);

    /** Send one turn on `session`, wait for it to settle, and return the slice of model requests that
     *  turn produced (parent AND child requests alike — a delegation drives both). */
    const turnOn = (session, stream) => async (text, mode) => {
      model.setMode(mode);
      const before = stream.state.idles;
      const from = model.requests.length;
      await api('/brain/send', { text, session, mode: 'build' });
      const until = Date.now() + TURN_DEADLINE_MS;
      while (stream.state.idles <= before) {
        if (Date.now() > until) throw new Error(`turn "${text}" never settled (errors: ${stream.state.errors.join('; ') || 'none'})`);
        await sleep(50);
      }
      return model.requests.slice(from);
    };

    const startA = await api('/brain/start', { fresh: true });
    const sessionA = startA?.sessionId;
    if (!sessionA) throw new Error('no session id from /brain/start');
    const streamA = await openStream(baseUrl, token, sessionA);
    await sleep(200);
    const turnA = turnOn(sessionA, streamA);

    console.log('\n— a delegated sub-agent runs and is persisted as this conversation\'s child —');
    const delegated = await turnA('Delegate the widget sizing to a sub-agent.', 'delegate');
    check('the sub-agent really ran (its own request carried the role prompt + the delegated task)',
      delegated.some((r) => requestText(r).includes(SUBAGENT_PROMPT) && requestText(r).includes(MARKERS.task)));
    check('its answer came back to the parent as the Delegate tool result',
      delegated.some((r) => toolResultText(r).includes(MARKERS.firstAnswer)));

    const { default: Database } = await import('better-sqlite3');
    const db = new Database(join(dataDir, 'elowen.db'), { readonly: true });
    const children = db.prepare(
      `SELECT id, parent_session_id, delegated_access FROM brain_sessions
        WHERE parent_session_id = ? AND id LIKE 'brain-ch-subagent-%'
        ORDER BY created_at ASC, rowid ASC`
    ).all(sessionA);
    const target = children[0];
    check('the child is stored as a sub-agent session linked to its parent',
      !!target && target.parent_session_id === sessionA, `children: ${children.map((c) => c.id).join(', ') || '(none)'}`);
    if (!target) throw new Error('no child session was persisted — the assertions below would be meaningless');
    let scope = null;
    try { scope = JSON.parse(target.delegated_access ?? 'null'); } catch { scope = null; }
    check('…with its execution scope frozen on the row (so it can resume under it later)',
      !!scope && Object.prototype.hasOwnProperty.call(scope, 'permissionBoundary'),
      `delegated_access: ${excerpt(String(target.delegated_access), 200)}`);

    console.log('\n— unrelated delegations push it out of the live-session LRU —');
    await turnA('Now run the unrelated side tasks.', 'fillers');
    const allChildren = db.prepare(
      `SELECT id FROM brain_sessions WHERE parent_session_id = ? AND id LIKE 'brain-ch-subagent-%'`
    ).all(sessionA);
    // With the cap pinned at CHANNEL_SESSION_CAP, spawning this many children means the oldest idle one —
    // the target — was disposed. From here, continuing it MUST rehydrate from SQLite.
    check(`${FILLER_DELEGATIONS} further sub-agents ran, so the target no longer fits the cap of ${CHANNEL_SESSION_CAP}`,
      allChildren.length === FILLER_DELEGATIONS + 1, `children persisted: ${allChildren.length}`);

    console.log('\n— DelegateList finds it, DelegateContinue resumes it WITH its context —');
    const continued = await turnA('Check what you delegated and follow it up.', 'listcontinue');

    const listing = continued.map(toolResultText).find((t) => t.includes(LISTING_HEADER)) ?? '';
    check('DelegateList reported the past sub-agents to the parent', !!listing);
    check('…naming the target child by session id', listing.includes(target.id), excerpt(listing));
    check('…with the task it was given', listing.includes(MARKERS.task), excerpt(listing));
    check('…and its terminal status plus transcript size', /done ·/.test(listing) && /\d+ messages/.test(listing), excerpt(listing));

    const followUpReq = continued.find((r) => requestText(r).includes(SUBAGENT_PROMPT)
      && requestText(r).includes(MARKERS.followUp));
    check('the follow-up reached the sub-agent itself', !!followUpReq,
      `requests in this turn: ${continued.length}`);
    // The wire proof: the daemon rebuilt the evicted child's transcript before asking it anything.
    check('…on top of its rehydrated transcript (the original task is still in its history)',
      !!followUpReq && requestText(followUpReq).includes(MARKERS.task),
      followUpReq ? excerpt(conversationText(followUpReq), 600) : '');
    check('…including its own earlier answer',
      !!followUpReq && requestText(followUpReq).includes(MARKERS.firstAnswer),
      followUpReq ? excerpt(conversationText(followUpReq), 600) : '');
    // The behavioural proof: the child itself checked its history and answered accordingly.
    check('the sub-agent answered from that context, and the parent got that answer',
      continued.some((r) => toolResultText(r).includes(MARKERS.contextOk)),
      continued.map(toolResultText).filter(Boolean).map((t) => excerpt(t, 200)).join(' | '));
    check('…and never reported losing it',
      !model.requests.some((r) => requestText(r).includes(MARKERS.contextLost)));

    // Read the parent transcript back: the listing has to be usable, not merely present. A listing the
    // agent cannot pick a child out of leaves the fixture answering with its "no id" marker instead.
    const parentTranscript = JSON.stringify(await getJson(baseUrl, `/brain/messages?session=${encodeURIComponent(sessionA)}`, token));
    check('the parent completed the list-then-continue chain on a usable listing',
      parentTranscript.includes(MARKERS.parentDone) && !parentTranscript.includes(MARKERS.noChildId));

    const messages = db.prepare('SELECT COUNT(*) AS n FROM brain_messages WHERE session_id = ?').get(target.id);
    check('the continuation was appended to the SAME transcript, not a fresh one',
      Number(messages?.n) >= 4, `child transcript rows: ${messages?.n}`);

    console.log('\n— the listing is scoped to its own conversation —');
    const startB = await api('/brain/start', { fresh: true });
    const sessionB = startB?.sessionId;
    if (!sessionB) throw new Error('no session id for the second conversation');
    check('the second conversation is a different session', sessionB !== sessionA);
    const streamB = await openStream(baseUrl, token, sessionB);
    await sleep(200);
    const scoped = await turnOn(sessionB, streamB)('What have you delegated so far?', 'scoped');
    const otherListing = scoped.map(toolResultText).find((t) => t.trim()) ?? '';
    check('another conversation is told it has no sub-agents of its own',
      otherListing.includes('No sub-agents have run in this conversation yet'), excerpt(otherListing));
    check('…and is shown none of this conversation\'s children',
      !otherListing.includes('brain-ch-subagent-'), excerpt(otherListing));

    db.close();
    streamB.close();
    streamA.close();
  } finally {
    if (daemon) await daemon.stop();
    await model.close();
  }

  console.log(failures === 0
    ? '\nPASS — a delegated sub-agent survives eviction, is listable and resumes with its context\n'
    : `\nFAIL — ${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`SUITE ERROR — ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
});
