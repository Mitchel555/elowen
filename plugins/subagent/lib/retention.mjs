/** How long a FINISHED delegation stays collectable.
 *
 *  A background job and a workflow are two sides of the same promise: the parent turn ends, and a later
 *  turn comes back for the result. Both used to hold their own hour-long constant, so an operator raising
 *  one would silently leave the other expiring at the old bound — which reads to the parent as a workflow
 *  that "never existed". One resolved value governs both.
 *
 *  The bounds MUST mirror the manifest's (`resultRetentionMs` in elowen-plugin.json): the server stores
 *  plugin config without validating it against the schema, so this clamp is the only one there is. */
const DEFAULT_RESULT_RETENTION_MS = 60 * 60_000;
const MIN_RESULT_RETENTION_MS = 10 * 60_000;
const MAX_RESULT_RETENTION_MS = 24 * 60 * 60_000;

/** Clamp the operator-supplied retention; anything missing or malformed falls back to the default. */
export function resolveResultRetentionMs(config) {
  const raw = Number(config?.resultRetentionMs);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_RESULT_RETENTION_MS;
  return Math.min(MAX_RESULT_RETENTION_MS, Math.max(MIN_RESULT_RETENTION_MS, Math.round(raw)));
}
