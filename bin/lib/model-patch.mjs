// Turn the daemon's public config view into a PUT /config patch that adds one model to a provider.
//
// Reads the config on stdin, writes the patch on stdout. Provider entries are sent back WITHOUT a
// key on purpose: configStore re-attaches the stored key by entry id, so the secret never has to
// leave the box to add a model.
const [, , providerId, model] = process.argv;
if (!providerId || !model) {
  console.error('usage: model-patch.mjs <providerId> <model>');
  process.exit(2);
}

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const cfg = JSON.parse(raw);

const providers = cfg.brain?.providers ?? [];
if (!providers.some((p) => p.id === providerId)) {
  console.error(`no provider '${providerId}' configured (have: ${providers.map((p) => p.id).join(', ') || 'none'})`);
  process.exit(1);
}

const next = providers.map(({ apiKeySet, ...p }) => (
  p.id === providerId ? { ...p, models: [...new Set([...p.models, model])] } : p
));

// The brain addresses its own providers as elowen:<providerId>/<model>; without the exec on the
// allow-list the model is configured but cannot actually be selected for an agent.
const exec = `elowen:${providerId}/${model}`;
const allowedExecs = [...new Set([...(cfg.allowedExecs ?? []), exec])];

console.log(JSON.stringify({ brain: { providers: next }, allowedExecs }));
