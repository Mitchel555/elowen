import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir, dbPath, logDir, runFile } from '../shared/paths.js';

interface Svc { pid: number; port: number }
export interface RunState { daemon: Svc; web: Svc; version: string; startedAt: string }
export interface SvcStatus { running: boolean; pid: number | null; port: number; healthy: boolean }

const DAEMON_PORT = 4400;
const WEB_PORT = 4500;

/** Read the tracked run state, or null when absent/corrupt. A corrupt file (partial write, manual
 *  edit) must not throw — the caller treats null as "nothing running" and can re-start cleanly. */
export function readState(env: NodeJS.ProcessEnv): RunState | null {
  try { return JSON.parse(readFileSync(runFile(env), 'utf8')) as RunState; }
  catch { return null; }
}

export function writeState(env: NodeJS.ProcessEnv, state: RunState): void {
  mkdirSync(dataDir(env), { recursive: true });
  writeFileSync(runFile(env), JSON.stringify(state, null, 2), 'utf8');
}

export function clearState(env: NodeJS.ProcessEnv): void {
  rmSync(runFile(env), { force: true });
}

/** Liveness via signal 0: it delivers nothing but still does the permission/existence check. ESRCH
 *  means gone; EPERM means alive but owned by another user (still "alive" for our purposes). */
export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Which tracked service a pid claims to be — its entry script is the birth-identity marker. */
export type ServiceMark = 'daemon' | 'web';
const ENTRY_MARK: Record<ServiceMark, string> = { daemon: 'daemon/index.js', web: 'web-dist/server.js' };

/** A pid liveness+identity predicate; injectable so tests need not mint real daemon processes. */
export type IsTracked = (pid: number, mark: ServiceMark) => boolean;

/** Whether a tracked pid is STILL our service, not an unrelated pid that reused the number after a
 *  reboot/crash. A bare `isAlive` check is not enough: run.json survives a reboot, the OS recycles pids,
 *  and `stop` would then SIGTERM an innocent process while `start` would adopt it as "already running"
 *  and never spawn. On Linux we birth-validate by matching the procfs argv against the service's entry
 *  script; a dead pid, or one whose argv doesn't carry the entry, is "not ours". Off Linux there is no
 *  /proc, so this falls back to liveness alone (best effort — documented). */
export function isTrackedService(pid: number, mark: ServiceMark): boolean {
  if (!isAlive(pid)) return false;
  if (process.platform !== 'linux') return true; // no procfs — liveness is all we have
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); // NUL-separated argv
    return cmdline.split('\0').some((arg) => arg.includes(ENTRY_MARK[mark]));
  } catch {
    return false; // /proc unreadable or the pid vanished mid-check → cannot confirm it is ours
  }
}

/** GET `url` and report whether it answered 2xx within `timeoutMs` — the single readiness probe shared by
 *  every CLI health check (this launcher's own start/stop/status, `ensureDaemon`'s auto-spawn in
 *  index.ts, and the installer's post-provision wait). A response is required to be `ok`: an unhealthy
 *  500 must not read as "up" the way a bare non-throwing fetch would, and the bounded per-request timeout
 *  keeps a half-open local connection from blocking an ordinary command instead of just failing it. */
export async function urlHealthy(url: string, fetchFn: typeof fetch = fetch, timeoutMs = 3000): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return (await fetchFn(url, { signal: ctrl.signal })).ok; }
  catch { return false; }
  finally { clearTimeout(timer); }
}

async function portHealthy(fetchFn: typeof fetch, port: number, path: string): Promise<boolean> {
  return urlHealthy(`http://127.0.0.1:${port}${path}`, fetchFn);
}

/** Status of both services: a service is `running` when its tracked pid is alive, and `healthy` when
 *  its port also answers (a recycled pid or a wedged process is running-but-unhealthy). */
export async function status(env: NodeJS.ProcessEnv, fetchFn: typeof fetch = fetch, isTracked: IsTracked = isTrackedService): Promise<{ daemon: SvcStatus; web: SvcStatus }> {
  const state = readState(env);
  const of = async (svc: Svc | undefined, path: string, mark: ServiceMark): Promise<SvcStatus> => {
    if (!svc) return { running: false, pid: null, port: 0, healthy: false };
    const running = isTracked(svc.pid, mark);
    const healthy = running && await portHealthy(fetchFn, svc.port, path);
    return { running, pid: svc.pid, port: svc.port, healthy };
  };
  return { daemon: await of(state?.daemon, '/health', 'daemon'), web: await of(state?.web, '/', 'web') };
}

export interface StopDeps {
  kill?: (pid: number, signal?: NodeJS.Signals | number) => void;
  fetch?: typeof fetch;
  isTracked?: IsTracked;
  /** ms between liveness/port polls and how many attempts before giving up on a signalled service. */
  pollMs?: number;
  attempts?: number;
}

/** Stop both tracked services and forget them — but only once they are actually GONE: SIGTERM is not a
 *  promise, and reporting success while a process is still shutting down (or its port still answers) is
 *  how `down` used to lie and a following `up` collided with it. Waits, bounded, for each signalled
 *  service's pid to die AND its port to stop answering before clearing run.json; on timeout the state is
 *  left in place (so the next `down`/`status` still sees it) and an error is thrown instead of a silent
 *  false success. A recycled/unrelated pid is never signalled or waited on. */
export async function stop(env: NodeJS.ProcessEnv, deps: StopDeps = {}): Promise<void> {
  const kill = deps.kill ?? ((pid: number, signal?: NodeJS.Signals | number) => process.kill(pid, signal));
  const fetchFn = deps.fetch ?? fetch;
  const isTracked = deps.isTracked ?? isTrackedService;
  const pollMs = deps.pollMs ?? 200;
  const attempts = deps.attempts ?? 25; // ~5s by default
  const state = readState(env);
  if (!state) return;

  let pending: { mark: ServiceMark; svc: Svc; path: string }[] = [];
  for (const [svc, mark, path] of [[state.daemon, 'daemon', '/health'], [state.web, 'web', '/']] as const) {
    if (!isTracked(svc.pid, mark)) continue; // not our service — never signalled, never waited on
    try { kill(svc.pid, 'SIGTERM'); } catch { /* raced to exit — still worth confirming below */ }
    pending.push({ mark, svc, path });
  }

  const stillUp = async (t: { svc: Svc; path: string }): Promise<boolean> =>
    isAlive(t.svc.pid) || await portHealthy(fetchFn, t.svc.port, t.path);

  for (let i = 0; i < attempts && pending.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, pollMs));
    const next: typeof pending = [];
    for (const t of pending) if (await stillUp(t)) next.push(t);
    pending = next;
  }
  if (pending.length) {
    throw new Error(`elowen down: ${pending.map((t) => t.mark).join(' and ')} did not stop within ${Math.round((attempts * pollMs) / 1000)}s (pid still alive or the port still answers) — state left in place, retry \`elowen down\``);
  }
  clearState(env);
}

export interface StartDeps {
  spawn?: typeof nodeSpawn;
  fetch?: typeof fetch;
  version: string;
  now?: () => string;
  /** ms between health polls and how many attempts before giving up. */
  pollMs?: number;
  attempts?: number;
  /** Pid liveness+identity check; injectable for tests (defaults to the procfs birth-validation). */
  isTracked?: IsTracked;
  /** ms between lock-acquisition retries and how many attempts before giving up when a concurrent
   *  start() already holds the lock. Injectable for tests. */
  lockPollMs?: number;
  lockAttempts?: number;
}

const here = dirname(fileURLToPath(import.meta.url)); // dist/cli at runtime
const daemonEntry = () => join(here, '..', 'daemon', 'index.js');    // dist/daemon/index.js
const webServer = () => join(here, '..', '..', 'web-dist', 'server.js'); // <pkg>/web-dist/server.js (Next standalone)

/** Serialises concurrent `start()` calls (e.g. the menu's "up" racing the hourly auto-update's fallback
 *  restart) so two invocations never both see "nothing tracked" for the same port and both decide to
 *  spawn. A stale lock — its recorded pid is gone — is reclaimed rather than left to jam every future
 *  `elowen up` after a hard crash between acquiring it and releasing it. */
async function acquireStartLock(env: NodeJS.ProcessEnv, pollMs: number, attempts: number): Promise<() => void> {
  mkdirSync(dataDir(env), { recursive: true });
  const lockPath = join(dataDir(env), 'start.lock');
  for (let i = 0; i < attempts; i++) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return () => { try { rmSync(lockPath, { force: true }); } catch { /* already gone */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let holder = NaN;
      try { holder = Number(readFileSync(lockPath, 'utf8').trim()); } catch { /* vanished mid-check — retry immediately below */ }
      if (!Number.isInteger(holder) || !isAlive(holder)) { try { rmSync(lockPath, { force: true }); } catch { /* raced with the holder's own release */ } continue; }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  throw new Error('another `elowen up` is already in progress — try again in a moment');
}

/** Start daemon + web as detached background processes and record their pids. Idempotent-ish: a tracked,
 *  still-alive pid is adopted rather than re-spawned. Locked against concurrent start() calls, and both
 *  services must answer healthy before this reports success. */
export async function start(env: NodeJS.ProcessEnv, deps: StartDeps): Promise<RunState> {
  const release = await acquireStartLock(env, deps.lockPollMs ?? 100, deps.lockAttempts ?? 50);
  try { return await startLocked(env, deps); }
  finally { release(); }
}

async function startLocked(env: NodeJS.ProcessEnv, deps: StartDeps): Promise<RunState> {
  const spawn = deps.spawn ?? nodeSpawn;
  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date().toISOString());
  const pollMs = deps.pollMs ?? 200;
  const attempts = deps.attempts ?? 100;
  // Ports are overridable (ELOWEN_PORT / ELOWEN_WEB_PORT) so a second instance — or a smoke test — can run
  // alongside an existing one. Defaults are the conventional 4400/4500.
  const daemonPort = Number((env.ELOWEN_PORT) ?? DAEMON_PORT);
  const webPort = Number((env.ELOWEN_WEB_PORT) ?? WEB_PORT);
  const childEnv = { ...env, ELOWEN_DB: dbPath(env), ELOWEN_LOG_DIR: logDir(env), ELOWEN_AUTOSTART: '0' };

  const launch = (entry: string, extra: NodeJS.ProcessEnv) => {
    const child = spawn(process.execPath, [entry], { detached: true, stdio: 'ignore', env: { ...childEnv, ...extra } });
    child.unref();
    if (!child.pid) throw new Error(`failed to spawn ${entry}`);
    return child.pid;
  };

  const isTracked = deps.isTracked ?? isTrackedService;
  const existing = readState(env);
  // Adopt a tracked pid only when it is confirmably STILL our service; a stale run.json (e.g. after a
  // reboot that recycled the pid) must not adopt a stranger. But it must not blindly spawn either: with
  // nothing tracked, a port that ALREADY answers healthy is some other live process (a systemd-managed
  // instance, or a start() that raced past this one's lock) — colliding with it is worse than refusing.
  const resolvePid = async (entry: string, port: number, healthPath: string, mark: ServiceMark, extra: NodeJS.ProcessEnv): Promise<number> => {
    const tracked = mark === 'daemon' ? existing?.daemon : existing?.web;
    if (tracked && isTracked(tracked.pid, mark)) return tracked.pid;
    if (await portHealthy(fetchFn, port, healthPath)) {
      throw new Error(`:${port} already answers healthily but isn't a tracked elowen ${mark} — refusing to spawn a second one (stop the other process, or remove ${runFile(env)} if it is stale)`);
    }
    return launch(entry, extra);
  };
  const daemonPid = await resolvePid(daemonEntry(), daemonPort, '/health', 'daemon', { ELOWEN_PORT: String(daemonPort) });
  const webPid = await resolvePid(webServer(), webPort, '/', 'web', { PORT: String(webPort), HOSTNAME: '127.0.0.1', ELOWEN_DAEMON_URL: `http://127.0.0.1:${daemonPort}` });

  // Wait for BOTH services to answer — a live daemon with a dead web must not report `elowen up` as a
  // success. The web proxies the daemon, so it's polled second within the same shared budget.
  let daemonHealthy = false, webHealthy = false;
  for (let i = 0; i < attempts && !(daemonHealthy && webHealthy); i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, pollMs));
    if (!daemonHealthy) daemonHealthy = await portHealthy(fetchFn, daemonPort, '/health');
    if (daemonHealthy && !webHealthy) webHealthy = await portHealthy(fetchFn, webPort, '/');
  }

  // Record state even on failure so `elowen down`/`status` can see and clean up the spawned pids.
  const state: RunState = { daemon: { pid: daemonPid, port: daemonPort }, web: { pid: webPid, port: webPort }, version: deps.version, startedAt: now() };
  writeState(env, state);
  // But never report success when a service never answered: a wedged or crash-looping daemon (or a web
  // that failed to boot behind a healthy daemon) would otherwise be written as "elowen is up". Surface it
  // so the operator knows to check the logs.
  const budget = Math.round((attempts * pollMs) / 1000);
  if (!daemonHealthy) throw new Error(`elowen daemon did not become healthy on :${daemonPort} after ${budget}s — check the logs in ${logDir(env)}`);
  if (!webHealthy) throw new Error(`elowen web did not become healthy on :${webPort} after ${budget}s — check the logs in ${logDir(env)}`);
  return state;
}
