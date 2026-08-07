#!/usr/bin/env node
// LOAD-REPRODUCTION HARNESS for the delegated-fan-out stall.
//
// Boots a REAL daemon on a scratch port against a scripted OpenAI-compatible model (same pattern as
// subagent-e2e / subagent-parity), then puts 20 background delegations in flight from ONE parent turn
// while four independent signals are recorded on a shared wall clock:
//
//   health.tsv  — `/health` client latency, measured with curl, one appended line per probe
//   lag-<pid>.tsv — event-loop delay percentiles per process, sampled every 250 ms (watchLoopLag's 30 s
//                 transition-only logging cannot attribute anything)
//   sql-<pid>.tsv — every better-sqlite3 call that BLOCKED its thread for >50 ms, with SQL + call site
//   cpu.tsv / wal.tsv — per-process CPU (daemon and every runner) and WAL growth
//
//   canary-<pid>.tsv — a trivial daemon INSERT every 100 ms whose DURATION is essentially pure SQLite
//                 write-lock wait, which is what separates "the daemon is writing a lot" from "another
//                 process is making the daemon wait"
//
// The last four require the temporary instrumentation in `loadtrace.patch` beside this file. It is NOT
// applied — it monkey-patches better-sqlite3 and must never ship — so out of the box this harness records
// health.tsv, cpu.tsv and wal.tsv only. That is enough to SEE a stall and not enough to ATTRIBUTE one;
// apply the patch, `npm run build`, run, then revert it.
//
// ONE run is one cell of the matrix. scripts/tests/subagent-load/matrix.mjs runs the cells; analyze.mjs
// turns a run directory into numbers.
//
//   node scripts/tests/subagent-load/run.mjs --runner=on --size=large --bloat=3 --out=/tmp/run-d
//
// SAFETY: scratch port, scratch data dir, scratch database. Never touches 4400/4500, the production
// database, or systemd.

import { mkdirSync, writeFileSync, appendFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnRealDaemon } from '../brain-e2e/spawn-daemon.mjs';
import { startScriptedModel } from './model.mjs';
import { startProbes } from './probes.mjs';

const DEFAULT_DELEGATIONS = 20;
const DEFAULT_TOOL_CALLS_PER_CHILD = 25;
/** Artificial provider latency. A zero-latency model would make every child spin as fast as the box
 *  allows, which is a different workload from the one that stalled production; 250 ms keeps the shape
 *  (long-lived children, interleaved tool results) without waiting on a real provider. */
const PROVIDER_LATENCY_MS = 250;
const TURN_DEADLINE_MS = 300_000;
const CHILDREN_DEADLINE_MS = 600_000;

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v = 'true'] = a.replace(/^--/, '').split('=');
  return [k, v];
}));

// Overridable so a smoke check of the harness itself costs seconds rather than minutes. The matrix runs
// with the defaults; anything else must be stated beside the numbers it produced.
const DELEGATIONS = Number(args.delegations ?? DEFAULT_DELEGATIONS);
const TOOL_CALLS_PER_CHILD = Number(args.tools ?? DEFAULT_TOOL_CALLS_PER_CHILD);
const BASELINE_MS = Number(args.baselineMs ?? 12_000);
const DRAIN_MS = Number(args.drainMs ?? 20_000);
/** Read calls one `bloat` warm-up turn makes — how fast the parent transcript grows per turn. */
const BLOAT_TOOL_CALLS = Number(args.bloatTools ?? '12');

const runnerOn = args.runner === 'on';
const large = (args.size ?? 'small') === 'large';
const bloatTurns = Number(args.bloat ?? '0');
const label = args.label ?? `${runnerOn ? 'runner-on' : 'runner-off'}-${large ? 'large' : 'small'}${bloatTurns ? `-bloat${bloatTurns}` : ''}`;
const runDir = args.out ?? join(tmpdir(), `elowen-load-${Date.now()}-${label}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

mkdirSync(runDir, { recursive: true });
const marksPath = join(runDir, 'marks.tsv');
writeFileSync(marksPath, 'iso\tmark\n');
const mark = (name) => {
  appendFileSync(marksPath, `${nowIso()}\t${name}\n`);
  console.log(`  · ${nowIso()} ${name}`);
};

/** Subscribe to a session's SSE stream, counting `idle` events so a send can be awaited to settlement.
 *  POST /brain/send returns as soon as the turn is ADMITTED. */
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

/** A fixture whose Read result is a known size. `large` targets ~64 KB of tool result, the size that
 *  isolates the SQLite-churn variable; `small` is a couple of hundred bytes of the same shape. */
function writeFixtures(dir) {
  const line = (n) => `${String(n).padStart(6, '0')} ${'lorem ipsum dolor sit amet consectetur adipiscing elit sed do '.repeat(2)}`;
  const smallPath = join(dir, 'fixture-small.txt');
  const largePath = join(dir, 'fixture-large.txt');
  writeFileSync(smallPath, [line(1), line(2)].join('\n') + '\n');
  const lines = [];
  for (let i = 0; i < 512; i += 1) lines.push(line(i));
  writeFileSync(largePath, lines.join('\n') + '\n');
  return { smallPath, largePath };
}

async function main() {
  console.log(`\n=== load run: ${label} ===`);
  console.log(`    runner=${runnerOn ? 'ON' : 'OFF'} toolResult=${large ? '~64KB' : '~250B'} bloatTurns=${bloatTurns}`);
  console.log(`    out: ${runDir}`);

  const traceDir = join(runDir, 'trace');
  mkdirSync(traceDir, { recursive: true });

  const model = await startScriptedModel({
    delegations: DELEGATIONS,
    toolCallsPerChild: TOOL_CALLS_PER_CHILD,
    bloatToolCalls: BLOAT_TOOL_CALLS,
    latencyMs: PROVIDER_LATENCY_MS,
  });

  let daemon = null;
  let stopProbes = () => {};
  try {
    daemon = await spawnRealDaemon({
      providerBaseUrl: model.baseUrl,
      providerId: 'load',
      env: {
        ELOWEN_LOAD_TRACE: traceDir,
        ELOWEN_LOAD_TRACE_SLOW_MS: '50',
        ELOWEN_LOAD_TRACE_LAG_MS: '250',
        // The daemon-side write-lock canary: a trivial INSERT every 100 ms whose DURATION is essentially
        // pure lock wait. This is the measurement that confirms or kills candidate 1.
        ELOWEN_LOAD_TRACE_CANARY: '1',
        ELOWEN_LOAD_TRACE_CANARY_MS: '100',
      },
    });
    const { baseUrl, dataDir, token } = daemon;
    const dbPath = join(dataDir, 'elowen.db');

    const { smallPath, largePath } = writeFixtures(dataDir);
    model.setFixture(large ? largePath : smallPath);

    const putConfig = async (patch) => {
      const res = await fetch(`${baseUrl}/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`config PUT failed: HTTP ${res.status} ${await res.text()}`);
    };
    await putConfig({ runtime: { subagentRunnerEnabled: runnerOn } });

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

    stopProbes = startProbes({ baseUrl, daemonPid: daemon.pid(), dbPath, runDir });
    mark('probes-started');

    const start = await api('/brain/start', { fresh: true });
    const session = start?.sessionId;
    if (!session) throw new Error('no session id from /brain/start');
    const stream = await openStream(baseUrl, token, session);
    await sleep(200);

    const turn = async (text, mode) => {
      model.setMode(mode);
      const before = stream.state.idles;
      await api('/brain/send', { text, session, mode: 'build' });
      const until = Date.now() + TURN_DEADLINE_MS;
      while (stream.state.idles <= before) {
        if (Date.now() > until) throw new Error(`turn "${text}" never settled (errors: ${stream.state.errors.join('; ') || 'none'})`);
        await sleep(100);
      }
    };

    mark('baseline-start');
    await sleep(BASELINE_MS);
    mark('baseline-end');

    // Candidate 2: a large live session in the daemon. The DELEGATING session is the one bloated, which
    // is what production had — the owner's 202k-token conversation was the one fanning out.
    for (let i = 1; i <= bloatTurns; i += 1) {
      mark(`bloat-turn-${i}-start`);
      await turn(`Warm-up pass ${i}: read the fixture repeatedly.`, 'bloat');
      mark(`bloat-turn-${i}-end`);
    }

    mark('fanout-send');
    await turn(`Fan out ${DELEGATIONS} background sub-agents.`, 'fanout');
    model.setMode('idle');
    mark('fanout-parent-turn-settled');

    const until = Date.now() + CHILDREN_DEADLINE_MS;
    while (model.counts.childrenDone < DELEGATIONS) {
      if (Date.now() > until) { mark('children-deadline-exceeded'); break; }
      await sleep(500);
    }
    mark(`children-done-${model.counts.childrenDone}/${DELEGATIONS}`);

    await sleep(DRAIN_MS);
    mark('drain-end');

    stream.close();
    writeFileSync(join(runDir, 'daemon.log'), daemon.logText());
    writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
      label, runnerOn, large, bloatTurns,
      delegations: DELEGATIONS,
      toolCallsPerChild: TOOL_CALLS_PER_CHILD,
      providerLatencyMs: PROVIDER_LATENCY_MS,
      counts: model.counts,
      daemonPid: daemon.pid(),
    }, null, 2));
    // The data dir is destroyed by teardown; keep the final database SIZE, not the file.
    if (existsSync(dbPath)) writeFileSync(join(runDir, 'db-final-bytes.txt'), `${statSync(dbPath).size}\n`);
  } finally {
    stopProbes();
    // The traces are written INSIDE the run dir already, so teardown cannot take them with it.
    if (daemon) await daemon.stop();
    await model.close();
  }
  console.log(`\n=== done: ${label} → ${runDir}\n`);
}

main().catch((err) => {
  console.error(`LOAD RUN ERROR — ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
});
