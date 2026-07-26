#!/usr/bin/env node
// Plugin-hook E2E — can a plugin actually stop a tool call, and only when it is allowed to?
//
// `tools.call.before` is the one hook that can BLOCK, which makes it the one whose failure modes are
// dangerous in both directions: a veto that silently does nothing is a broken safety net, and a veto
// honoured from a plugin that never asked for the power is a privilege escalation. Unit tests cover the
// bus in isolation; this suite drives two REAL fixture plugins through a REAL daemon and asserts on the
// traffic the model saw, because that is where all three parts (bus, capability gate, tool gate) meet.
//
// Run with: npm run test:e2e:hooks

import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnRealDaemon } from '../brain-e2e/spawn-daemon.mjs';
import { startScriptedModel } from './model.mjs';

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), 'fixture-plugins');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Count `idle` events so a send can be awaited to settlement — POST /brain/send returns on admission. */
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
    const authed = (path, init = {}) => fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });

    // Three files whose CONTENTS are the evidence: each marker can only reach the model by travelling
    // through a Read that actually ran, so its presence or absence says exactly whether the gate fired.
    const workspace = join(dataDir, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const files = {
      plain: join(workspace, 'plain.txt'),
      blocked: join(workspace, 'blocked.txt'),
      ungated: join(workspace, 'ungated.txt'),
    };
    writeFileSync(files.plain, 'MARKER-PLAIN-CONTENT\n');
    writeFileSync(files.blocked, 'MARKER-BLOCKED-CONTENT\n');
    writeFileSync(files.ungated, 'MARKER-UNGATED-CONTENT\n');

    // Drop the fixture plugins into the instance's own plugin dir and enable them. Both must happen
    // BEFORE /brain/start, which is when the brain lazily loads the registry.
    cpSync(fixtureRoot, join(dataDir, 'plugins'), { recursive: true });
    for (const name of ['hooks-veto', 'hooks-nocap']) {
      const res = await authed(`/plugins/${name}`, { method: 'PATCH', body: JSON.stringify({ enabled: true }) });
      if (!res.ok) throw new Error(`enabling ${name} failed: HTTP ${res.status} ${await res.text()}`);
    }

    // Guard against the vacuous pass, and specifically against the WEAK version of this guard: the
    // plugin listing reports what the daemon can SEE, so asserting on it would happily confirm two
    // fixtures that never ran a line of code. Only the runtime view proves they actually registered —
    // and if they did not, nothing below could block anything and every check would agree for the wrong
    // reason.
    const runtime = JSON.stringify(await (await authed('/plugins/runtime')).json());
    check('both fixture plugins actually registered',
      runtime.includes('hooks-veto') && runtime.includes('hooks-nocap'), runtime.slice(0, 400));

    const start = await api('/brain/start', { fresh: true });
    const session = start?.sessionId;
    if (!session) throw new Error('no session id from /brain/start');
    await api('/brain/yolo', { on: true, session });
    const stream = await openStream(baseUrl, token, session);
    await sleep(200);

    /** Everything the model was ever sent — tool results included. A marker present here means the tool
     *  ran and its output travelled onward; absent means the call never happened. */
    const traffic = () => JSON.stringify(model.requests);

    const turn = async (text, target) => {
      model.setTarget(target);
      const before = stream.state.idles;
      await api('/brain/send', { text, session, cwd: workspace });
      const until = Date.now() + 40_000;
      while (stream.state.idles <= before) {
        if (Date.now() > until) throw new Error(`turn "${text}" never settled (errors: ${stream.state.errors.join('; ') || 'none'})`);
        await sleep(50);
      }
    };

    console.log('\n— a throwing hook blocks nothing —');
    await turn('Read the plain file.', files.plain);
    check('the read went through despite a hook that always throws',
      traffic().includes('MARKER-PLAIN-CONTENT'));

    console.log('\n— a capable plugin can refuse a tool call —');
    await turn('Read the blocked file.', files.blocked);
    check('the tool never ran, so its contents never reached the model',
      !traffic().includes('MARKER-BLOCKED-CONTENT'));
    check('the model was told WHY, so it can adapt instead of retrying blindly',
      traffic().includes('E2E-VETO-REASON'));

    console.log('\n— a plugin without the capability cannot —');
    await turn('Read the ungated file.', files.ungated);
    check('the ungated refusal was dropped and the read went through',
      traffic().includes('MARKER-UNGATED-CONTENT'));
    check('its refusal text never reached the model either',
      !traffic().includes('E2E-UNGATED-VETO'));

    stream.close();
  } finally {
    if (daemon) await daemon.stop();
    await model.close();
  }

  if (failures > 0) { console.log(`\nFAIL — ${failures} check(s) failed`); process.exit(1); }
  console.log('\nPASS — plugin hooks block exactly what they are allowed to');
}

main().catch((e) => { console.error(`\nSUITE ERROR — ${e instanceof Error ? e.stack : String(e)}`); process.exit(1); });
