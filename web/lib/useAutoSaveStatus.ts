'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Debounced auto-persist with a visible status, stale-response protection, and a flush hook — the
 * Shared race-safe auto-save controller. Runs `save` shortly after any of `deps` change, but never
 * for the seed value; `ready` gates it until the form has been seeded from the server.
 *
 * - `status`: 'idle' | 'saving' | 'saved' | 'error' — render it in the modal footer.
 * - serialized writes: when another edit lands during an in-flight request, exactly one follow-up
 *   write with the latest form state runs after it. This prevents an older request from finishing
 *   last and overwriting a newer value on the server.
 * - `flush()`: run any pending debounced save immediately (call it before closing the modal). It also
 *   runs automatically on unmount, so a change made moments before close is never silently dropped.
 * - `retry()`: re-run the save after a failure.
 *
 * `savable` is the form's VALIDITY, and it is a separate knob from `ready` on purpose: `ready` says the
 * form has been seeded (so the seed value itself is never written back), while `savable` says the current
 * value is worth writing. Folding validity into `ready` looks equivalent and is not — a form that is
 * seeded locally and only becomes valid once the user finishes typing would have its first valid edit
 * consumed as the "seed run" and never persisted. While the form is invalid the save is held (and any
 * pending one cancelled), so the status never claims a save that did not happen.
 */
export function useAutoSaveStatus(
  deps: readonly unknown[],
  save: () => Promise<void> | void,
  opts: { ready?: boolean; savable?: boolean; delay?: number } = {},
): { status: SaveStatus; retry: () => void; flush: () => void } {
  const { ready = true, savable = true, delay = 800 } = opts;
  const seeded = useRef(false);
  const saveRef = useRef(save);
  saveRef.current = save;
  const [status, setStatus] = useState<SaveStatus>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef(false);
  const running = useRef(false);
  const queued = useRef(false);
  // The unmount flush deliberately leaves a save in flight after the component is gone, so its result
  // lands on a hook nobody renders any more. Reporting into that void is not just wasted work: the write
  // can outlive the whole page/test environment, and touching React's scheduler that late throws.
  const mounted = useRef(true);

  const run = useCallback(() => {
    pending.current = false;
    queued.current = true;
    if (mounted.current) setStatus('saving');
    if (running.current) return;

    running.current = true;
    void (async () => {
      let terminal: SaveStatus = 'saved';
      // A rapid burst never creates a request pile-up: changes made while saving collapse into one
      // queued pass, and that pass reads the latest callback/state through saveRef.
      while (queued.current) {
        queued.current = false;
        try {
          await saveRef.current();
          terminal = 'saved';
        } catch {
          terminal = 'error';
        }
      }
      running.current = false;
      if (mounted.current) setStatus(terminal);
    })();
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (!seeded.current) { seeded.current = true; return; } // consume the seed run
    if (!savable) { // an invalid value is not a save waiting to happen — drop the pending one
      if (timer.current) clearTimeout(timer.current);
      pending.current = false;
      return;
    }
    pending.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(run, delay);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, savable, run, delay, ...deps]);

  const flush = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (pending.current) run();
  }, [run]);

  // Flush a pending save on unmount so closing the modal never drops the last edit. The flag is cleared
  // in the same cleanup, immediately before the flush, so the write still happens while its now-invisible
  // status updates are dropped — and no ordering between separate effect cleanups has to hold for that.
  useEffect(() => () => { mounted.current = false; flush(); }, [flush]);

  const retry = useCallback(() => run(), [run]);
  return { status, retry, flush };
}
