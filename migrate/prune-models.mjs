// Drop model/exec entries that reference providers this install does not have.
//
// Settings copied from another install carry its whole model landscape: execs for Anthropic, Codex,
// OpenRouter and local CLI binaries that are not installed here. Most of it is only picker noise, but
// defaults.exec and the autopilot execs are load-bearing — pointing them at a missing binary makes
// agent spawning fail at the moment it is first used.
//
// What survives is derived from the configured providers, so this stays correct as providers change.
import { createRequire } from 'node:module';

const Database = createRequire('/app/package.json')('better-sqlite3');
const DB = process.env.DB_PATH ?? '/data/db/elowen.db';
const db = new Database(DB);

const row = db.prepare('SELECT data FROM settings WHERE id = 1').get();
const cfg = JSON.parse(row.data);

const backupPath = `${DB}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
await db.backup(backupPath);
console.log(`zaloha: ${backupPath}`);

const providers = cfg.brain?.providers ?? [];
// The exec form the brain understands for its own providers: elowen:<providerId>/<model>.
const validExecs = new Set(providers.flatMap((p) => p.models.map((m) => `elowen:${p.id}/${m}`)));
const validWindowKeys = new Set(providers.flatMap((p) => p.models.map((m) => `${p.id}/${m}`)));

if (validExecs.size === 0) throw new Error('no configured provider models — refusing to prune everything');

const before = {
  allowedExecs: (cfg.allowedExecs ?? []).length,
  customModels: (cfg.customModels ?? []).length,
  hiddenPresets: (cfg.hiddenPresets ?? []).length,
  modelNotes: Object.keys(cfg.modelNotes ?? {}).length,
  windows: Object.keys(cfg.brain?.modelContextWindows ?? {}).length,
};

cfg.allowedExecs = (cfg.allowedExecs ?? []).filter((e) => validExecs.has(e));
cfg.customModels = (cfg.customModels ?? []).filter((m) => validExecs.has(m.exec));

// hiddenPresets is a HIDE list, not an allow list: the web ships EXEC_PRESETS (mirroring KNOWN_EXECS)
// hardcoded and renders every one of them unless it appears here. None of those built-ins can run
// without their own provider or CLI binary, so anything unbacked has to be ADDED, not removed —
// emptying this list is what makes Sonnet, Opus and the Ollama presets reappear in the picker.
const { KNOWN_EXECS } = await import('/app/dist/shared/execs.js');
cfg.hiddenPresets = [...new Set([
  ...(cfg.hiddenPresets ?? []),
  ...KNOWN_EXECS.filter((e) => !validExecs.has(e)),
])];
cfg.modelNotes = Object.fromEntries(
  Object.entries(cfg.modelNotes ?? {}).filter(([k]) => validExecs.has(k) || validWindowKeys.has(k)),
);
if (cfg.brain?.modelContextWindows) {
  cfg.brain.modelContextWindows = Object.fromEntries(
    Object.entries(cfg.brain.modelContextWindows).filter(([k]) => validWindowKeys.has(k)),
  );
}

const fallbackExec = [...validExecs][0];
const fallbackModel = providers[0].models[0];

if (!validExecs.has(cfg.defaults?.exec)) {
  console.log(`defaults.exec: ${cfg.defaults?.exec} -> ${fallbackExec}`);
  cfg.defaults = { ...cfg.defaults, exec: fallbackExec };
}

const a = cfg.autopilot;
if (a) {
  for (const key of ['pilotExec', 'overseerExec']) {
    if (!validExecs.has(a[key])) { console.log(`autopilot.${key}: ${a[key]} -> ${fallbackExec}`); a[key] = fallbackExec; }
  }
  for (const key of ['model', 'overseerModel']) {
    if (a[key] !== fallbackModel) { console.log(`autopilot.${key}: ${a[key]} -> ${fallbackModel}`); a[key] = fallbackModel; }
  }
}

db.prepare('UPDATE settings SET data = ? WHERE id = 1').run(JSON.stringify(cfg));
db.close();

console.log('\npocty pred -> po:');
console.log(`  allowedExecs   ${before.allowedExecs} -> ${cfg.allowedExecs.length}`);
console.log(`  customModels   ${before.customModels} -> ${cfg.customModels.length}`);
console.log(`  hiddenPresets  ${before.hiddenPresets} -> ${cfg.hiddenPresets.length}`);
console.log(`  modelNotes     ${before.modelNotes} -> ${Object.keys(cfg.modelNotes).length}`);
console.log(`  contextWindows ${before.windows} -> ${Object.keys(cfg.brain?.modelContextWindows ?? {}).length}`);
console.log(`\nzustava: ${[...validExecs].join(', ')}`);
