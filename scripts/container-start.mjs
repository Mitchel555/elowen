// Container entrypoint: runs the daemon and the standalone web server side by side under one PID 1
// and forwards shutdown signals so the daemon can drain in-flight turns before the container dies.
//
// Derived from scripts/azure-start.mjs (Michal Stoklasa). Differences: state directories are derived
// from the environment instead of hardcoded /home paths, and the web server is stopped before the
// daemon so no new request enters while the daemon is draining.
//
// The drain budget is ~10 minutes, so compose must grant at least that with stop_grace_period.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';

const dbPath = process.env.ELOWEN_DB ?? '/data/db/elowen.db';
const logDir = process.env.ELOWEN_LOG_DIR ?? '/data/logs';
const projectPath = process.env.ELOWEN_PROJECT_PATH ?? '/data/project';

for (const dir of [dirname(dbPath), logDir, projectPath]) {
  mkdirSync(dir, { recursive: true });
}

const daemon = spawn(process.execPath, ['dist/daemon/index.js'], {
  cwd: '/app',
  env: process.env,
  stdio: 'inherit',
});

const web = spawn(process.execPath, ['web-dist/server.js'], {
  cwd: '/app',
  env: {
    ...process.env,
    HOSTNAME: '0.0.0.0',
    PORT: process.env.ELOWEN_WEB_PORT ?? '4500',
    ELOWEN_DAEMON_URL: process.env.ELOWEN_DAEMON_URL ?? 'http://127.0.0.1:4400',
  },
  stdio: 'inherit',
});

// Ordered: the web server goes down first, the daemon last, so the daemon gets the whole
// grace period to finish running turns instead of racing the proxy for it.
const children = [web, daemon];
let stopping = false;

function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(signal));
}

for (const child of children) {
  child.on('error', (error) => {
    console.error(`[start] failed to launch ${child.spawnargs.join(' ')}:`, error);
    stop();
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    // An unexpected exit of either half means the container is broken; take the whole thing
    // down so the restart policy replaces it rather than leaving a half-dead deployment up.
    if (!stopping) {
      console.error(`[start] ${child.spawnargs.join(' ')} exited (${signal ?? code ?? 'unknown'})`);
      stop();
      process.exitCode = code ?? 1;
    }
  });
}
