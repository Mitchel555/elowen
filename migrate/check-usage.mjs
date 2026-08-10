// Report the configured brain providers and the most recent assistant turns with their model and
// token/cost accounting. Read-only; run inside the app container.
import { createRequire } from 'node:module';

const Database = createRequire('/app/package.json')('better-sqlite3');
const db = new Database(process.env.DB ?? '/data/db/elowen.db', { readonly: true });

const cfg = JSON.parse(db.prepare('SELECT data FROM settings WHERE id = 1').get().data);

console.log('=== providers ===');
for (const p of cfg.brain?.providers ?? []) {
  console.log(`  ${p.id} | ${p.type} | api=${p.api ?? '(auto)'} | ${p.baseUrl}`);
  console.log(`    models: ${p.models.join(', ')} | klic: ${p.apiKey ? 'nastaven' : 'CHYBI'}`);
}

console.log('\n=== posledni odpovedi ===');
const rows = db.prepare(`
  SELECT session_id,
         json_extract(content, '$.model')        AS model,
         json_extract(content, '$.usage.input')  AS input,
         json_extract(content, '$.usage.output') AS output,
         json_extract(content, '$.cost.total')   AS cost
  FROM brain_messages
  WHERE role = 'assistant'
  ORDER BY id DESC
  LIMIT 6
`).all();

if (rows.length === 0) console.log('  (zadne)');
for (const r of rows) {
  console.log(`  ${r.model ?? '?'} | in ${r.input ?? '-'} / out ${r.output ?? '-'} | cost ${r.cost ?? '-'} | ${r.session_id}`);
}

console.log('\n=== zbyle docasne tokeny (ma byt 0) ===');
console.log(' ', db.prepare('SELECT COUNT(*) c FROM auth_tokens').get().c);
