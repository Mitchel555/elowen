import { describe, it, expect, afterEach, vi } from 'vitest';
import { installGracefulShutdown } from '../../src/daemon/bootstrap.js';
import type { BrainService } from '../../src/brain/brainService.js';

/** A brain whose in-flight work follows a scripted sequence, one entry consumed per busy() call. The last
 *  entry repeats, so a test can end on "still busy" to exercise the budget expiring.
 *
 *  `reads` counts busy() calls, which is what actually proves the handler WAITED: asserting only on the
 *  exit code passes just as happily when the wait loop is deleted entirely. */
type Busy = { turns: number; children: number; undelivered?: number };
const brainBusy = (sequence: Busy[], sent?: string[]) => {
  const state = { reads: 0 };
  const brain = ({
    busy: () => ({ undelivered: 0, ...sequence[Math.min(state.reads++, sequence.length - 1)] }),
    notify: async (text: string) => { sent?.push(text); },
  }) as unknown as BrainService;
  return { brain, state };
};

const silentLog = { info: () => { /* quiet */ }, error: () => { /* quiet */ } };

describe('installGracefulShutdown — a stop waits for running work instead of cutting it off', () => {
  afterEach(() => { process.removeAllListeners('SIGTERM'); process.removeAllListeners('SIGINT'); });

  /** Install, raise the signal, and resolve once the handler has called exit. */
  const runSignal = async (brain: BrainService, opts?: Parameters<typeof installGracefulShutdown>[2]) => {
    const exited: number[] = [];
    await new Promise<void>((resolve) => {
      installGracefulShutdown(brain, silentLog, {
        pollMs: 1, drainMs: 200, notify: false, ...opts,
        exit: ((code: number) => { exited.push(code); resolve(); }) as never,
      });
      process.emit('SIGTERM');
    });
    return exited;
  };

  it('exits immediately when nothing is running', async () => {
    const { brain, state } = brainBusy([{ turns: 0, children: 0 }]);
    expect(await runSignal(brain)).toEqual([0]);
    expect(state.reads).toBe(2); // the announcement's read + one loop check that found it idle
  });

  it('keeps re-checking until the running turn finishes, and only then exits', async () => {
    const { brain, state } = brainBusy([
      { turns: 1, children: 0 }, // the announcement's own read
      { turns: 1, children: 0 },
      { turns: 1, children: 0 },
      { turns: 0, children: 0 }, // turn finished
    ]);
    expect(await runSignal(brain)).toEqual([0]);
    // The whole point: it polled until the work went away. Anything less means it exited mid-turn.
    expect(state.reads).toBe(4);
  });

  it('waits for a delegated sub-agent just as it waits for a turn', async () => {
    const { brain, state } = brainBusy([
      { turns: 0, children: 2 },
      { turns: 0, children: 1 },
      { turns: 0, children: 0 },
    ]);
    expect(await runSignal(brain)).toEqual([0]);
    expect(state.reads).toBe(3);
  });

  // The regression Filip hit: the sub-agent had FINISHED, so turns and children both read zero, but its
  // answer had not yet reached the parent turn. Exiting there loses a completed delegation's result.
  it('waits for a finished sub-agent to actually hand its result to the parent', async () => {
    const { brain, state } = brainBusy([
      { turns: 0, children: 0, undelivered: 1 },
      { turns: 0, children: 0, undelivered: 1 },
      { turns: 0, children: 0, undelivered: 0 }, // parent turn took it
    ]);
    expect(await runSignal(brain)).toEqual([0]);
    expect(state.reads).toBe(3);
  });

  it('gives up and exits cleanly when the drain budget expires, rather than hanging until SIGKILL', async () => {
    // Never goes idle. systemd would SIGKILL at 90s, which is the outcome the drain exists to avoid, so
    // the budget has to end the wait on our own terms.
    const { brain } = brainBusy([{ turns: 1, children: 0 }]);
    const exited = await runSignal(brain, { drainMs: 20 });
    expect(exited).toEqual([0]); // clean: `Restart=on-failure` must not read a deliberate stop as a crash
  });

  it('exits on a second signal without finishing the wait', async () => {
    const exited: number[] = [];
    const { brain } = brainBusy([{ turns: 1, children: 0 }]); // would otherwise drain forever
    await new Promise<void>((resolve) => {
      installGracefulShutdown(brain, silentLog, {
        pollMs: 5, drainMs: 60_000, notify: false,
        exit: ((code: number) => { exited.push(code); resolve(); }) as never,
      });
      process.emit('SIGTERM');
      setTimeout(() => process.emit('SIGTERM'), 10); // impatient operator
    });
    expect(exited[0]).toBe(0);
  });

  it('says what it is waiting for, so the stop is visible where only the boot used to be', async () => {
    const sent: string[] = [];
    const { brain } = brainBusy([{ turns: 2, children: 3 }, { turns: 0, children: 0 }], sent);
    await runSignal(brain, { notify: true });
    expect(sent[0]).toContain('2 turn(s)');
    expect(sent[0]).toContain('3 sub-agent(s)');
  });

  it('announces a plain stop when idle', async () => {
    const sent: string[] = [];
    await runSignal(brainBusy([{ turns: 0, children: 0 }], sent).brain, { notify: true });
    expect(sent[0]).toBe('🛑 **Stopping** — Elowen is shutting down.');
  });

  it('exits even when the announcement fails — a chat outage must not strand the process', async () => {
    const brain = ({
      busy: () => ({ turns: 0, children: 0 }),
      notify: async () => { throw new Error('discord is down'); },
    }) as unknown as BrainService;
    expect(await runSignal(brain, { notify: true })).toEqual([0]);
  });

  it('tolerates having no brain at all', async () => {
    const exited: number[] = [];
    await new Promise<void>((resolve) => {
      installGracefulShutdown(undefined, silentLog, {
        pollMs: 1, drainMs: 50, notify: false,
        exit: ((code: number) => { exited.push(code); resolve(); }) as never,
      });
      process.emit('SIGTERM');
    });
    expect(exited).toEqual([0]);
  });

  it('drains on SIGINT too, so an interactive Ctrl-C is not a harder kill than a deploy', async () => {
    const exited: number[] = [];
    const spy = vi.fn(() => ({ turns: 0, children: 0 }));
    const brain = ({ busy: spy, notify: async () => { /* quiet */ } }) as unknown as BrainService;
    await new Promise<void>((resolve) => {
      installGracefulShutdown(brain, silentLog, {
        pollMs: 1, drainMs: 50, notify: false,
        exit: ((code: number) => { exited.push(code); resolve(); }) as never,
      });
      process.emit('SIGINT');
    });
    expect(exited).toEqual([0]);
    expect(spy).toHaveBeenCalled();
  });
});
