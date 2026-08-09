/** How long a delegated sub-agent may go without ANY sign of life before the watchdog aborts it as
 *  stalled. Liveness is read from the child's own event stream (tool starts, step boundaries), so this is
 *  the ceiling on genuine silence, not on a slow provider answer. A stalled verdict is recoverable through
 *  DelegateContinue, so it is only a safety net for a child wedged forever holding its slot.
 *
 *  Configurable per instance (Settings -> Plugins -> Delegation, `stallMinutes`) and overridable via env
 *  for the end-to-end test and for an operator with a pathologically slow provider. */
const DEFAULT_STALL_MS = 60 * 60_000;
const MIN_STALL_MS = 5 * 60_000;
const MAX_STALL_MS = 240 * 60_000;

/** Resolve the stall timeout in ms. Precedence: ELOWEN_SUBAGENT_TURN_STALL_MS (raw and UNCLAMPED — the
 *  test drives it at 300 ms and an operator may deliberately need a value outside the UI range), then the
 *  plugin config's `stallMinutes` (clamped 5..240 min, same bounds as the manifest), then the default. */
export function resolveStallMs(config) {
  const env = Number(process.env.ELOWEN_SUBAGENT_TURN_STALL_MS);
  if (Number.isFinite(env) && env > 0) return env;
  const raw = Number(config?.stallMinutes);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_STALL_MS;
  return Math.min(MAX_STALL_MS, Math.max(MIN_STALL_MS, Math.round(raw) * 60_000));
}
