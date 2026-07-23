import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';

for (const dir of ['/home/data', '/home/LogFiles/elowen', '/home/project']) {
  mkdirSync(dir, { recursive: true });
}

const children = [
  spawn(process.execPath, ['dist/daemon/index.js'], {
    cwd: '/app',
    env: process.env,
    stdio: 'inherit',
  }),
  spawn(process.execPath, ['web-dist/server.js'], {
    cwd: '/app',
    env: {
      ...process.env,
      HOSTNAME: '0.0.0.0',
      PORT: process.env.PORT ?? '8080',
      ELOWEN_DAEMON_URL: process.env.ELOWEN_DAEMON_URL ?? 'http://127.0.0.1:4400',
    },
    stdio: 'inherit',
  }),
];

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
    console.error(`[azure-start] failed to launch ${child.spawnargs.join(' ')}:`, error);
    stop();
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(`[azure-start] ${child.spawnargs.join(' ')} exited (${signal ?? code ?? 'unknown'})`);
      stop();
      process.exitCode = code ?? 1;
    }
  });
}
