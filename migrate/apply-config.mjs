// Overlay the system/limits settings exported from another Elowen install onto this one.
//
// Runs against a STOPPED daemon (a one-off container against the data volume) so nothing races the
// config the daemon holds in memory. Credential-bearing blocks on the target — providers, apiKey,
// ghToken, webPush, plugins and brain.providers — are never touched, and the write is refused if
// any of them would change.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

// This script is mounted outside /app, so resolve the driver out of the app install explicitly.
const Database = createRequire('/app/package.json')('better-sqlite3');

const DB = process.env.DB_PATH ?? '/data/db/elowen.db';
const SOURCE = process.env.SOURCE ?? '/migrate/elowen-config-sanitized.json';

const incoming = JSON.parse(readFileSync(SOURCE, 'utf8'));
const db = new Database(DB);

const row = db.prepare('SELECT data FROM settings WHERE id = 1').get();
if (!row) throw new Error('no settings row on the target database');
const current = JSON.parse(row.data);

const backupPath = `${DB}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
await db.backup(backupPath);
console.log(`zaloha: ${backupPath}`);

const PRESERVED = ['providers', 'apiKey', 'ghToken', 'webPush', 'plugins'];
const before = Object.fromEntries(PRESERVED.map((k) => [k, JSON.stringify(current[k] ?? null)]));
const providersBefore = JSON.stringify(current.brain?.providers ?? []);

const merged = { ...current };
const applied = [];

for (const [key, value] of Object.entries(incoming)) {
  if (key === 'brain') continue;
  merged[key] = value;
  applied.push(key);
}

// brain: overlay the tuning knobs, keep the target's own provider entries.
if (incoming.brain) {
  merged.brain = { ...current.brain, ...incoming.brain, providers: current.brain?.providers ?? [] };
  applied.push('brain(bez providers)');
}

for (const key of PRESERVED) {
  if (JSON.stringify(merged[key] ?? null) !== before[key]) {
    throw new Error(`refusing to write: ${key} would have changed`);
  }
}
if (JSON.stringify(merged.brain?.providers ?? []) !== providersBefore) {
  throw new Error('refusing to write: brain.providers would have changed');
}

db.prepare('UPDATE settings SET data = ? WHERE id = 1').run(JSON.stringify(merged));
db.close();

console.log(`preneseno: ${applied.join(', ')}`);
console.log(`zachovano: ${PRESERVED.join(', ')}, brain.providers (${JSON.parse(providersBefore).length} zaznamu)`);
