/** The value of `--name` in an argv slice, from either accepted form:
 *   - `--name value`  — a following token that is itself a flag (`--…`) is NEVER swallowed, so a forgotten
 *                       argument (`--admin-user --admin-pass secret`) reads as valueless instead of
 *                       silently becoming the literal next flag;
 *   - `--name=value`  — unambiguous, and the ONLY way to pass a value that itself starts with `--`
 *                       (e.g. a password `--secret`), which the guard above would otherwise reject.
 *  Returns undefined when the flag is absent OR present without a value. Pair with `requireFlagValues`
 *  (or `args.includes(name)`) to tell those two apart wherever a missing value must not become a default.
 *
 *  This is THE argv-value reader for the flag-list CLIs (`elowen` dispatch, `elowen install`,
 *  headless `elowen setup`) — they used to carry three near-copies of it, one of which had lost the
 *  swallow guard. `elowen run` parses positionally and keeps its own scanner. */
export function flagValue(args: string[], name: string): string | undefined {
  const inline = args.find((a) => a.startsWith(`${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const next = args[i + 1];
  return next === undefined || next.startsWith('--') ? undefined : next;
}

/** Whether `--name` was written at all, in either form. */
function flagPresent(args: string[], name: string): boolean {
  return args.some((a) => a === name || a.startsWith(`${name}=`));
}

/** Reject flags that were written without a value. A valueless flag reads the same as an absent one, and
 *  for an unattended run that silence is the dangerous outcome: `--user --agents all` would provision the
 *  DEFAULT service user and `--domain --no-tls` would quietly fall back to localhost, both reported as
 *  success. Fail the parse instead, and point at the `--name=value` form for values starting with `--`.
 *
 *  An EMPTY value (`--admin-pass=`) is rejected the same way: no flag on these CLIs takes "" as an
 *  answer, and it slipped past a `!== undefined` pair check while still reading falsy downstream —
 *  `--admin-user=x --admin-pass=` installed a box with no admin account and called it a success. */
export function requireFlagValues(args: string[], names: readonly string[]): void {
  const missing = names.filter((n) => flagPresent(args, n) && !flagValue(args, n));
  if (!missing.length) return;
  throw new Error(`missing value for ${missing.join(', ')} — write \`--flag value\`, or \`--flag=value\` when the value itself starts with \`--\``);
}
