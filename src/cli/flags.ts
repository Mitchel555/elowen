/** The value following `--name` in an argv slice, or undefined when the flag is absent OR present
 *  without a value. A following token that is itself a flag (`--…`) is never swallowed as this flag's
 *  value: a forgotten argument (`--admin-user --admin-pass secret`, `elowen install --user --agents all`)
 *  reads as absent instead of silently becoming the literal next flag. Pair with `args.includes(name)`
 *  to tell "absent" apart from "present but valueless" when a value is required.
 *
 *  This is THE argv-value reader for the flag-list CLIs (`elowen` dispatch, `elowen install`,
 *  headless `elowen setup`) — they used to carry three near-copies of it, one of which had lost the
 *  swallow guard. `elowen run` parses positionally and keeps its own scanner. */
export function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const next = args[i + 1];
  return next === undefined || next.startsWith('--') ? undefined : next;
}
