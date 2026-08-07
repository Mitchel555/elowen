import { fork, type ChildProcess } from 'node:child_process';
import { setPriority } from 'node:os';
import { randomUUID } from 'node:crypto';
import { logger } from '../shared/logger.js';
import type { BrainEvent } from '../brain/events.js';
import {
  SubagentRunnerUnavailable,
  fromDelegatedProgress,
  type DelegatedTurnRequest,
  type DelegatedTurnRunner,
} from '../brain/delegatedTurn.js';
import { RUNNER_ENTRY, parseRunnerMessage, subagentBuildId, type DaemonToRunner } from './protocol.js';

const log = logger('subagent-runner');

/** How long the child gets to attach its database, load plugins and build its brain before we give up on
 *  it. Generous: it does everything the daemon's own boot does minus the server, and a cold plugin load on
 *  a loaded box is not fast. */
const BOOT_TIMEOUT_MS = 60_000;
/** After a failed boot, stay in-process for this long instead of forking on every single delegation — a
 *  broken runner must not turn one failure into a fork storm. */
const BOOT_RETRY_COOLDOWN_MS = 60_000;

export interface SubagentRunnerHostDeps {
  dbPath: string;
  project: { id: number; slug: string; path: string };
  /** The daemon's OWN working directory. A delegated turn resolves its cwd as
   *  `turnWorkDir(...) ?? cwd ?? process.cwd()`, so a child forked with a different one would silently
   *  tell the model it is somewhere else. */
  cwd: string;
  /** The fork itself. Injectable ONLY so the handshake and the death path can be exercised without
   *  booting a real brain in a child process; production always takes the default below. */
  fork?: () => ChildProcess;
}

interface PendingTurn {
  resolve: (reply: string) => void;
  reject: (e: Error) => void;
  onEvent?: (e: BrainEvent) => void;
}

/** Supervises the ONE forked sub-agent runner: boot handshake, turn correlation, abort/release verbs and
 *  the death path.
 *
 *  Deliberately a single child with no pool, no sizing and no admission queue — those are a separate
 *  problem (how much concurrency is right) from this one (does the boundary hold at all). */
export class SubagentRunnerHost implements DelegatedTurnRunner {
  private child: ChildProcess | null = null;
  private ready: Promise<ChildProcess> | null = null;
  private readonly pending = new Map<string, PendingTurn>();
  /** Nested edges this runner told us about, so a runner death can retract every one of them instead of
   *  leaving the daemon believing work is still running. */
  private readonly mirroredEdges = new Set<string>();
  private cooldownUntil = 0;
  private readonly buildId = subagentBuildId();
  private childEdgeSink?: (parentSessionId: string, childSessionId: string, running: boolean) => void;

  constructor(private d: SubagentRunnerHostDeps) {}

  /** Mirror a NESTED delegated edge reported by the runner into the daemon's registry — the abort tree,
   *  the status view and the shutdown gate all read it there. Late-bound: this host is a dependency of
   *  the brain, so the brain does not exist yet when it is constructed. */
  attachChildEdgeSink(sink: (parentSessionId: string, childSessionId: string, running: boolean) => void): void {
    this.childEdgeSink = sink;
  }

  async run(request: DelegatedTurnRequest, text: string, onEvent?: (e: BrainEvent) => void): Promise<string> {
    const child = await this.ensure();
    const turnId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      this.pending.set(turnId, { resolve, reject, ...(onEvent ? { onEvent } : {}) });
      if (!this.post(child, { type: 'turn', turnId, request, text })) {
        this.pending.delete(turnId);
        reject(new SubagentRunnerUnavailable('the sub-agent runner channel closed before the turn was sent'));
      }
    });
  }

  abort(channelId: string): void {
    if (this.child) this.post(this.child, { type: 'abort', channelId });
  }

  async release(channelId: string): Promise<{ busy: boolean }> {
    const child = this.child;
    // Nothing forked (or already gone) ⇒ the runner holds no record for this channel by definition.
    if (!child || !this.ready) return { busy: false };
    const releaseId = randomUUID();
    return new Promise<{ busy: boolean }>((resolve) => {
      const onMessage = (raw: unknown): void => {
        const msg = parseRunnerMessage(raw);
        if (msg?.type !== 'released' || msg.releaseId !== releaseId) return;
        child.off('message', onMessage);
        child.off('exit', onExit);
        resolve({ busy: msg.busy });
      };
      // A runner that died is a runner that holds nothing — the caller may proceed.
      const onExit = (): void => { child.off('message', onMessage); resolve({ busy: false }); };
      child.on('message', onMessage);
      child.once('exit', onExit);
      if (!this.post(child, { type: 'release', releaseId, channelId })) { onExit(); }
    });
  }

  reset(reason: string): void {
    const child = this.child;
    if (!child) return;
    log.info(`stopping the sub-agent runner: ${reason}`);
    this.child = null;
    this.ready = null;
    // The exit handler settles pending turns and retracts mirrored edges; killing is all that is needed
    // here, and SIGTERM lets the child abort its own sessions on the way out.
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }

  /** Fork + handshake, memoized. Throws {@link SubagentRunnerUnavailable} when the child cannot be
   *  brought up, so the caller can fall back to running the turn itself. */
  private ensure(): Promise<ChildProcess> {
    if (this.ready) return this.ready;
    if (Date.now() < this.cooldownUntil) {
      return Promise.reject(new SubagentRunnerUnavailable('the sub-agent runner failed to start recently'));
    }
    this.ready = this.spawn().catch((e: unknown) => {
      this.cooldownUntil = Date.now() + BOOT_RETRY_COOLDOWN_MS;
      this.ready = null;
      this.child = null;
      throw e instanceof SubagentRunnerUnavailable
        ? e
        : new SubagentRunnerUnavailable(e instanceof Error ? e.message : String(e));
    });
    return this.ready;
  }

  private spawn(): Promise<ChildProcess> {
    return new Promise<ChildProcess>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.d.fork?.() ?? fork(RUNNER_ENTRY, [], {
          // Explicit: a delegated turn's cwd falls back to `process.cwd()`, which would otherwise differ
          // between the daemon and its child and change what the model is told about where it runs.
          cwd: this.d.cwd,
          // The whole daemon environment, deliberately: PI_CACHE_RETENTION, ELOWEN_CLI, ELOWEN_PORT and
          // the log dir all shape what a session composes, and a child that missed one of them would
          // produce a subtly different prompt.
          env: process.env,
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        });
      } catch (e) {
        reject(new SubagentRunnerUnavailable(e instanceof Error ? e.message : String(e)));
        return;
      }
      this.child = child;
      // Child work must yield to the interactive path. Best-effort: an unsupported platform is not a
      // reason to refuse to delegate, it only means the child competes on equal terms.
      try { if (child.pid) setPriority(child.pid, 5); } catch (e) {
        log.warn(`could not lower the sub-agent runner's priority: ${e instanceof Error ? e.message : String(e)}`);
      }
      const timer = setTimeout(() => {
        settleBoot(new SubagentRunnerUnavailable(`the sub-agent runner did not report ready within ${BOOT_TIMEOUT_MS}ms`));
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, BOOT_TIMEOUT_MS);
      timer.unref();
      let booted = false;
      const settleBoot = (e?: Error): void => {
        if (booted) return;
        booted = true;
        clearTimeout(timer);
        if (e) reject(e); else resolve(child);
      };
      child.on('message', (raw: unknown) => {
        const msg = parseRunnerMessage(raw);
        if (!msg) return;
        switch (msg.type) {
          case 'ready':
            if (msg.buildId !== this.buildId) {
              settleBoot(new SubagentRunnerUnavailable(`sub-agent runner build mismatch (${msg.buildId} vs ${this.buildId})`));
              try { child.kill('SIGKILL'); } catch { /* already gone */ }
              return;
            }
            log.info(`sub-agent runner ready (pid ${child.pid})`);
            settleBoot();
            return;
          case 'fatal':
            settleBoot(new SubagentRunnerUnavailable(`sub-agent runner refused to start: ${msg.reason}`));
            return;
          case 'progress': {
            const turn = this.pending.get(msg.turnId);
            try { turn?.onEvent?.(fromDelegatedProgress(msg.event)); } catch { /* a sink of ours threw; the turn continues */ }
            return;
          }
          case 'child': {
            const key = `${msg.parentSessionId}\u0000${msg.childSessionId}`;
            if (msg.running) this.mirroredEdges.add(key); else this.mirroredEdges.delete(key);
            this.childEdgeSink?.(msg.parentSessionId, msg.childSessionId, msg.running);
            return;
          }
          case 'result': {
            const turn = this.pending.get(msg.turnId);
            this.pending.delete(msg.turnId);
            turn?.resolve(msg.reply);
            return;
          }
          case 'error': {
            const turn = this.pending.get(msg.turnId);
            this.pending.delete(msg.turnId);
            turn?.reject(new Error(msg.message));
            return;
          }
          default: return; // `released` is handled by the per-call listener in release()
        }
      });
      child.on('error', (e) => {
        log.error(`sub-agent runner error: ${e.message}`);
        settleBoot(new SubagentRunnerUnavailable(e.message));
      });
      child.on('exit', (code, signal) => {
        if (this.child === child) { this.child = null; this.ready = null; }
        settleBoot(new SubagentRunnerUnavailable(`the sub-agent runner exited during boot (code ${code ?? '?'}, signal ${signal ?? 'none'})`));
        // A dead runner cannot finish what it started. Settle every awaited turn as interrupted so the
        // delegating parents get a terminal answer instead of waiting for a process that is gone.
        const interrupted = new Error('the sub-agent runner exited — this delegated turn was interrupted');
        for (const [turnId, turn] of [...this.pending]) {
          this.pending.delete(turnId);
          turn.reject(interrupted);
        }
        // …and retract every edge it had reported, or the daemon keeps believing that work is live.
        for (const key of [...this.mirroredEdges]) {
          this.mirroredEdges.delete(key);
          const [parentSessionId = '', childSessionId = ''] = key.split('\u0000');
          this.childEdgeSink?.(parentSessionId, childSessionId, false);
        }
        if (code !== 0 || signal) log.warn(`sub-agent runner exited (code ${code ?? '?'}, signal ${signal ?? 'none'})`);
      });
      this.post(child, {
        type: 'boot', buildId: this.buildId, dbPath: this.d.dbPath, project: this.d.project,
      });
    });
  }

  /** `child.send` throws once the channel is gone; a delegated turn must not die of that. */
  private post(child: ChildProcess, message: DaemonToRunner): boolean {
    try {
      return child.connected ? child.send(message) : false;
    } catch {
      return false;
    }
  }
}
