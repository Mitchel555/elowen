import { logger } from '../shared/logger.js';
import type { BrainEvent } from '../brain/events.js';
import { SubagentRunnerUnavailable, type DelegatedTurnRequest, type DelegatedTurnRunner } from '../brain/delegatedTurn.js';

const log = logger('subagent-dispatch');

export type SubagentDispatchMode = 'in-process' | 'runner';

export interface SubagentDispatchDeps {
  /** Execute the delegated turn HERE — byte for byte what happened before the runner existed. */
  runTurn: (request: DelegatedTurnRequest, text: string, onEvent?: (e: BrainEvent) => void) => Promise<string>;
  /** Hold the parts of a delegated turn that cannot leave this process (the parent/child edge and the
   *  abort fencing) around an execution that happens somewhere else — see
   *  ChannelSessionService.sendRemote. */
  fenceRemote: (request: DelegatedTurnRequest, run: () => Promise<string>) => Promise<string>;
  /** The forked runner. ABSENT in the runner itself, which is what structurally keeps a nested delegation
   *  inside the same process instead of forking a runner from a runner. */
  runner?: DelegatedTurnRunner;
  /** The operator's switch, read LIVE so turning it off is a rollback with no redeploy: the very next
   *  delegated turn runs in-process again. */
  runnerEnabled?: () => boolean;
}

/** THE routing decision for one delegated turn: run it on this event loop, or hand it to the sub-agent
 *  runner process.
 *
 *  It sits below both spawn routes by construction — the Delegate tool and a workflow node reach the host
 *  through the same `run` handle, and that handle ends here.
 *
 *  `in-process` is the default and is deliberately a straight pass-through: no wire payload is built, no
 *  child is consulted, nothing is re-derived. Flipping the switch off must leave literally the old code
 *  path, because that is what makes it a usable rollback. */
export class SubagentDispatch {
  constructor(private d: SubagentDispatchDeps) {}

  mode(): SubagentDispatchMode {
    const runner = this.d.runner;
    if (!runner || this.d.runnerEnabled?.() !== true) return 'in-process';
    // A pool sized to zero by the operator is not a runner that might work — it is the in-process path,
    // and saying so here is what keeps that config from logging a fallback warning per delegated turn.
    return runner.usable?.() === false ? 'in-process' : 'runner';
  }

  async send(request: DelegatedTurnRequest, text: string, onEvent?: (e: BrainEvent) => void): Promise<string> {
    const runner = this.d.runner;
    if (!runner || this.mode() === 'in-process') return this.d.runTurn(request, text, onEvent);
    try {
      return await this.d.fenceRemote(request, () => runner.run(request, text, onEvent));
    } catch (e) {
      // The runner could not be STARTED — nothing of this turn ran anywhere, so running it here is the
      // difference between a slower delegation and a broken one. A turn that failed INSIDE a healthy
      // runner is a real failure and is reported as one: retrying it here would duplicate whatever side
      // effects it already had.
      if (!(e instanceof SubagentRunnerUnavailable)) throw e;
      log.warn(`sub-agent runner unavailable, running this delegated turn in-process: ${e.message}`);
      return this.d.runTurn(request, text, onEvent);
    }
  }
}
