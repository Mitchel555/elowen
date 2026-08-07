// The measurement side of the load harness: everything that observes the scratch daemon from OUTSIDE,
// on one wall-clock timeline so the four signals can be correlated afterwards.
//
//   health.tsv  — `/health` client latency, one line per probe, appended.
//   cpu.tsv     — per-process CPU for the daemon and every descendant (runners), from /proc.
//   wal.tsv     — the WAL file's size over time.
//
// THE `curl -o file` TRAP, deliberately avoided: on a timeout curl leaves the PREVIOUS body in place, so
// a run that reads the recorded body sees a healthy `eventLoop` block written seconds earlier and
// concludes the daemon was fine at exactly the moment it was dead. Here the body goes to stdout and is
// appended, never to a reused path, and `%{http_code}\t%{time_total}` is written AFTER it — so a timeout
// contributes a line whose body is empty or truncated and whose code is 000. The code and the time are
// the fields anything downstream is allowed to trust.

import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const nowIso = () => new Date().toISOString();

/** Poll `/health` with curl, one appended line per probe, forever until stopped. */
export function startHealthProbe(baseUrl, outPath, { intervalMs = 250, timeoutS = 20 } = {}) {
  writeFileSync(outPath, 'iso\tbody\tcode\ttime_total\n');
  // `printf` writes the timestamp, curl appends body + the -w suffix, so ONE probe is ONE line even when
  // curl times out and produces no body at all.
  const script = `
    while :; do
      printf '%s\\t' "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" >> "$OUT"
      curl -s -m ${timeoutS} -w '\\t%{http_code}\\t%{time_total}\\n' "$URL" >> "$OUT" 2>/dev/null || printf '\\t000\\tcurl-error\\n' >> "$OUT"
      sleep ${intervalMs / 1000}
    done
  `;
  const child = spawn('bash', ['-c', script], {
    env: { ...process.env, OUT: outPath, URL: `${baseUrl}/health` },
    stdio: 'ignore',
  });
  return () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
}

const CLK_TCK = 100; // Linux default; USER_HZ has been 100 on every supported kernel config.

function procStat(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm can contain spaces and parentheses — split after the LAST ')'.
    const close = raw.lastIndexOf(')');
    const comm = raw.slice(raw.indexOf('(') + 1, close);
    const rest = raw.slice(close + 2).split(' ');
    // After state (field 3), fields are 0-indexed here: ppid=1, utime=11, stime=12, rss(pages)=21.
    return {
      comm,
      ppid: Number(rest[1]),
      cpuTicks: Number(rest[11]) + Number(rest[12]),
      rssBytes: Number(rest[21]) * 4096,
    };
  } catch { return null; }
}

/** Every pid in the subtree rooted at `root`, `root` included. */
function descendants(root) {
  const byParent = new Map();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const st = procStat(name);
    if (!st) continue;
    if (!byParent.has(st.ppid)) byParent.set(st.ppid, []);
    byParent.get(st.ppid).push(Number(name));
  }
  const out = [root];
  for (let i = 0; i < out.length; i += 1) out.push(...(byParent.get(out[i]) ?? []));
  return out;
}

/** Per-process CPU%, computed the way pidstat computes it: (utime+stime) delta over the sample interval. */
export function startCpuProbe(rootPid, outPath, { intervalMs = 500 } = {}) {
  writeFileSync(outPath, 'iso\tpid\trole\tcpu_pct\trss_mb\n');
  const last = new Map();
  const timer = setInterval(() => {
    const iso = nowIso();
    const at = Date.now();
    const lines = [];
    for (const pid of descendants(rootPid)) {
      const st = procStat(pid);
      if (!st) continue;
      const prev = last.get(pid);
      last.set(pid, { ticks: st.cpuTicks, at });
      if (!prev || at === prev.at) continue;
      const pct = ((st.cpuTicks - prev.ticks) / CLK_TCK) / ((at - prev.at) / 1000) * 100;
      const role = pid === rootPid ? 'daemon' : 'child';
      lines.push(`${iso}\t${pid}\t${role}\t${pct.toFixed(1)}\t${(st.rssBytes / 1048576).toFixed(1)}\n`);
    }
    if (lines.length) { try { appendFileSync(outPath, lines.join('')); } catch { /* ignore */ } }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** WAL growth — the checkpointing candidate's only external signal. */
export function startWalProbe(dbPath, outPath, { intervalMs = 500 } = {}) {
  writeFileSync(outPath, 'iso\twal_mb\tdb_mb\n');
  const size = (p) => { try { return statSync(p).size; } catch { return 0; } };
  const timer = setInterval(() => {
    try {
      appendFileSync(outPath, `${nowIso()}\t${(size(`${dbPath}-wal`) / 1048576).toFixed(2)}\t${(size(dbPath) / 1048576).toFixed(2)}\n`);
    } catch { /* ignore */ }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Start every probe for one run and return a single stop handle. */
export function startProbes({ baseUrl, daemonPid, dbPath, runDir }) {
  const stops = [
    startHealthProbe(baseUrl, join(runDir, 'health.tsv')),
    startCpuProbe(daemonPid, join(runDir, 'cpu.tsv')),
    startWalProbe(dbPath, join(runDir, 'wal.tsv')),
  ];
  return () => { for (const stop of stops) stop(); };
}
