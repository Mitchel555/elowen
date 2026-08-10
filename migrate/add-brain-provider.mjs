// Add (or replace) a brain provider entry. The API key arrives through the environment so it never
// lands in a file, a command line or the repository.
//
// Runs against a STOPPED daemon from a one-off container, like apply-config.mjs. The entry is placed
// FIRST because resolveBrainModelRoute falls back to providers[0] and that entry's models[0] — so the
// first entry and its first model are what an unpinned session runs on.
import { createRequire } from 'node:module';

const Database = createRequire('/app/package.json')('better-sqlite3');

const DB = process.env.DB_PATH ?? '/data/db/elowen.db';
const id = process.env.PROVIDER_ID;
const label = process.env.LABEL ?? id;
const baseUrl = process.env.BASE_URL;
const model = process.env.MODEL;
const apiKey = process.env.AZ_KEY;

for (const [name, value] of Object.entries({ PROVIDER_ID: id, BASE_URL: baseUrl, MODEL: model, AZ_KEY: apiKey })) {
  if (!value) throw new Error(`${name} missing`);
}

const db = new Database(DB);
const row = db.prepare('SELECT data FROM settings WHERE id = 1').get();
if (!row) throw new Error('no settings row');
const cfg = JSON.parse(row.data);

const backupPath = `${DB}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
await db.backup(backupPath);
console.log(`zaloha: ${backupPath}`);

// Pinned rather than auto-detected: openAiApiFor only picks Responses for api.openai.com, so any
// other endpoint would silently land on Chat Completions. Azure's newer reasoning models reject
// function tools there ("please use /v1/responses instead"), so the mode has to be explicit.
const api = process.env.API_MODE ?? 'openai-completions';
if (!['openai-completions', 'openai-responses'].includes(api)) {
  throw new Error(`API_MODE must be openai-completions or openai-responses, got ${api}`);
}

const entry = {
  id,
  label,
  type: 'openai',
  baseUrl,
  models: [model],
  api,
  apiKey,
};

cfg.brain = cfg.brain ?? {};
const rest = (cfg.brain.providers ?? []).filter((p) => p.id !== id);
cfg.brain.providers = [entry, ...rest];

db.prepare('UPDATE settings SET data = ? WHERE id = 1').run(JSON.stringify(cfg));
db.close();

console.log(`provider '${id}' zapsan jako prvni z ${cfg.brain.providers.length}`);
console.log(`baseUrl: ${baseUrl}`);
console.log(`model:   ${model}`);
console.log(`apiKey:  nastaven (${apiKey.length} znaku, nevypisuji)`);
