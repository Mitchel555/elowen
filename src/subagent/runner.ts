/** THE SUB-AGENT RUNNER PROCESS.
 *
 *  A delegated turn used to execute on the daemon's single JS thread, next to the interactive path. Under
 *  twenty concurrent sub-agents that path starves — measured: event-loop p99 4366 ms, worst `/health`
 *  8.59 s. This process exists so the turn body runs somewhere else and the daemon's loop stays free.
 *
 *  It is a full brain core (same stores, same plugins, same prompts — see buildBrainCore) with the
 *  daemon's own layers deliberately absent:
 *   - NO boot reconcile. `reconcileDelegationsOnBoot` terminalizes every `running` delegation row it
 *     cannot see live in ITS OWN memory; from here that would kill the daemon's live children.
 *   - NO second HTTP port, no platform gateway, no cron, no autopilot, no background loop. The ONE
 *     platform it does start is `subagent` — that adapter is how delegation is wired at all, and without
 *     its `listen` the plugin's `run` handle stays null and a NESTED delegation fails outright. Nested
 *     delegation therefore stays inside this same runner (this process holds no runner of its own).
 *   - NO migrations: the daemon owns the schema and this process is forked only after it finished.
 *   - NO elicitor reachable by a client. A delegated turn has no attached client anyway, so `askUser`
 *     behaves here exactly as it does in-process: it parks and times out.
 *
 *  The abort tree stays authoritative in the DAEMON (its fencing is synchronous in-memory
 *  read-modify-write across sessions), so abort arrives as an explicit verb and this process only carries
 *  it out. Store writes are its own: it holds its own connection and writes its own sessions' rows. */
import { logger } from '../shared/logger.js';
import { buildBrainCore } from '../daemon/brainCore.js';
import type { TmuxDriver } from '../tmux/types.js';
import type { BrainService } from '../brain/brainService.js';
import { parseDelegatedTurnRequest, toDelegatedProgress } from '../brain/delegatedTurn.js';
import { SUBAGENT_PLATFORM, channelSessionId } from '../brain/sessionId.js';
import { parseDaemonMessage, subagentBuildId, type RunnerToDaemon } from './protocol.js';

const log = logger('subagent-runner');

/** The runner has no business launching tmux panes: agent spawning, the advisor terminal and mission
 *  workers all belong to the daemon. buildBrainCore takes the driver from its caller precisely so a
 *  process like this can hand in one that refuses instead of silently starting panes nobody reaps. */
const REFUSING_TMUX: TmuxDriver = {
  spawn: () => Promise.reject(new Error('tmux is not available in the sub-agent runner')),
  spawnArgv: () => Promise.reject(new Error('tmux is not available in the sub-agent runner')),
  resize: () => Promise.reject(new Error('tmux is not available in the sub-agent runner')),
  sendKeys: () => Promise.reject(new Error('tmux is not available in the sub-agent runner')),
  sendRaw: () => Promise.reject(new Error('tmux is not available in the sub-agent runner')),
  capturePane: () => Promise.reject(new Error('tmux is not available in the sub-agent runner')),
  capturePaneAnsi: () => Promise.reject(new Error('tmux is not available in the sub-agent runner')),
  list: () => Promise.resolve([]),
  kill: () => Promise.resolve(),
};

const send = (message: RunnerToDaemon): void => {
  try { process.send?.(message); } catch { /* the channel closed under us; the exit path handles it */ }
};

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Sessions whose turn is currently in flight here, so an abort/release can tell "working on it" from
 *  "merely holds an idle record". Keyed by CHANNEL id, which is what both verbs address. */
const runningChannels = new Set<string>();
/** The parent→child edges of the turns THIS process was handed. They are already registered in the
 *  daemon's registry (synchronously, before it forwarded anything), so reporting them upward again would
 *  let the runner's own end-of-turn retraction clear an edge the daemon still owns. */
const dispatchedEdges = new Set<string>();
const edgeKey = (parentSessionId: string, childSessionId: string): string => `${parentSessionId}\u0000${childSessionId}`;

let brain: BrainService | undefined;
/** Turns accepted before the core finished booting. Node delivers IPC messages as soon as the channel is
 *  up, which is well before plugins are loaded. */
let booting: Promise<void> | undefined;

async function boot(dbPath: string, project: { id: number; slug: string; path: string }): Promise<void> {
  const core = await buildBrainCore({
    dbPath,
    project,
    tmux: REFUSING_TMUX,
    // The daemon prepared this database; a process attaching to it must not create accounts…
    bootstrap: null,
    // …nor take the write lock to re-prove a schema that is already final.
    migrate: false,
    // `notifyTurnComplete` is deliberately omitted: web push is a daemon transport (it holds the
    // subscriptions and the VAPID keys), and a delegated turn has nobody to notify anyway.
  });
  if (!core.brain) throw new Error('the brain is not available for this database');
  brain = core.brain;
  // Report NESTED delegated edges upward. The daemon's LiveSessionRegistry is the authoritative abort
  // tree, so it has to see work happening over here — but never the edge of the dispatched turn itself,
  // which it registered on its own before forwarding.
  core.brain.attachDelegatedEdgeReporter((parentSessionId, childSessionId, running) => {
    if (dispatchedEdges.has(edgeKey(parentSessionId, childSessionId))) return;
    send({ type: 'child', parentSessionId, childSessionId, running });
  });
  // The `subagent` adapter ONLY — see the header. This is what gives the plugin its `run` handle, so a
  // sub-agent here can delegate further without leaving the process.
  await core.brain.startPlatforms(log, [SUBAGENT_PLATFORM]);
}

async function runTurn(turnId: string, rawRequest: unknown, text: string): Promise<void> {
  await booting;
  const service = brain;
  if (!service) { send({ type: 'error', turnId, message: 'the sub-agent runner has no brain' }); return; }
  // Internal traffic, still validated like persisted JSON: a turn whose boundary does not normalize is
  // REFUSED. Running it under an ambient policy is the one failure mode this whole path must not have.
  const request = parseDelegatedTurnRequest(rawRequest);
  if (!request) { send({ type: 'error', turnId, message: 'invalid delegated access' }); return; }
  const childSessionId = channelSessionId(request.channelId);
  const edge = edgeKey(request.parentSessionId, childSessionId);
  runningChannels.add(request.channelId);
  dispatchedEdges.add(edge);
  try {
    const reply = await service.runDelegatedTurn(request, text, (e) => {
      // ONLY the three low-frequency shapes the delegating plugin consumes. Text deltas, tool-argument
      // deltas and transcripts must never cross: re-amplifying them over IPC would put back the very
      // event-loop pressure this process removes.
      const progress = toDelegatedProgress(e);
      if (progress) send({ type: 'progress', turnId, event: progress });
    });
    send({ type: 'result', turnId, reply });
  } catch (e) {
    send({ type: 'error', turnId, message: errorText(e) });
  } finally {
    runningChannels.delete(request.channelId);
    dispatchedEdges.delete(edge);
  }
}

process.on('message', (raw: unknown) => {
  const msg = parseDaemonMessage(raw);
  if (!msg) return;
  switch (msg.type) {
    case 'boot': {
      if (booting) return; // already booted; a second boot frame is not a reason to build a second core
      const own = subagentBuildId();
      if (msg.buildId !== own) {
        // An in-place rebuild under a live daemon is exactly this: a child forked from code its parent is
        // not running. Refuse rather than serve turns from a different build.
        send({ type: 'fatal', reason: `build mismatch (daemon ${msg.buildId}, runner ${own})` });
        process.exit(2);
      }
      booting = boot(msg.dbPath, msg.project).then(
        () => { send({ type: 'ready', buildId: own }); },
        (e: unknown) => { send({ type: 'fatal', reason: errorText(e) }); process.exit(3); },
      );
      return;
    }
    case 'turn':
      void runTurn(msg.turnId, msg.request, msg.text);
      return;
    case 'abort':
      // The daemon has already fenced the delegation in its own registry; this is the half only the
      // process holding the PI session can do.
      void brain?.abortChannel(msg.channelId).catch((e: unknown) => log.warn(`abort failed: ${errorText(e)}`));
      return;
    case 'release': {
      // The daemon wants to run this child's next turn itself. Refuse while it is working here — one
      // transcript driven by two live sessions is worse than a refused continuation.
      if (runningChannels.has(msg.channelId)) { send({ type: 'released', releaseId: msg.releaseId, busy: true }); return; }
      void Promise.resolve(brain?.disposeChannel(msg.channelId))
        .catch((e: unknown) => log.warn(`release failed: ${errorText(e)}`))
        .finally(() => { send({ type: 'released', releaseId: msg.releaseId, busy: false }); });
      return;
    }
    default:
      return;
  }
});

/** The daemon is gone. A runner that kept working would be an orphan writing rows nobody is waiting for
 *  — and holding model spend nobody asked for — so abort what is running and leave. */
const leave = (reason: string): void => {
  log.warn(`sub-agent runner shutting down: ${reason}`);
  const channels = [...runningChannels];
  runningChannels.clear();
  void Promise.allSettled(channels.map((channelId) => brain?.abortChannel(channelId)))
    .finally(() => process.exit(0));
  // A wedged abort must not keep the orphan alive either.
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on('disconnect', () => leave('the daemon closed the IPC channel'));
process.on('SIGTERM', () => leave('SIGTERM'));

// Same reasoning as the daemon: a stray rejection from one of the many fire-and-forget paths inside a
// turn must not take the whole process — and with it every other sub-agent — down.
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));
process.on('uncaughtException', (e) => log.error('uncaughtException', e));
