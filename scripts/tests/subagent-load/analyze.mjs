#!/usr/bin/env node
// Turn one or more run directories from run.mjs into the numbers the attribution rests on.
//
//   node scripts/tests/subagent-load/analyze.mjs /tmp/run-a /tmp/run-b …
//
// Everything here reads only what the probes appended. The `/health` numbers come from curl's
// `%{http_code}` and `%{time_total}` fields and from nothing else — a probe that timed out contributes a
// 000 line, and 000 lines are counted, never silently skipped or backfilled from a stale body.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const tsv = (path) => {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const head = lines.shift()?.split('\t') ?? [];
  return lines.map((l) => Object.fromEntries(l.split('\t').map((v, i) => [head[i] ?? `f${i}`, v])));
};

const pct = (sorted, p) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const fmt = (x, d = 1) => Number(x).toFixed(d);

function loadWindow(dir) {
  const marks = tsv(join(dir, 'marks.tsv'));
  const at = (name) => marks.find((m) => m.mark.startsWith(name))?.iso;
  const baselineStart = at('baseline-start');
  const baselineEnd = at('baseline-end');
  const loadStart = at('fanout-send') ?? at('bloat-turn-1-start');
  const loadEnd = at('drain-end') ?? marks.at(-1)?.iso;
  return { marks, baselineStart, baselineEnd, loadStart, loadEnd };
}

const within = (rows, from, to) => rows.filter((r) => (!from || r.iso >= from) && (!to || r.iso <= to));

function healthStats(rows) {
  const times = rows.map((r) => num(r.time_total)).sort((a, b) => a - b);
  const timeouts = rows.filter((r) => r.code !== '200');
  return {
    probes: rows.length,
    p50: pct(times, 50) * 1000,
    p95: pct(times, 95) * 1000,
    max: (times.at(-1) ?? 0) * 1000,
    nonOk: timeouts.length,
    over1s: times.filter((t) => t > 1).length,
    over5s: times.filter((t) => t > 5).length,
  };
}

function lagStats(dir, from, to, role) {
  const traceDir = join(dir, 'trace');
  if (!existsSync(traceDir)) return null;
  const rows = [];
  for (const f of readdirSync(traceDir)) {
    if (!f.startsWith('lag-')) continue;
    for (const r of tsv(join(traceDir, f))) if (r.role === role) rows.push(r);
  }
  const win = within(rows, from, to);
  if (win.length === 0) return null;
  const p50 = win.map((r) => num(r.p50)).sort((a, b) => a - b);
  const p99 = win.map((r) => num(r.p99)).sort((a, b) => a - b);
  const maxes = win.map((r) => num(r.max));
  // "Sustained" is what the incident showed: p50 655 ms means the loop was late on MOST iterations, over
  // many consecutive windows. Count 250 ms windows whose own median exceeded 100 ms.
  return {
    samples: win.length,
    medianOfP50: pct(p50, 50),
    p95OfP50: pct(p50, 95),
    medianOfP99: pct(p99, 50),
    p95OfP99: pct(p99, 95),
    worstMax: Math.max(0, ...maxes),
    sustainedWindows: win.filter((r) => num(r.p50) > 100).length,
  };
}

function sqlStats(dir, from, to, role) {
  const traceDir = join(dir, 'trace');
  if (!existsSync(traceDir)) return null;
  const rows = [];
  for (const f of readdirSync(traceDir)) {
    if (!f.startsWith('sql-')) continue;
    for (const r of tsv(join(traceDir, f))) if (r.role === role) rows.push(r);
  }
  // A row is recorded either because it BLOCKED for >50 ms or because it THREW. The two are different
  // failures — a slow write starves the loop, a SQLITE_BUSY write never happened at all — so they are
  // counted apart and the duration percentiles are taken over the slow ones only.
  const all = within(rows, from, to);
  const errs = all.filter((r) => r.code !== '-');
  const win = all.filter((r) => r.code === '-');
  const ms = win.map((r) => num(r.ms)).sort((a, b) => a - b);
  const byCall = new Map();
  for (const r of win) {
    const key = `${r.kind} ${r.sql}`.slice(0, 90);
    const cur = byCall.get(key) ?? { n: 0, total: 0, worst: 0 };
    cur.n += 1; cur.total += num(r.ms); cur.worst = Math.max(cur.worst, num(r.ms));
    byCall.set(key, cur);
  }
  return {
    slowCalls: win.length,
    totalBlockedMs: win.reduce((a, r) => a + num(r.ms), 0),
    p50: pct(ms, 50),
    p95: pct(ms, 95),
    worst: ms.at(-1) ?? 0,
    busy: errs.filter((r) => r.code.startsWith('SQLITE_BUSY')).length,
    busySnapshot: errs.filter((r) => r.code === 'SQLITE_BUSY_SNAPSHOT').length,
    busyWaitedMs: Math.max(0, ...errs.filter((r) => r.code.startsWith('SQLITE_BUSY')).map((r) => num(r.ms))),
    top: [...byCall.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 6),
  };
}

/** The write-lock canary: a trivial daemon INSERT every 100 ms. Its duration is lock wait, essentially by
 *  construction, so these are the numbers candidate 1 lives or dies on. */
function canaryStats(dir, from, to) {
  const traceDir = join(dir, 'trace');
  if (!existsSync(traceDir)) return null;
  const rows = [];
  for (const f of readdirSync(traceDir)) {
    if (f.startsWith('canary-')) rows.push(...tsv(join(traceDir, f)));
  }
  const win = within(rows, from, to);
  if (win.length === 0) return null;
  const ms = win.map((r) => num(r.ms)).sort((a, b) => a - b);
  return {
    n: win.length,
    p50: pct(ms, 50), p95: pct(ms, 95), p99: pct(ms, 99), max: ms.at(-1) ?? 0,
    over50: ms.filter((v) => v > 50).length,
    over500: ms.filter((v) => v > 500).length,
    errors: win.filter((r) => r.code !== '-').length,
  };
}

function cpuStats(dir, from, to) {
  const rows = within(tsv(join(dir, 'cpu.tsv')), from, to);
  const byIso = new Map();
  const daemon = [];
  for (const r of rows) {
    byIso.set(r.iso, (byIso.get(r.iso) ?? 0) + num(r.cpu_pct));
    if (r.role === 'daemon') daemon.push(num(r.cpu_pct));
  }
  const totals = [...byIso.values()].sort((a, b) => a - b);
  const d = daemon.sort((a, b) => a - b);
  const pids = new Set(rows.filter((r) => r.role === 'child').map((r) => r.pid));
  return {
    daemonP50: pct(d, 50), daemonP95: pct(d, 95), daemonMax: d.at(-1) ?? 0,
    treeP50: pct(totals, 50), treeP95: pct(totals, 95), treeMax: totals.at(-1) ?? 0,
    childProcs: pids.size,
  };
}

function walStats(dir, from, to) {
  const rows = within(tsv(join(dir, 'wal.tsv')), from, to);
  const wal = rows.map((r) => num(r.wal_mb));
  let resets = 0;
  for (let i = 1; i < wal.length; i += 1) if (wal[i] < wal[i - 1] * 0.5) resets += 1;
  return { peakMb: Math.max(0, ...wal), checkpointDrops: resets };
}

function report(dir) {
  const meta = existsSync(join(dir, 'meta.json')) ? JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) : {};
  const { baselineStart, baselineEnd, loadStart, loadEnd } = loadWindow(dir);
  const health = tsv(join(dir, 'health.tsv'));

  console.log(`\n########  ${meta.label ?? basename(dir)}  ########`);
  console.log(`runner=${meta.runnerOn ? 'ON' : 'OFF'}  toolResult=${meta.large ? '~64KB' : '~250B'}  bloatTurns=${meta.bloatTurns ?? 0}  children=${meta.counts?.childrenDone ?? '?'}/${meta.delegations ?? '?'}`);

  for (const [name, from, to] of [['BASELINE', baselineStart, baselineEnd], ['UNDER LOAD', loadStart, loadEnd]]) {
    const h = healthStats(within(health, from, to));
    console.log(`\n  ── ${name} (${from ?? '?'} → ${to ?? '?'})`);
    console.log(`  /health   probes=${h.probes}  p50=${fmt(h.p50)}ms  p95=${fmt(h.p95)}ms  max=${fmt(h.max)}ms  non-200=${h.nonOk}  >1s=${h.over1s}  >5s=${h.over5s}`);
    const dl = lagStats(dir, from, to, 'daemon');
    if (dl) console.log(`  loop(d)   windows=${dl.samples}  median p50=${fmt(dl.medianOfP50)}ms  p95 of p50=${fmt(dl.p95OfP50)}ms  median p99=${fmt(dl.medianOfP99)}ms  worst max=${fmt(dl.worstMax)}ms  sustained(>100ms p50)=${dl.sustainedWindows}`);
    const rl = lagStats(dir, from, to, 'runner');
    if (rl) console.log(`  loop(r)   windows=${rl.samples}  median p50=${fmt(rl.medianOfP50)}ms  median p99=${fmt(rl.medianOfP99)}ms  worst max=${fmt(rl.worstMax)}ms`);
    const ds = sqlStats(dir, from, to, 'daemon');
    if (ds) console.log(`  sql(d)    slow(>50ms)=${ds.slowCalls}  blocked=${fmt(ds.totalBlockedMs, 0)}ms  p50=${fmt(ds.p50)}ms  p95=${fmt(ds.p95)}ms  worst=${fmt(ds.worst)}ms  |  threw SQLITE_BUSY=${ds.busy} (of which _SNAPSHOT=${ds.busySnapshot}, longest wait before throwing ${fmt(ds.busyWaitedMs)}ms)`);
    const rs = sqlStats(dir, from, to, 'runner');
    if (rs && (rs.slowCalls || rs.busy)) console.log(`  sql(r)    slow(>50ms)=${rs.slowCalls}  blocked=${fmt(rs.totalBlockedMs, 0)}ms  worst=${fmt(rs.worst)}ms  |  threw SQLITE_BUSY=${rs.busy} (_SNAPSHOT=${rs.busySnapshot})`);
    const cn = canaryStats(dir, from, to);
    if (cn) console.log(`  LOCK      canary n=${cn.n}  p50=${fmt(cn.p50, 2)}ms  p95=${fmt(cn.p95, 2)}ms  p99=${fmt(cn.p99, 2)}ms  max=${fmt(cn.max, 1)}ms  >50ms=${cn.over50}  >500ms=${cn.over500}  errors=${cn.errors}`);
    const c = cpuStats(dir, from, to);
    console.log(`  cpu       daemon p50=${fmt(c.daemonP50)}%  p95=${fmt(c.daemonP95)}%  max=${fmt(c.daemonMax)}%  |  tree p95=${fmt(c.treeP95)}%  max=${fmt(c.treeMax)}%  childProcs=${c.childProcs}`);
    const w = walStats(dir, from, to);
    console.log(`  wal       peak=${fmt(w.peakMb, 2)}MB  checkpoint drops=${w.checkpointDrops}`);
    if (name === 'UNDER LOAD' && ds && ds.top.length) {
      console.log('  ── daemon blocking-SQL leaderboard (by total blocked ms)');
      for (const [key, v] of ds.top) console.log(`     ${fmt(v.total, 0).padStart(7)}ms  n=${String(v.n).padStart(4)}  worst=${fmt(v.worst).padStart(7)}ms  ${key}`);
    }
  }
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) { console.error('usage: analyze.mjs <run-dir> [run-dir…]'); process.exit(1); }
for (const d of dirs) report(d);
console.log('');
