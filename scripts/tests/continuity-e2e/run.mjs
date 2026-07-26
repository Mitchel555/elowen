#!/usr/bin/env node
// Continuity E2E — does a compaction still cost the agent its plan and its bearings?
//
// Drives a REAL daemon through the exact sequence that used to lose both: propose a plan, work in two
// files, compact, then take another turn. The assertion is made against the PROMPT THE DAEMON ACTUALLY
// SENT to the provider — not an internal function's return value — because that wire payload is the
// only thing the model ever sees, and it is what every one of these parts exists to shape.
//
// Also covers the two ways this can be quietly wrong: a plan re-injected when the model can still read
// it (pure waste), and a mode directive resent in full on every single turn (the token leak).
//
// Run with: npm run test:e2e:continuity

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnRealDaemon } from '../brain-e2e/spawn-daemon.mjs';
import { startScriptedModel, PATHS } from './model.mjs';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Subscribe to the session's SSE stream, counting `idle` events so a send can be awaited to settlement.
 *  POST /brain/send returns as soon as the turn is ADMITTED, so without this every assertion races the
 *  work it is meant to observe. */
async function openStream(baseUrl, token, session) {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/brain/stream?session=${encodeURIComponent(session)}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) throw new Error(`stream open failed: HTTP ${res.status}`);
  const state = { idles: 0, compactions: 0, errors: [] };
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
            if (evt.type === 'compacted') state.compactions += 1;
            if (evt.type === 'error') state.errors.push(String(evt.message ?? 'unknown'));
          } catch { /* non-JSON frame */ }
        }
      }
    } catch { /* aborted on close */ }
  })();
  return { state, close: () => controller.abort() };
}

async function main() {
  const model = await startScriptedModel();
  let daemon = null;
  try {
    daemon = await spawnRealDaemon({ providerBaseUrl: model.baseUrl });
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

    // Files the scripted model touches, under the daemon's own project path (the temp dir) so pathGuard
    // allows them. The write target deliberately does NOT exist: the files plugin's read-before-write
    // guard refuses to overwrite a file this conversation has never read, but creating one is fine.
    const workspace = join(dataDir, 'workspace');
    mkdirSync(workspace, { recursive: true });
    PATHS.read = join(workspace, 'read-me.ts');
    writeFileSync(PATHS.read, 'export const a = 1;\n');

    // PI refuses to compact until the context outgrows the reserve derived from the auto-compact
    // threshold, and a mock model's conversation never approaches 80% of a 200k window. Lower the
    // threshold so a modest scripted session really is compactable — the suite must exercise a REAL
    // compaction, not a refused one that would make every assertion below vacuously pass.
    const settings = await fetch(`${baseUrl}/auth/me/cli-settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ autoCompact: true, autoCompactAt: 2 }),
    });
    if (!settings.ok) throw new Error(`cli-settings PATCH failed: HTTP ${settings.status}`);

    const start = await api('/brain/start', { fresh: true });
    const session = start?.sessionId;
    if (!session) throw new Error('no session id from /brain/start');
    await api('/brain/yolo', { on: true, session });
    const stream = await openStream(baseUrl, token, session);
    await sleep(200);

    /** The user message of one recorded request — the turn as the model received it, per-turn blocks
     *  and all. Deliberately the LAST USER message of ONE request, never the whole array: history still
     *  holds every earlier directive, so joining it all would make "the full text was not resent" pass
     *  for the wrong reason. */
    const promptOf = (index) => {
      const messages = model.requests[index]?.body?.messages ?? [];
      const lastUser = [...messages].reverse().find((m) => m?.role === 'user');
      const content = lastUser?.content;
      return typeof content === 'string' ? content : JSON.stringify(content ?? '');
    };

    /** Send a turn, WAIT for it to settle, and return the prompt THAT turn was sent with.
     *  Returning its own request matters: a compaction fires its own completion afterwards, so simply
     *  reading the newest request would inspect a summarisation call instead of the turn. */
    const turn = async (text, mode, opts = {}) => {
      model.setMode(mode);
      const before = stream.state.idles;
      const firstRequest = model.requests.length;
      await api('/brain/send', { text, session, cwd: workspace, ...(opts.workMode ? { mode: opts.workMode } : {}) });
      const until = Date.now() + 40_000;
      while (stream.state.idles <= before) {
        if (Date.now() > until) throw new Error(`turn "${text}" never settled (errors: ${stream.state.errors.join('; ') || 'none'})`);
        await sleep(50);
      }
      return promptOf(firstRequest);
    };

    console.log('\n— a plan is captured and survives the compaction —');
    await turn('How would you ship the widget?', 'plan');

    const plansDir = join(dataDir, '.config/elowen/plans');
    const planFile = join(plansDir, `${session}.md`);
    check('the plan was written to the data dir', existsSync(planFile),
      `expected ${planFile}; dir holds: ${existsSync(plansDir) ? readdirSync(plansDir).join(', ') || '(empty)' : '(missing)'}`);
    const planBody = existsSync(planFile) ? readFileSync(planFile, 'utf8') : '';
    check('the plan file holds the block body, without its tags',
      planBody.includes('# Ship the widget') && !planBody.includes('<proposed_plan>'), planBody.slice(0, 160));

    await turn('Read the first file.', 'read');
    // Only a READ is driven here. Write-class tools need an approval this API-driven daemon has no one
    // to give, and a fixture whose edit silently never lands would assert nothing while looking like it
    // did. The `wrote: true` half of the rollup — its stickiness and its chaining across repeated
    // compactions — is covered exhaustively in tests/brain/continuity/workingSet.test.ts.

    // Grow the conversation until auto-compaction actually fires. Waiting for the daemon's own
    // `compacted` event (rather than assuming a turn count) keeps this honest: a refused compaction
    // would make every assertion below pass vacuously, so the suite must SEE one happen.
    let grew = 0;
    while (stream.state.compactions === 0 && grew < 14) {
      grew += 1;
      await turn(`Tell me more, part ${grew}.`, 'filler');
    }
    check('a real compaction happened', stream.state.compactions > 0, `gave up after ${grew} turns`);
    if (stream.state.compactions === 0) throw new Error('no compaction — the assertions below would be meaningless');

    // The `compacted` event is published as soon as PI's in-memory compaction settles; mirroring it
    // into the store is deferred to the run's end. The reminder is derived from that stored divider,
    // so wait for the ROW, not just the event — otherwise this races the very write it depends on. A
    // real user types their next message seconds later and never notices the gap.
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(join(dataDir, 'elowen.db'), { readonly: true });
    const dividerRow = () => db
      .prepare("SELECT id FROM brain_messages WHERE session_id = ? AND role = 'compaction' ORDER BY rowid DESC LIMIT 1")
      .get(session);
    const until = Date.now() + 10_000;
    while (!dividerRow() && Date.now() < until) await sleep(100);
    check('the compaction reached the store', !!dividerRow());
    db.close();

    // Put the threshold back so nothing compacts again mid-assertion: from here the suite is checking
    // what ONE compaction produced, and a second one firing underneath would muddy every check.
    await fetch(`${baseUrl}/auth/me/cli-settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ autoCompact: false, autoCompactAt: 80 }),
    });

    const prompt = await turn('Carry on.', 'plain');
    check('the next turn carries the post-compaction reminder', prompt.includes('<post-compaction-context>'), excerpt(prompt));
    check('…including the plan the compaction destroyed', prompt.includes('# Ship the widget'), excerpt(prompt));
    check('…and the file it was working in, correctly marked as read', prompt.includes('read-me.ts (read)'), excerpt(prompt));
    check('…telling the model not to trust the summary about file contents',
      prompt.includes('do not assume file contents from the summary'), excerpt(prompt));

    console.log('\n— it is a ONE-SHOT reminder, not a permanent header —');
    const after = await turn('And again.', 'plain');
    check('the turn after does not repeat it', !after.includes('<post-compaction-context>'), excerpt(after));

    console.log('\n— a mode directive is restated in full on entry, then sparsely —');
    const entered = await turn('plan one', 'plain', { workMode: 'plan' });
    check('entering plan mode sends the full directive', entered.includes('<when-ready>'), excerpt(entered));
    const second = await turn('plan two', 'plain', { workMode: 'plan' });
    check('the next plan turn sends the one-liner instead',
      second.includes('STILL ACTIVE') && !second.includes('<when-ready>'), excerpt(second));

    stream.close();
  } finally {
    if (daemon) await daemon.stop();
    await model.close();
  }

  console.log(failures === 0 ? '\nPASS — continuity survives compaction\n' : `\nFAIL — ${failures} check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** A short, readable slice of a prompt for a failure message. */
function excerpt(prompt) {
  const at = prompt.indexOf('<post-compaction-context>');
  return at === -1 ? `prompt tail: …${prompt.slice(-260)}` : prompt.slice(at, at + 360);
}

main().catch((err) => {
  console.error(`SUITE ERROR — ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
});
