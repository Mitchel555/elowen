// Provider ↔ exec-string mapping. Mirrors the daemon's src/overseer/routing.ts so the UI
// shows and edits the SAME provider the spawn path will actually resolve.
import type { BrainModelOption } from './types';

export type ProviderId = 'claude-code' | 'opencode' | 'codex' | 'kilo' | 'pi' | 'omp' | 'elowen';

/** Short auth-source chip for a brain model (mirrors the `source` the daemon derives from how the model is
 *  reachable). The ONE source for every model picker so the chip set never drifts between them. */
export const SOURCE_BADGE: Record<BrainModelOption['source'], string> = {
  oauth: 'OAuth',
  'api-key': 'API',
  relay: 'Relay',
};

/** Explicit `<prefix>:<model>` spec prefixes, in match order, mapped to their provider. Mirrors the
 *  daemon's PROGRAM_PREFIXES (src/shared/execs.ts) so the UI parses execs the same way spawn does. */
const PROVIDER_PREFIXES: readonly [string, ProviderId][] = [
  ['elowen:', 'elowen'],
  ['codex:', 'codex'],
  ['opencode:', 'opencode'],
  ['claude:', 'claude-code'],
  ['kilo:', 'kilo'],
  ['pi:', 'pi'],
  ['omp:', 'omp'],
];

/** Which program runs this exec string (same heuristic as resolveExecutor). */
export function execProvider(exec: string): ProviderId {
  for (const [prefix, provider] of PROVIDER_PREFIXES) {
    if (exec.startsWith(prefix)) return provider;
  }
  if (exec.includes('/')) return 'opencode';
  return 'claude-code';
}

/** The bare model id with any provider prefix stripped (for display/edit). */
export function execModel(exec: string): string {
  for (const [prefix] of PROVIDER_PREFIXES) {
    if (exec.startsWith(prefix)) return exec.slice(prefix.length);
  }
  return exec; // slash form or bare — the model id is the whole string
}

/** Prefix for the providers whose exec format is "just prepend the prefix" — derived from the parse table
 *  above so a new PROVIDER_PREFIXES entry works through buildExec without a matching branch here. */
const PREFIX_BY_PROVIDER: Record<string, string> = Object.fromEntries(
  PROVIDER_PREFIXES.map(([prefix, provider]) => [provider, prefix]),
);

/** Compose an exec string from a chosen provider + bare model id (inverse of the parse above). opencode
 *  and claude-code are the only two whose format genuinely differs (bare unless a slash would otherwise
 *  mean the other program), so they stay explicit; every other provider just gets its table prefix. */
export function buildExec(provider: ProviderId, model: string): string {
  const m = model.trim();
  if (provider === 'opencode') return m.includes('/') ? m : `opencode:${m}`;
  // claude-code: bare resolves to claude; prefix only when a slash would otherwise mean opencode
  if (provider === 'claude-code') return m.includes('/') ? `claude:${m}` : m;
  return `${PREFIX_BY_PROVIDER[provider]}${m}`;
}
