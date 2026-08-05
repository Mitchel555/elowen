/** Copy text to the system clipboard. Resolves false instead of rejecting when the browser refuses
 *  (missing API, denied permission), so callers can toast a failure instead of leaking an unhandled
 *  promise rejection. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
