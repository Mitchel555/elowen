/** Take the first element of an array under `noUncheckedIndexedAccess` without a non-null assertion.
 *
 *  `list[0]!` is the usual shortcut, but it silences the compiler at the exact spot where a test is most
 *  likely to be wrong: when the render produced nothing, the assertion turns a clear "no slider was
 *  rendered" into a `TypeError` on some later property access, and the failure then points at the wrong
 *  line. Throwing here names what was missing instead. */
export function first<T>(items: readonly T[], what: string): T {
  const [head] = items;
  if (head === undefined) throw new Error(`expected at least one ${what}, found none`);
  return head;
}
