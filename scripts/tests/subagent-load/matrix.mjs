#!/usr/bin/env node
// Run the whole experiment matrix, one cell at a time, then print the comparison.
//
// SEQUENTIALLY and never in parallel: two runs sharing the box would each see the other's CPU and its
// disk, and the oversubscription question this matrix exists to settle would be unanswerable.
//
//   node scripts/tests/subagent-load/matrix.mjs [--out=/tmp/elowen-load-matrix]
//
// Cells (each is 20 concurrent background delegations against a fresh scratch daemon):
//   A  runner OFF, small tool results          — the pre-runner baseline
//   B  runner OFF, large (~64 KB) tool results — SQLite churn WITHOUT a second process
//   C  runner ON,  small tool results          — a second process WITHOUT the churn
//   D  runner ON,  large tool results          — the production configuration
//   E  runner ON,  large + a bloated parent    — D plus candidate 2 (a large live session in the daemon)
//   F  runner OFF, large + a bloated parent    — E's control: the same daemon-side work, one process

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v = 'true'] = a.replace(/^--/, '').split('=');
  return [k, v];
}));
const outRoot = args.out ?? `/tmp/elowen-load-matrix-${Date.now()}`;
mkdirSync(outRoot, { recursive: true });

const CELLS = [
  ['A-runner-off-small', ['--runner=off', '--size=small']],
  ['B-runner-off-large', ['--runner=off', '--size=large']],
  ['C-runner-on-small', ['--runner=on', '--size=small']],
  ['D-runner-on-large', ['--runner=on', '--size=large']],
  ['E-runner-on-large-bloat', ['--runner=on', '--size=large', '--bloat=3']],
  ['F-runner-off-large-bloat', ['--runner=off', '--size=large', '--bloat=3']],
];

const run = (cmd, argv) => new Promise((resolve) => {
  const child = spawn(cmd, argv, { stdio: 'inherit', cwd: join(here, '../../..') });
  child.on('exit', (code) => resolve(code ?? 1));
});

const dirs = [];
for (const [name, argv] of CELLS) {
  const dir = join(outRoot, name);
  dirs.push(dir);
  const code = await run(process.execPath, [join(here, 'run.mjs'), ...argv, `--label=${name}`, `--out=${dir}`]);
  if (code !== 0) console.error(`!! cell ${name} exited ${code} — its partial data is still in ${dir}`);
  // Let the box settle so one cell's page cache and dying processes are not the next cell's baseline.
  await new Promise((r) => setTimeout(r, 10_000));
}

console.log(`\n\n################ MATRIX: ${outRoot} ################`);
await run(process.execPath, [join(here, 'analyze.mjs'), ...dirs]);
