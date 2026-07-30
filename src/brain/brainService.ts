import type { PluginRegistry } from '../plugins/registry.js';
import { PluginHookBus } from '../plugins/hookBus.js';
import { ElicitationRegistry } from './elicitation.js';
import { CardRegistry } from './cards.js';
import type { BrainSearchHit, BrainGoalRow } from '../store/brainStore.js';
import { syntheticRestartResultId } from '../store/brainStore.js';
import { MemoryCurator } from './memoryCurator.js';
import { ConversationTitler } from './conversationTitler.js';
import { logger } from '../shared/logger.js';
import { BrainSessionFactory, resolveAutoCompactPct } from './session/factory.js';
import { abortSessionWork } from './session/abortSessionWork.js';
import { IdentityResolver } from './identity.js';
import { LiveSessionRegistry } from './session/liveRegistry.js';
import type { LiveBrain, QueuedMsg } from './session/liveBrain.js';
import { DEFAULT_AUTO_COMPACT_PCT } from './session/liveBrain.js';
import { clearDeliveredUserEchoes, enqueueMirrored, queuedWithPending } from './session/queueMirror.js';
import { ChannelSessionService } from './channels.js';
import type { ChannelSendOpts } from './channels.js';
import { PlatformOrchestrator } from './platforms.js';
import type { BrainMessageView } from './messageView.js';
import { extractText } from './messageView.js';
import { runCompaction, withDescendantUsage } from './events.js';
import type { AskAnswer, BrainEvent, CompactResult } from './events.js';
import { isNonUserSession, isOwnedUserSession, isChannelSession, isSubagentSession, channelIdOf, defaultUserSessionId, channelSessionId, archivedChannelSessionId } from './sessionId.js';
import { lastAssistantText } from './goal.js';
import { ClientAttachments } from './service/attachments.js';
import { IdleSessionClock } from './service/liveSessionReaper.js';
import { SESSION_IDLE_ROLLOVER_MS } from './session/idleRollover.js';
import { PermissionApprovalService } from './service/permissionApproval.js';
import { GoalLoopService } from './service/goalLoop.js';
import { LiveSessionSpawner } from './service/spawner.js';
import { ConversationLifecycle } from './service/lifecycle.js';
import { recordSessionEvent, scheduleReasoningMarker } from './service/sessionEvents.js';
import { clientDir } from './service/workDir.js';
import { terminalizeWorkflow } from './workflowRuns.js';
import { BrainTurnRunner } from './service/turnRunner.js';
import type { BoundClientRequest, TurnRequest } from './service/turnRequest.js';
import { BrainStatusService } from './service/statusService.js';
import type { SessionListItem, SessionPage, SessionPageOpts, MessagePage, MessagePageOpts, BrainStatusView, ManagedSessionView } from './service/statusService.js';
import { exportBrainSession } from './session/exportSession.js';
import type { ExportFormat, SessionExport } from './session/exportSession.js';
import type { BrainDeps } from './brainDeps.js';
import { processRegistry, type ProcessHandle, type ProcessInfo } from './processRegistry.js';
import type { BrainStreamSnapshot } from './session/liveEventReplay.js';
import { delegatedToolPolicy, scopeExceedsCurrentAccess, type DelegatedExecutionScope } from './delegatedScope.js';
import { DEFAULT_BRAIN_LIMITS } from '../store/configStore.js';
import type { Model, Api } from '@earendil-works/pi-ai';
import { CANONICAL_THINKING_LEVELS, canonicalThinkingLevel } from './modelCapabilities.js';

export type { BrainDeps } from './brainDeps.js';

/** Per-user embedded brain lifecycle. Mirrors AdvisorService's shape so daemon wiring is familiar,
 *  but holds in-process PI AgentSessions (one per conversation) instead of spawning an external CLI.
 *  A thin facade over the focused units: session state (LiveSessionRegistry), assembly
 *  (BrainSessionFactory + LiveSessionSpawner), identities (IdentityResolver), addressing/respawns
 *  (ConversationLifecycle), the turn pipeline (BrainTurnRunner), permissions
 *  (PermissionApprovalService), the goal loop (GoalLoopService), read-only views (BrainStatusService),
 *  channel turns (ChannelSessionService) and platform adapters (PlatformOrchestrator).
 *
 *  TWO-TIER SESSION ADDRESSING. Conversations are reachable two ways:
 *  - POINTER-BASED (the web dock, platform surfaces): calls carry no session id and act on the user's
 *    ACTIVE conversation (`activeSessionId`). start() moves the pointer; everything else follows it.
 *  - SESSION-BOUND (the CLI): the client resolves ITS conversation once at start() and passes the id
 *    explicitly on every subsequent call (send/stream/compact/goal/…). Bound calls are ownership-checked,
 *    never READ the active pointer and never MOVE it — so two CLIs (or a CLI plus the dock) can work
 *    independent conversations concurrently without leaking events or hijacking each other's session.
 *  start() still sets the pointer even for a CLI start (opening a conversation anywhere makes it the
 *  web default); after that a bound client is immune to pointer movement. */
export class BrainService {
  /** All mutable live-session state: user sessions, active pointers, channel LRU and the per-key
   *  locks (PI sessions are single-conversation — concurrent prompt()/spawn calls on one session id
   *  queue up instead of corrupting turn state). */
  private sessions = new LiveSessionRegistry<LiveBrain>();
  /** Shared session assembly (store row + rehydrate + resource loader + PI session) — the same
   *  factory the elowen-exec brain workers use. */
  private factory: BrainSessionFactory;
  /** The ONE place turn identities (and the owner check) are minted. */
  private identity: IdentityResolver;
  private channelService: ChannelSessionService;
  private platforms: PlatformOrchestrator;
  /** Post-turn memory curator — built only when the memory deps are wired. Runs fire-and-forget from
   *  send() (owner chat), never awaited. */
  private curator?: MemoryCurator;
  /** Names a brand-new conversation from its first message with one cheap background inference (reuses the
   *  curator/categorizer model). No-ops when that model isn't configured — the provisional title stays. */
  private titler: ConversationTitler;
  /** Parked `AskUserQuestion` calls, shared by owner chat and channel sessions so `/brain/answer`
   *  (web/CLI) and Discord interactions resolve through one registry. */
  /** Operator-tuned brain limits, read live (Settings → Elowen AI → Limits); the built-in defaults when a
   *  minimal/test wiring omits the accessor. */
  private limits(): typeof DEFAULT_BRAIN_LIMITS { return this.d.brainLimits?.() ?? DEFAULT_BRAIN_LIMITS; }
  private elicitation = new ElicitationRegistry(() => this.limits().elicitationTimeoutMs);
  /** Display cards (ctx.emitCard) per conversation — seeded to clients via status, kept current via the
   *  `card` event. Shared by owner chat and channel sessions. Store-backed, so a panel (the todo
   *  checklist) survives closing the conversation and the daemon restarting, not just an SSE reconnect. */
  private cards = new CardRegistry(() => this.d.store);
  /** Live client streams + long-lived session taps → the session each is attached to. */
  private attachments = new ClientAttachments();
  /** How long each live conversation has been continuously unwatched AND idle — the reaper's clock. */
  private readonly idleClock = new IdleSessionClock();
  /** Effective tool permissions per turn + the approval channel + the session YOLO override. */
  private permissionSvc: PermissionApprovalService;
  /** The autonomous goal loop: /goal surface, continuation timers, post-turn judge. */
  private goals: GoalLoopService;
  /** Composes one live conversation (config + plugins + persona + tools) — the single spawn source. */
  private spawner: LiveSessionSpawner;
  /** Session addressing, start/resume resolution and every respawn path (rollover, hop, restart). */
  private lifecycle: ConversationLifecycle;
  /** The owner-chat turn pipeline (send). */
  private turnRunner: BrainTurnRunner;
  /** Read-only views: status, session lists, history, search, readiness. */
  private statusView: BrainStatusService;
  /** A plugin (e.g. the skills plugin's CreateSkill) asked for a plugin reload from INSIDE a running
   *  turn. Reloading there would dispose the very session executing the tool, so the request is coalesced
   *  onto this flag and drained once the turn settles (see drainDeferredPluginReload). */
  private pendingPluginReload = false;
  constructor(private d: BrainDeps) {
    // Mid-turn messages are STEERED into the running turn via PI's native queue (session.steer); PI fans
    // its transient backlog as `queue_update`, mapped to the `queue` snapshot event in the spawner.
    this.factory = new BrainSessionFactory({ store: d.store, createSession: d.createSession, resourceLoaderFactory: d.resourceLoaderFactory });
    this.identity = new IdentityResolver({ platformOwner: d.platformOwner, resolvePlatformUser: d.resolvePlatformUser, users: d.users });
    this.titler = new ConversationTitler({ store: d.store, inference: d.inference ?? (() => null), logger: logger('conversation-titler') });
    // Built before the channel service so it can share the SAME curator instance — channel and
    // owner-chat memory then run through one implementation.
    if (d.memoryStore && d.memoryService) {
      this.curator = new MemoryCurator({
        store: d.memoryStore, service: d.memoryService,
        inference: d.inference ?? (() => null), categorizer: d.memoryCategorizer,
        logger: logger('memory-curator'),
      });
    }
    // NOTE for all sub-service wiring below: passthrough deps are handed over as live getters/thunks
    // onto the ONE shared BrainDeps object, never captured by value — the original monolith read every
    // dep via `this.d.X` at call time, and tests (and live daemon rewiring) rely on late binding.
    this.permissionSvc = new PermissionApprovalService({
      get permissions() { return d.permissions; },
      get saveAlwaysAllow() { return d.saveAlwaysAllow; },
      get execAllowed() { return d.execAllowed; },
      elicitation: this.elicitation,
    });
    // The goal loop drives itself back through the facade (start/send) and the lifecycle (ensureLive)
    // via late-bound thunks — those units are constructed just below.
    this.goals = new GoalLoopService({
      store: d.store,
      ownedUserSession: (userId, sessionId) => this.lifecycle.ownedUserSession(userId, sessionId),
      activeSessionId: (userId) => this.lifecycle.activeSessionId(userId),
      attachedCount: (sessionId) => this.attachments.attachedCount(sessionId),
      ensureLive: (userId, sessionId, o) => this.lifecycle.ensureLive(userId, sessionId, o),
      start: (userId) => this.start(userId),
      send: (request) => this.send(request),
      defaultTurnBudget: () => this.limits().goalTurnBudget,
      goalMaxTurns: () => this.limits().goalMaxTurns,
      isYolo: (userId, sessionId) => this.permissionSvc.effectiveYolo(userId, this.sessions.get(sessionId)),
      publishGoal: (sessionId, goal) => {
        this.sessions.get(sessionId)?.replay.publish({ type: 'goal', goal });
      },
    });
    this.spawner = new LiveSessionSpawner({
      get config() { return d.config; },
      store: d.store,
      get runtime() { return d.runtime; },
      get users() { return d.users; },
      get prompts() { return d.prompts; },
      get url() { return d.url; },
      get cwd() { return d.cwd; },
      get projectPath() { return d.projectPath; },
      get userSettings() { return d.userSettings; },
      get activePersonality() { return d.activePersonality; },
      get agentName() { return d.agentName; },
      get maxSteps() { return d.maxSteps; },
      get memoryStore() { return d.memoryStore; },
      get memoryService() { return d.memoryService; },
      get memoryCategoryStore() { return d.memoryCategoryStore; },
      get memoryCategorizer() { return d.memoryCategorizer; },
      plugins: () => this.resolvePlugins(),
      factory: this.factory,
      sessionTaps: (sessionId) => this.attachments.sessionTaps.get(sessionId) ?? [],
    });
    this.lifecycle = new ConversationLifecycle({
      store: d.store, sessions: this.sessions, attachments: this.attachments,
      elicitation: this.elicitation, goals: this.goals,
      spawn: (o) => this.spawner.spawn(o),
      get policy() { return d.policy; },
      get userSettings() { return d.userSettings; },
      get projectModelPreference() { return d.projectModelPreference; },
      get setProjectModelPreference() { return d.setProjectModelPreference; },
      selectionAllowed: (userId, sel) => this.permissionSvc.selectionAllowed(userId, sel),
    });
    this.turnRunner = new BrainTurnRunner({
      store: d.store, sessions: this.sessions,
      lifecycle: this.lifecycle, goals: this.goals, permissions: this.permissionSvc,
      elicitation: this.elicitation, cards: this.cards, identity: this.identity,
      titler: this.titler, curator: this.curator,
      get prompts() { return d.prompts; },
      get users() { return d.users; },
      get userSettings() { return d.userSettings; },
      get memoryService() { return d.memoryService; },
      plugins: () => this.resolvePlugins(),
      get hookAudit() { return d.hookAudit; },
      get projectPath() { return d.projectPath; },
      sendDelegatedCustom: async (userId, sessionId, customType, content, resultId) => {
        await this.sendDelegated(userId, sessionId, content, { internalSystem: { customType, resultId } });
      },
      afterTurnSettled: (userId, sessionId, fromWeb) => {
        this.drainDeferredPluginReload();
        // A web-started turn just finished and nobody was watching it live (a bound CLI would be) — tell the
        // user's phone. Enablement is implicit: no push subscription means the notifier sends nothing.
        if (fromWeb && d.notifyTurnComplete) {
          d.notifyTurnComplete(userId, d.store.getSession(sessionId)?.title ?? '');
        }
      },
    });
    this.statusView = new BrainStatusService({
      store: d.store, sessions: this.sessions, attachments: this.attachments,
      elicitation: this.elicitation, cards: this.cards,
      lifecycle: this.lifecycle, permissions: this.permissionSvc,
      get config() { return d.config; },
      get runtime() { return d.runtime; },
      get createSession() { return d.createSession; },
      get cwd() { return d.cwd; },
      get policy() { return d.policy; },
    });
    this.channelService = new ChannelSessionService({
      registry: this.sessions, store: d.store, users: d.users,
      maxChannels: () => this.limits().channelSessionCap,
      spawn: (o) => this.spawner.spawn(o), // composition stays in the spawner — single source
      // Verified channel senders get memory too, keyed on their linked account and their own toggles.
      memoryService: d.memoryService, curator: this.curator, userSettings: d.userSettings,
      elicitation: this.elicitation, // one registry so Discord interactions resolve channel questions
      titler: this.titler, // name a brand-new channel conversation, same as owner chat
      permissions: d.permissions, // deny rules apply to channel turns too (asks follow unattendedAsks there)
      completeSubagent: (parentSessionId, userId, completion) =>
        this.turnRunner.acceptSubagentCompletion(parentSessionId, userId, completion),
      completeWorkflow: (parentSessionId, userId, completion) =>
        this.turnRunner.acceptWorkflowCompletion(parentSessionId, userId, completion),
      cancelWorkflows: (sessionId) => this.cancelWorkflowsFor(sessionId),
    });
    this.platforms = new PlatformOrchestrator({
      plugins: () => this.resolvePlugins(),
      platformOwner: d.platformOwner,
      agents: d.agents,
      policyForProjects: d.policyForProjects,
      // A linked platform sender runs fully through their Elowen account: reuse the SAME per-user policy
      // resolver the owner web chat uses, plus their own tool deny-list.
      policyForUser: d.policy,
      disabledToolsFor: (userId) => d.users.get(userId)?.disabled_tools ?? [],
      identity: this.identity,
      channels: this.channelService,
      restart: () => this.restartHandler,
      // Origin-bound platform work (a cron wake-up scheduled from a user conversation): run the prompt
      // as a BOUND send into that conversation — the reply lands, streams and persists exactly where
      // the schedule was created. Ownership-verified here (the ONE place with the store): a vanished or
      // foreign session returns null and the orchestrator falls back to the channel path. The `session`
      // event is emitted only AFTER the send succeeded, so the caller (cron) can tell origin delivery
      // apart from a failed attempt and still deliver errors through its notify fallback.
      originSend: async (userId, sessionId, text, onEvent) => {
        const row = this.d.store.getSession(sessionId);
        if (!isOwnedUserSession(row, userId, sessionId)) return null;
        await this.send({ userId, text, mode: 'build', session: sessionId });
        onEvent?.({ type: 'session', sessionId });
        return lastAssistantText(this.d.store, sessionId);
      },
      // /context picker (all three platform surfaces): resolve the platform sender to their linked Elowen
      // account, then reach the SAME BrainService methods the web endpoint uses — one implementation, not
      // two. An unlinked sender has no bindable sessions: listing returns null, binding rejects.
      listContextSessions: (platform, platformUserId, opts) => {
        const linked = d.resolvePlatformUser?.(platform, platformUserId);
        return linked ? this.listContextSessions(linked.id, opts) : null;
      },
      bindContext: async (platform, platformUserId, channelKey, sessionId) => {
        const linked = d.resolvePlatformUser?.(platform, platformUserId);
        if (!linked) throw new Error('unknown session'); // no linked account → none of their sessions exist here
        return this.bindChannelContext(linked.id, channelKey, sessionId);
      },
    });
  }

  /** Admin daemon-restart handler for a platform `/restart` slash. Late-bound: it's built after the brain
   *  (it needs the systemd units + marker path), so bootstrap sets it once ready. Undefined ⇒ unavailable. */
  restartHandler?: (byUserId: number) => Promise<void>;

  /** Tear down the admin chat terminal bound to a conversation before it is deleted (BrainTerminalService.
   *  stopForSession). Late-bound: the terminal service is constructed AFTER the brain (it needs store+users),
   *  so bootstrap attaches this once ready — avoids a constructor cycle (mirrors SpawnService.attachBrainWorker).
   *  Undefined ⇒ no terminals wired; the janitor sweep still reaps an orphaned binding as a backstop. */
  private terminalTeardown?: (userId: number, sessionId: string) => Promise<void>;
  attachTerminalTeardown(fn: (userId: number, sessionId: string) => Promise<void>): void {
    this.terminalTeardown = fn;
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.sessions.withLock(key, fn);
  }

  /** One-shot boot sweep for restart-zombie goals — see GoalLoopService.reconcileGoalsOnBoot. */
  reconcileGoalsOnBoot(): void {
    this.goals.reconcileGoalsOnBoot();
  }

  /** The delegation twin of {@link reconcileGoalsOnBoot}: every durable sub-agent/workflow row the DB still
   *  marks `running` at boot is a zombie, because the in-memory child registrations died with the process.
   *  Terminalize them ONCE, HERE. Boot is the only moment the blanket rule is sound — no live delegation can
   *  exist yet. The same sweep run lazily from start() cannot tell an orphan from a healthy delegation whose
   *  registration it simply cannot see, and killed live work from the outside on every client reconnect.
   *  Sweeping globally also repairs the state for good instead of hiding it per read, and reaches the
   *  channel/task sessions an owner start() never visits.
   *
   *  Only an autoDeliver child ever promised automatic delivery, so only it gets a synthetic "interrupted by
   *  daemon restart" result — enqueued durably, NOT delivered here: draining would respawn every orphaned
   *  conversation at boot. start() and the post-turn hook drain the inbox when the conversation is next used. */
  reconcileDelegationsOnBoot(): void {
    for (const sessionId of this.d.store.runningDelegationParentSessionIds()) {
      for (const run of this.d.store.getSubagentRuns(sessionId)) {
        if (run.status !== 'running') continue;
        // Preserve the detail + ORIGINAL flags — never fabricate background/autoDeliver.
        const terminal = {
          id: run.toolCallId, sessionId: run.sessionId, status: 'error' as const, task: run.task,
          ...(run.detail !== undefined ? { detail: run.detail } : {}),
          tools: run.tools, tokens: run.tokens, seconds: run.seconds, model: run.model,
          ...(run.background === true ? { background: true } : {}),
          ...(run.autoDeliver === true ? { autoDeliver: true } : {}),
        };
        if (!this.d.store.upsertSubagentRun(sessionId, terminal)) continue;
        if (run.autoDeliver !== true) continue;
        this.d.store.enqueueSubagentResult(sessionId, {
          id: syntheticRestartResultId(sessionId, run.toolCallId), toolCallId: run.toolCallId,
          sessionId: run.sessionId, status: 'error', task: run.task,
          error: 'sub-agent interrupted by daemon restart', tools: run.tools, tokens: run.tokens,
          seconds: run.seconds, model: run.model,
        });
      }
      // Same restart concern for workflows, minus the delivery half: WorkflowStart BLOCKS, so a restart
      // killed the tool call and its whole turn — there is no result anyone is still waiting on, and no
      // completion inbox to weave into. The row only has to stop claiming the DAG is still running.
      for (const run of this.d.store.getWorkflowRuns(sessionId)) {
        if (run.status !== 'running') continue;
        this.d.store.upsertWorkflowRun(sessionId, terminalizeWorkflow(run));
      }
    }
  }

  /** The model id the CURRENT config resolves to (readiness), or null — see BrainStatusService. */
  resolvableModel(): string | null {
    return this.statusView.resolvableModel();
  }

  /** One-turn connectivity probe on a throwaway session — see BrainStatusService.smokeTest. */
  async smokeTest(sel?: { providerId?: string; model?: string }): Promise<{ ok: boolean; model?: string; reply?: string; error?: string }> {
    return this.statusView.smokeTest(sel);
  }

  /** The daemon-wide plugin registry (undefined when plugins aren't wired at all). */
  private async resolvePlugins(): Promise<PluginRegistry | undefined> {
    return this.d.plugins?.get();
  }

  /** Manually compact a conversation (the /compact command): summarize the history so the context
   *  shrinks while the session stays usable. Targets the active conversation, or the caller's explicit
   *  `session` (a bound CLI). Serialized on the session lock (mirrors the channel variant) so it can't
   *  race an in-flight prompt(). A too-small/already-compacted session is a benign no-op
   *  (compacted:false), not an error. Throws only when nothing is running. */
  async compact(userId: number, session?: string, customInstruction?: string): Promise<CompactResult> {
    const sessionId = session ? this.lifecycle.ownedUserSession(userId, session) : this.lifecycle.activeSessionId(userId);
    if (!this.sessions.get(sessionId)) throw new Error('brain not started');
    return this.serial(sessionId, async () => {
      const live = this.sessions.get(sessionId);
      if (!live) throw new Error('brain not started');
      live.interactedAt = Date.now(); // a manual compact is a deliberate touch — don't idle-roll it over
      // A real compaction fires PI's `compaction_end`, which the factory's session subscription mirrors
      // into the store and the spawner fans `compacted` to attached clients — persistence + notify ride the
      // event, not this call. A no-op (session too small) emits no result and leaves the store untouched.
      const result = await runCompaction(live.session, customInstruction);
      result.usage = withDescendantUsage(result.usage, this.d.store.descendantUsage(live.sessionId));
      return result;
    });
  }

  /** Stop the streaming turn (the Esc key in chat clients) — on the active conversation, or on the
   *  caller's explicit `session` (a bound CLI). The agent settles into agent_end → the idle event, so
   *  subscribed clients wind down on their own. */
  async abort(userId: number, session?: string): Promise<void> {
    const b = session ? this.sessions.get(this.lifecycle.ownedUserSession(userId, session)) : this.lifecycle.activeLive(userId);
    if (!b) throw new Error('brain not started');
    // Esc/Stop before the turn produced any output discards the just-sent user turn: delete its durable
    // row and tell clients to pull the bubble + restore its text to the composer. Decided synchronously,
    // before the first await — JS is single-threaded, so turnProducedOutput cannot change under us between
    // this read and arming the guard; a token still in flight is then dropped by the reducer's guard.
    // Only abort() (the explicit Esc/Stop) does this — stopSession (client disconnect) and interruptQueued
    // keep the turn, so this deliberately lives here and not in abortFenced/abortLive.
    const discard = !b.turnProducedOutput ? b.lastAdmitted : undefined;
    if (discard) b.discardingUserTurn = discard.durableId;
    await this.abortFenced(b);
    if (discard) {
      this.d.store.deleteMessage(b.sessionId, discard.durableId);
      b.replay.publish({ type: 'discard_user', durableId: discard.durableId, text: discard.text });
      b.discardingUserTurn = undefined;
      b.lastAdmitted = undefined;
    }
  }

  /** Interrupt the current PI run and immediately promote the oldest native queued message into a fresh
   * owner turn. The parent-abort fence stays closed from queue snapshot through new-turn admission, so a
   * concurrent send cannot slip between abort and injection. Remaining messages are re-steered in their
   * original order with image/display/mode metadata intact. */
  async interruptQueued(
    userId: number,
    session?: string,
    client?: BoundClientRequest,
  ): Promise<{ interrupted: boolean; injected: boolean }> {
    const target = this.preflightSend(userId, session, client);
    const b = this.sessions.get(target);
    if (!b) throw new Error('brain not started');
    this.sessions.beginParentAbort(b.sessionId);
    try {
      // Snapshot BEFORE aborting. An empty queue means there is nothing to promote, so this is NOT an
      // interrupt: leave the running turn untouched and report it. The server is authoritative here (the
      // CLI Esc race #8) — a stale one-press must never destroy a live turn on an already-drained queue;
      // the client degrades to its normal two-press arming. `interrupted:true` ⇔ the turn was really aborted.
      const snapshot = this.queuedSnapshot(b);
      if (snapshot.length === 0) return { interrupted: false, injected: false };
      await this.abortLive(b);

      const requestFor = (message: QueuedMsg): TurnRequest => ({
        userId,
        // The clean model-facing text, never the durable copy: `persistText` carries the `[📎 …]` marker and
        // `message.text` the running-subagents block, both of which the fresh turn re-derives on its own.
        text: message.echo?.sourceText ?? message.text,
        images: message.images?.map(({ data, mimeType }) => ({ data, mimeType })),
        mode: message.echo?.mode ?? 'build',
        session: b.sessionId,
        display: message.echo?.displayText,
        client,
        interruptResume: true,
      });
      // Track how many queued messages were durably consumed (promoted or re-steered) so a mid-way failure
      // can restore exactly the un-consumed tail instead of silently dropping the user's backlog.
      let consumed = 0;
      try {
        const [first, ...remaining] = snapshot;
        const operation = this.startSend(requestFor(first!));
        void operation.completed.catch(async (error) => {
          try {
            const admittedSession = await operation.admitted;
            logger('brain-interrupt').error(`accepted interrupt turn failed for ${admittedSession}`, error);
            this.publishAcceptedSendFailure(admittedSession, error);
          } catch { /* pre-admission failure is rethrown below */ }
        });
        await operation.admitted;
        consumed = 1;
        for (const message of remaining) { await this.send(requestFor(message)); consumed += 1; }
        return { interrupted: true, injected: true };
      } catch (error) {
        // Promotion failed partway (the first turn never admitted, or a later re-steer was rejected). Put
        // the messages we never consumed back on the queue in their original order so the user does not lose
        // them, then surface the failure. Each restore is caught individually so one bad entry cannot block
        // the rest — the parent-abort fence is still held, so no concurrent send can interleave here.
        // Re-resolve the live session: a promoted image turn on a text-only model respawns the conversation
        // in place (maybeVisionHop disposes and re-creates the LiveBrain under the same id), so the `b` we
        // captured before the promotion can be a disposed shell whose queue and mirror nobody reads.
        const restoreTo = this.sessions.get(b.sessionId) ?? b;
        for (const message of snapshot.slice(consumed)) {
          try {
            await enqueueMirrored(restoreTo, 'steer', message.text, message.images, message.echo);
          } catch (restoreError) {
            logger('brain-interrupt').error(`failed to restore a queued message for ${b.sessionId}`, restoreError);
          }
        }
        throw error;
      }
    } finally {
      this.sessions.endParentAbort(b.sessionId);
    }
  }

  /** Snapshot PI's authoritative queue order while retaining Elowen's image/display metadata mirror. */
  private queuedSnapshot(live: LiveBrain): QueuedMsg[] {
    const copy = (items: readonly string[], mirror: readonly QueuedMsg[] | undefined): QueuedMsg[] =>
      items.map((text, index) => ({ ...(mirror?.[index] ?? { text }), text: mirror?.[index]?.text ?? text }));
    return [
      ...copy(live.session.getSteeringMessages(), live.queuedSteer),
      ...copy(live.session.getFollowUpMessages(), live.queuedFollowUp),
    ];
  }

  /** The direct children of `parentSessionId` that a parent abort (Esc / interruptQueued / stopSession)
   *  must SPARE: still-running detached/background delegates. Their results are durable in the inbox and
   *  are delivered independently of the parent's live turn (ensureLive respawns the parent if needed;
   *  restart reconcile sweeps any that die), so tearing them down on a parent stop would silently kill work
   *  the contract promised keeps running. Foreground blocking delegates are NOT spared — they belong to the
   *  interrupted turn. Same predicate the start() reconcile uses to decide auto-delivery. */
  private sparedChildSessionIds(parentSessionId: string): Set<string> {
    const spared = new Set(
      this.d.store.getSubagentRuns(parentSessionId)
        .filter((run) => run.status === 'running' && (run.background === true || run.autoDeliver === true))
        .map((run) => run.sessionId),
    );
    // A background workflow makes the same promise a detached delegate does, so its still-running NODE
    // sessions are spared on the same terms. Without this the engine correctly declined to cancel the
    // workflow while the abort cascade tore down the very children it was running in.
    for (const run of this.d.store.getWorkflowRuns(parentSessionId)) {
      if (run.status !== 'running' || run.background !== true) continue;
      for (const node of run.nodes) {
        if (node.status === 'running' && node.sessionId) spared.add(node.sessionId);
      }
    }
    return spared;
  }

  /** Stop the workflow engine for an aborted origin BEFORE its children are torn down: the engine would
   *  otherwise launch every ready node the moment an aborted one settles — fresh child sessions born
   *  after the abort, which nothing tears down (the user-visible symptom: Esc-Esc, workflow keeps going). */
  private async cancelWorkflowsFor(sessionId: string): Promise<void> {
    const registry = await this.d.plugins?.get();
    registry?.control('workflow')?.cancelForSession({ sessionId });
  }

  /** Shared destructive half of stop and queue-interrupt. Caller owns the parent-abort fence. */
  private async abortLive(b: LiveBrain): Promise<void> {
    this.goals.cancelGoalContinuation(b.sessionId);
    b.session.clearQueue();
    clearDeliveredUserEchoes(b);
    if (b.sessionId) this.elicitation.cancelForSession(b.sessionId, 'aborted');
    await this.cancelWorkflowsFor(b.sessionId);
    // Spare detached/background children; abort only the foreground delegates bound to this turn.
    const spared = this.sparedChildSessionIds(b.sessionId);
    const doomed = this.sessions.childrenOf(b.sessionId).filter((child) => !spared.has(child));
    await Promise.all(doomed
      .filter((child) => isChannelSession(child))
      .map((child) => this.channelService.abort(channelIdOf(child))));
    // Deregister ONLY the doomed children — a spared child MUST stay registered so it keeps counting toward
    // emitSubagent/status/reconcile/hasActiveChildren (channel eviction, /status, running-subagents block).
    for (const child of doomed) this.sessions.setChildRunning(b.sessionId, child, false);
    await abortSessionWork(b.session);
    b.session.clearQueue();
    clearDeliveredUserEchoes(b);
  }

  /** `abortLive` behind the parent-abort fence — the one entry point every caller that already HOLDS the
   *  live record uses. Fence before the child snapshot is taken inside: otherwise an idle drill-in
   *  continuation can register a fresh child between childrenOf() and the deregistration of the doomed
   *  ones, escaping this stop tree. */
  private async abortFenced(b: LiveBrain): Promise<void> {
    this.sessions.beginParentAbort(b.sessionId);
    try {
      await this.abortLive(b);
    } finally {
      this.sessions.endParentAbort(b.sessionId);
    }
  }

  /** Whether a client-initiated stop may interrupt this session's turn (Invariant 2). A detaching client
   *  must not abort a turn ANOTHER interactive client is watching. A stable client id identifies a terminal
   *  ending its own run, so only another stable client — or one mid-boot, which is on its way to watch —
   *  holds it off; an anonymous web-dock subscription merely watches and does not own the turn, so letting
   *  it veto meant an open browser tab silently disabled ctrl+c. A caller with no id cannot be told apart
   *  from a passive stream, so it keeps the conservative any-attachment rule. */
  private mayAbortOnStop(sessionId: string, clientId?: string): boolean {
    if (this.attachments.hasPendingStartClaim(sessionId)) return false;
    return clientId
      ? !this.attachments.hasLiveStableClient(sessionId)
      : this.attachments.attachedCount(sessionId) === 0;
  }

  /** Whether `sessionId` is safe for `bindChannelContext` to re-key onto a new id right now — the
   *  review's smallest safe fix for the `/context` move (Tier 2 #13): refuse the bind rather than migrate
   *  every sidecar map that is keyed on the OLD id (attachments, live children, processRegistry, the goal
   *  loop). Fails closed like `sessionIsIdle` below, but deliberately does NOT take its "`!live` → idle"
   *  shortcut: a background delegate, a workflow node or a goal continuation can all still be keyed on
   *  this id with no LiveBrain currently spawned in memory, and re-keying it would orphan them exactly as
   *  it would if the session were live. */
  private isBindQuiescent(sessionId: string): boolean {
    if (this.sessions.get(sessionId)?.session.isStreaming) return false;
    // An attached client stream (web dock, CLI tap/subscribe) or a mid-boot start claim both read/write
    // through the OLD id; neither follows a bare `reassignSession`, so either would go dark or misfire.
    if (this.attachments.attachedCount(sessionId) !== 0 || this.attachments.hasPendingStartClaim(sessionId)) return false;
    if (this.sessions.hasActiveChildren(sessionId) || this.sparedChildSessionIds(sessionId).size > 0) return false;
    if (processRegistry.runningJobCountForSession(sessionId) > 0) return false;
    if (this.d.store.getGoal(sessionId)?.status === 'active') return false;
    return true;
  }

  /** Whether this conversation has WORK in flight — a running turn, anything queued behind it, a parked
   *  question, a still-running child/workflow/background job, or an armed goal continuation. Deliberately
   *  FAIL-CLOSED: every uncertain signal counts as busy, because the two callers (a detach-only stop and
   *  the idle reaper) both destroy a live runtime when it answers false, and the cost of a false "idle" is
   *  killed work while the cost of a false "busy" is a runtime that lives one sweep longer. */
  private sessionIsIdle(sessionId: string): boolean {
    const live = this.sessions.get(sessionId);
    if (!live) return true; // nothing live to protect
    if (live.session.isStreaming) return false;
    if (this.sessions.isParentAborting(sessionId) || this.sessions.hasPendingAbort(sessionId)) return false;
    if (live.session.getSteeringMessages().length > 0 || live.session.getFollowUpMessages().length > 0) return false;
    if (live.queuedSteer?.length || live.queuedFollowUp?.length) return false;
    if (live.pendingCompactionEchoes?.length || live.deliveringUserEchoes?.length) return false;
    if (this.elicitation.pendingForSession(sessionId) !== null) return false;
    // Foreground children plus the detached/background delegates and workflow nodes that deliver their
    // results back INTO this conversation — tearing the parent down would strand every one of them.
    if (this.sessions.hasActiveChildren(sessionId) || this.sparedChildSessionIds(sessionId).size > 0) return false;
    if (processRegistry.runningJobCountForSession(sessionId) > 0) return false;
    // An active goal re-prompts this very session from a timer, so it is work in flight even between turns.
    if (this.d.store.getGoal(sessionId)?.status === 'active') return false;
    return true;
  }

  /** Final teardown of one live conversation, shared by the last-watcher stop and the idle reaper. The
   *  caller owns the `markDisposing` guard and the session lock. */
  private disposeLiveSession(sessionId: string, reason: string): void {
    this.goals.cancelGoalContinuation(sessionId);
    this.elicitation.cancelForSession(sessionId, reason);
    this.cards.clearSession(sessionId);
    this.sessions.dispose(sessionId);
  }

  /** A CLI is closing: stop its bound run and release the live PI session unless another INTERACTIVE
   *  client (one identifying itself with a stable client id) is still on this conversation. A passive
   *  web-dock subscription does not hold the turn open — it only watches. History stays in SQLite and can
   *  be resumed. Idempotent for an already-stopped conversation.
   *
   *  `detachOnly` (the web beacon) keeps the binding release but refuses the destructive half unless the
   *  conversation is idle: closing the last browser tab over a RUNNING agent must never kill it — that is
   *  what the Stop button is for. The abandoned runtime is collected later by reapIdleLiveSessions. The
   *  CLI omits the flag and keeps its original semantics (closing the terminal aborts its own run). */
  async stopSession(userId: number, session?: string, clientId?: string, clientGeneration?: number, opts?: { detachOnly?: boolean }): Promise<{ stopped: boolean; disposed: boolean }> {
    // Consume the authenticated client's attachment FIRST. Its binding follows idle rollover inside the
    // daemon, so it is more authoritative than the (possibly pre-rollover) id the CLI last observed.
    // Releasing invokes only this client's stream disposer; every other attachment remains counted.
    const released = clientId
      ? this.attachments.release(userId, clientId, clientGeneration)
      : { accepted: true as const, sessionId: undefined };
    // A delayed stop from generation N must not abort a newer N+1 selection owned by the same CLI id.
    if (!released.accepted) return { stopped: false, disposed: false };
    const bound = released.sessionId;
    // A bootstrap/start failure can issue a generation stop before the daemon ever created a binding.
    // `release()` has still tombstoned that generation (so a delayed start cannot resurrect it), but with
    // no stable target and no explicit session body it must not guess the user's unrelated active session.
    if (clientId && !bound && !session) return { stopped: false, disposed: false };
    const cleanUp = async (sessionId: string): Promise<{ stopped: boolean; disposed: boolean }> => {
      const live = this.sessions.get(sessionId);
      if (!live) return { stopped: false, disposed: false };
      // The caller's own attachment was released above, so a zero count now unambiguously means no other
      // observer. A detaching client MUST NOT abort a turn another client is still watching (Invariant 2):
      // only the last watcher leaving may abort + dispose. Legacy callers without a stable id retain the
      // conservative behavior — only an already-detached stream can make the count zero.
      // A claimed-but-not-yet-streaming start counts as an observer. It is a client mid-boot — a `--resume`
      // that has been handed the session and is still opening its SSE — and counting only live streams
      // disposes the conversation out from under it, leaving its stream dark until some later send
      // respawns. availableForDefaultStart already treats a claim as occupancy for the same reason.
      // Same predicate the pre-lock abort used, re-evaluated because a client can attach while this waited
      // on the session lock. Deciding it twice with two copies of the rule is how they drift apart.
      if (!this.mayAbortOnStop(sessionId, clientId)) return { stopped: true, disposed: false };
      // A detaching web tab may release its binding but never tear down work in flight.
      if (opts?.detachOnly && !this.sessionIsIdle(sessionId)) return { stopped: false, disposed: false };
      // From here the record stays registered while we await, but it is doomed. Mark it so a concurrent
      // ensureLive() queues on the session lock and respawns behind the dispose, instead of fast-pathing
      // onto a handle this teardown is about to throw away.
      this.sessions.markDisposing(sessionId);
      // Everything from the mark to the dispose runs under this guard: dispose() clears the marker itself,
      // and the abandoned-teardown path clears it explicitly, but a throw in between (a goal, elicitation
      // or card teardown) would strand it — pinning a perfectly healthy session on the slow path forever.
      try {
        // Abort through the record this teardown already holds, NOT the public abort(): that one throws a
        // bare 'brain not started' for an already-settled conversation, so catching it here also swallowed
        // a REAL failure — a workflow that refused to cancel, a foreground delegate that stayed up, a PI
        // turn that never unwound — and disposed the parent anyway, leaving that work running with nothing
        // above it. Nothing live to abort is the only benign case, and it cannot happen under this lock.
        await this.abortFenced(live);
        // Re-check after the abort settles: a client can attach during that await, and it must not be
        // disposed out from under. If one arrived, leave the (now idle) session live for the new observer.
        // Deliberately NOT counting a pending claim here, unlike the gate above: a start that arrives once
        // the teardown is already committed is expected to queue on the session lock and respawn behind the
        // dispose — that ordering is the whole point of the disposing marker, and honouring the claim here
        // would hand it the very record the teardown is about to drop.
        if (this.attachments.attachedCount(sessionId) !== 0) {
          this.sessions.clearDisposing(sessionId); // teardown abandoned — the record is healthy again
          return { stopped: true, disposed: false };
        }
        this.disposeLiveSession(sessionId, 'client closed');
      } catch (e) {
        this.sessions.clearDisposing(sessionId);
        throw e;
      }
      // A conversation nobody ever typed into leaves with the session it was the identity of, rather than
      // lingering as an untitled shell until some later `/new` sweeps it up.
      this.lifecycle.dropIfUnspoken(sessionId);
      return { stopped: true, disposed: true };
    };
    // Reserve the bare session lock BEFORE any wait/ownership lookup. `settled(bound)` outside this lock
    // can race a replacement start (and can deadlock when that lifecycle holder waits on this cleanup).
    // Once queued here, a start either finishes first and this stops that exact live instance, or waits
    // behind us and creates a fresh one only after the old instance was disposed.
    const target = bound
      ? this.lifecycle.ownedUserSession(userId, bound)
      : session ? this.lifecycle.ownedUserSession(userId, session) : this.lifecycle.activeSessionId(userId);
    // Interrupt the in-flight work BEFORE queueing on the session lock. A running turn HOLDS that lock, so
    // a teardown that serializes first waits for the very turn it exists to interrupt: ctrl+c did nothing
    // until the work ended on its own. (`/stop` never had the bug — it calls abort() straight out.)
    // Only the PI-level interrupt, never the full abort(): abort() throws on an already-stopped session
    // and stopSession must stay idempotent. The serialized teardown below still does the real cascade.
    const runningLive = this.sessions.get(target);
    // A detach-only stop never interrupts: it may only reach the teardown below for an IDLE session, and
    // an idle session has no turn to interrupt. Skipping it here is what keeps the beacon non-destructive
    // — this pre-lock signal lands before `cleanUp` can veto anything.
    if (!opts?.detachOnly && runningLive && this.mayAbortOnStop(target, clientId)) {
      // Signal only — deliberately NOT awaited, so cleanUp reserves the lock in THIS tick. Awaiting would
      // let a start arriving during the interrupt take the lock first, breaking "a start racing a teardown
      // respawns behind the dispose". This DOES leave a window where the turn is dying but the session is
      // not yet marked disposing (the marker is set under the lock): what closes it is cleanUp re-checking
      // claims and attachments, not the marker. Note the cost — a veto there can no longer save the turn,
      // because the interrupt has already landed.
      // A turn parked on AskUserQuestion or a permission prompt is NOT PI-level work: the agent loop is
      // awaiting the tool's own promise and only re-checks the abort signal once that settles, so the
      // interrupt below cannot unwind it and the lock would stay held until the question is answered or
      // times out (5 min by default). Release the parked turn first — synchronous, so the lock is still
      // reserved in this tick. abortLive does the same in the same order for the same reason.
      this.elicitation.cancelForSession(target, 'client closed');
      void abortSessionWork(runningLive.session).catch((err: unknown) => {
        // The serialized abort below normally reports the outcome — but if this interrupt is what failed,
        // the turn may never release the lock and the teardown silently waits it out again. Leave a trace.
        logger('brain').warn(`stop ${target}: interrupt failed — ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return this.serial(target, async () => cleanUp(target));
  }

  /** Whether this live conversation is a candidate for the idle reaper right now: no client watching it
   *  in any form, and no work in flight. Channel/task sessions are excluded — they have their own LRU. */
  private reapableNow(sessionId: string): boolean {
    if (isNonUserSession(sessionId)) return false;
    if (!this.sessions.has(sessionId) || this.sessions.isDisposing(sessionId)) return false;
    if (this.sessions.isActiveChild(sessionId)) return false;
    if (this.attachments.attachedCount(sessionId) !== 0) return false;
    if (this.attachments.hasLiveStableClient(sessionId) || this.attachments.hasPendingStartClaim(sessionId)) return false;
    return this.sessionIsIdle(sessionId);
  }

  /** Periodic sweep (daemon bootstrap, 60s): dispose live PI sessions that nobody has watched and nothing
   *  has run in for a full SESSION_IDLE_ROLLOVER_MS. This is the counterpart of the non-destructive web
   *  stop — a client's binding expires on its own TTL, but before this nothing ever released the RUNTIME,
   *  so a tab closed over a running agent leaked its session until the daemon restarted. Returns the ids
   *  reaped. History stays in SQLite; the next message respawns the conversation. */
  async reapIdleLiveSessions(now: number = Date.now()): Promise<string[]> {
    const due = this.idleClock.due(
      this.sessions.liveEntries().map(([sessionId]) => ({ sessionId, reapable: this.reapableNow(sessionId) })),
      now,
      SESSION_IDLE_ROLLOVER_MS,
    );
    const reaped: string[] = [];
    for (const sessionId of due) {
      const idleFor = now - (this.idleClock.reapableSince(sessionId) ?? now);
      await this.serial(sessionId, async () => {
        // Re-check under the lock: a client can attach, or a turn start, while earlier reaps awaited.
        if (!this.reapableNow(sessionId)) return;
        this.sessions.markDisposing(sessionId);
        try { this.disposeLiveSession(sessionId, 'idle session reaped'); }
        catch (e) { this.sessions.clearDisposing(sessionId); throw e; }
        this.idleClock.forget(sessionId);
        reaped.push(sessionId);
        logger('brain').info(`reaped idle live session ${sessionId} (unwatched and idle for ${Math.round(idleFor / 60_000)}m)`);
      });
    }
    return reaped;
  }

  /** Settle a parked `AskUserQuestion` with the user's picks (from POST /brain/answer or a Discord
   *  interaction). Deliberately NOT serialized: the parked turn holds the session lock, so resolving
   *  through the lock would deadlock — it just resolves the registry Promise directly. Returns whether
   *  a pending question matched (false for an unknown/expired id — tolerated). */
  answerQuestion(id: string, answers: AskAnswer[], ownerUserId?: number): boolean {
    // When answered via the owner HTTP route, authorize: the caller may only settle a question parked in
    // their OWN owner-chat conversation — never someone else's, and never a shared channel session (those
    // resolve in-process from the platform adapter, which gates the interaction itself). Omitted for the
    // trusted in-process path (Discord), which has already authorized the responder.
    if (ownerUserId !== undefined) {
      const sid = this.elicitation.sessionOf(id);
      if (!sid || isNonUserSession(sid)) return false;
      const row = this.d.store.getSession(sid);
      if (!row || row.user_id !== ownerUserId) return false;
    }
    return this.elicitation.answer(id, answers);
  }

  /** Switch a conversation to another configured model (/model) — see ConversationLifecycle. */
  async switchModel(userId: number, sel: { provider?: string; model?: string }, session?: string): Promise<{ model: string }> {
    return this.lifecycle.switchModel(userId, sel, session);
  }

  /** Record that the client moved its working directory (the CLI's /cd), as a visible marker plus a
   *  one-shot notice telling the agent on its next turn.
   *
   *  The directory itself needs no plumbing: every turn already reports the client's cwd and it beats the
   *  session's stored one. What it does NOT do is tell the MODEL — that is composed once, when the session
   *  spawns, so without this the agent keeps describing the directory it started in until something
   *  respawns it. The marker closes exactly that gap, the same way a model or reasoning switch does.
   *
   *  Policy-checked, not merely recorded: an unreachable directory is the caller's mistake and the agent
   *  must not be told the work moved somewhere it cannot go. */
  noteWorkDir(userId: number, dir: string, session?: string): { workDir: string } {
    const b = session ? this.sessions.get(this.lifecycle.ownedUserSession(userId, session)) : this.lifecycle.activeLive(userId);
    if (!b) throw new Error('brain not started');
    const resolved = clientDir(b.policy, dir);
    if (!resolved) throw new Error('directory is not readable or not allowed');
    // Assigning is what makes the comparison mean "has it moved since we last said so". `workDir` is
    // otherwise written once at spawn and only carried across respawns, so without this the guard forever
    // compares against the launch directory: it would re-announce every /cd to a directory that is not the
    // launch one, and stay silent on a move BACK to it. It also keeps the per-turn fallback honest — a
    // goal continuation carries no client cwd and would otherwise resolve where the session started.
    if (resolved !== b.workDir) {
      recordSessionEvent(this.d.store, b.sessionId, b, 'cwd', resolved);
      b.workDir = resolved;
    }
    return { workDir: resolved };
  }

  /** Set the reasoning effort of the ACTIVE conversation live (the /think command) — PI applies it to
   *  the running session without a respawn, unlike a model switch. A level the current model doesn't
   *  support is clamped by PI. Returns the effective level. Session-scoped (like /model): the saved
   *  per-user default in Account → CLI is unchanged. */
  async setThinkingLevel(userId: number, level: string, session?: string): Promise<{ thinkingLevel: string }> {
    const b = session ? this.sessions.get(this.lifecycle.ownedUserSession(userId, session)) : this.lifecycle.activeLive(userId);
    if (!b) throw new Error('brain not started');
    const sess = b.session as { setThinkingLevel?: (l: string) => void; thinkingLevel?: string; getAvailableThinkingLevels?: () => string[] };
    const model = b.session.model as Model<Api> | undefined;
    const canonical = model ? canonicalThinkingLevel(model, level) : level;
    const available = new Set(sess.getAvailableThinkingLevels?.() ?? CANONICAL_THINKING_LEVELS);
    if (!available.has(canonical)) throw new Error(`model does not support reasoning effort "${level}"`);
    const prevLevel = b.thinkingLevel;
    sess.setThinkingLevel?.(canonical);
    b.thinkingLevel = canonical;
    b.interactedAt = Date.now(); // a reasoning-effort change is a deliberate touch — don't idle-roll it over
    // The level above applied immediately; only the MARKER is debounced, so ctrl+r cycling through the
    // ladder lands one marker with the settled level instead of one per keypress.
    scheduleReasoningMarker(this.d.store, b, prevLevel, canonical);
    return { thinkingLevel: (sess.thinkingLevel as string) ?? canonical };
  }

  /** Toggle ChatGPT OAuth priority processing for one live conversation. */
  setFast(userId: number, on?: boolean, session?: string): { fast: boolean; fastAvailable: boolean } {
    const b = session ? this.sessions.get(this.lifecycle.ownedUserSession(userId, session)) : this.lifecycle.activeLive(userId);
    if (!b) throw new Error('brain not started');
    if (!b.fastAvailable) throw new Error('Fast mode is available only for OpenAI OAuth models');
    b.requestProfile.fast = on ?? !b.requestProfile.fast;
    b.interactedAt = Date.now();
    return { fast: b.requestProfile.fast, fastAvailable: true };
  }

  /** Chat-client status — of the active conversation, or of the caller's explicit `session` (a bound
   *  CLI) — see BrainStatusService.status. */
  status(userId: number, session?: string): BrainStatusView {
    return this.statusView.status(userId, session);
  }

  /** The caller's pending mid-turn message backlog (PI's transient steered + follow-up snapshot) — of the
   *  active conversation, or of the caller's explicit `session` (a bound CLI). Empty when nothing is
   *  pending or no conversation is live. */
  queueList(userId: number, session?: string): { id: string; text: string }[] {
    const sessionId = session ? this.lifecycle.ownedUserSession(userId, session) : this.sessions.activeIdFor(userId);
    const live = sessionId ? this.sessions.get(sessionId) : undefined;
    return live ? queuedWithPending(live) : [];
  }

  /** Remove ONE pending mid-turn message (the CLI ctrl+x / the web × button). PI's steering queue holds
   *  bare strings with no ids and offers only a clear-all, so we target by POSITION (the same positional
   *  id `queueItems` hands clients): drain the queue, then re-queue everything except the targeted index.
   *  Re-queues from our image-carrying mirror (queuedSteer/queuedFollowUp), NOT PI's text-only accessors —
   *  PI's clearQueue drops image attachments, so re-steering from text alone would strip the surviving
   *  messages' images. An out-of-range id is a no-op. Returns whether a message was actually removed. */
  queueRemove(userId: number, id: string, session?: string): boolean {
    const sessionId = session ? this.lifecycle.ownedUserSession(userId, session) : this.sessions.activeIdFor(userId);
    const live = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!live) return false;
    const steering = live.queuedSteer ?? [];
    const followUp = live.queuedFollowUp ?? [];
    const idx = Number(id);
    if (!Number.isInteger(idx) || idx < 0 || idx >= steering.length + followUp.length) return false;
    // Snapshot WITH images before clearQueue empties both PI's queue and (via queue_update) our mirror.
    const combined = [
      ...steering.map((m) => ({ kind: 'steer' as const, ...m })),
      ...followUp.map((m) => ({ kind: 'followUp' as const, ...m })),
    ];
    live.session.clearQueue();
    clearDeliveredUserEchoes(live);
    // Re-queue in the same order, dropping the positional target, preserving each survivor's images.
    // `steer`/`followUp` only enqueue while the turn is streaming (a queue only exists mid-turn), so
    // nothing runs a fresh turn; enqueueMirrored keeps the mirror in step.
    combined.forEach((m, i) => {
      if (i !== idx) void enqueueMirrored(live, m.kind, m.text, m.images, m.echo);
    });
    return true;
  }

  /** Pop the LAST pending mid-turn message and hand back its text — the CLI ↑-recall (restores it to the
   *  composer) and ctrl+x remove-last (drops it). Unlike queueRemove's positional targeting, this pops by
   *  VALUE from the daemon's authoritative queue mirror. A client's cached positional id goes stale the
   *  moment PI delivers a queued message between steps, so a positional remove issued mid-stream can
   *  mis-target or no-op and leave the message both queued and re-sendable — the duplicate the ↑-recall
   *  produced. Popping the real current tail server-side removes that race. Returns { text: null } when
   *  nothing is pending (e.g. the message was delivered before the key landed). */
  queueRecall(userId: number, session?: string): { text: string | null } {
    const sessionId = session ? this.lifecycle.ownedUserSession(userId, session) : this.sessions.activeIdFor(userId);
    const live = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!live) return { text: null };
    const steering = live.queuedSteer ?? [];
    const followUp = live.queuedFollowUp ?? [];
    if (steering.length + followUp.length === 0) return { text: null };
    // Snapshot WITH images before clearQueue empties both PI's queue and (via queue_update) our mirror —
    // then re-queue every survivor except the tail, preserving order and each message's attachments.
    const combined = [
      ...steering.map((m) => ({ kind: 'steer' as const, ...m })),
      ...followUp.map((m) => ({ kind: 'followUp' as const, ...m })),
    ];
    const target = combined[combined.length - 1]!;
    const text = target.echo?.displayText ?? target.text;
    live.session.clearQueue();
    clearDeliveredUserEchoes(live);
    combined.slice(0, -1).forEach((m) => void enqueueMirrored(live, m.kind, m.text, m.images, m.echo));
    return { text };
  }

  /** Flip the SESSION-scoped YOLO override (the CLI `/yolo` command) — see PermissionApprovalService.
   *  Throws when no conversation is live. */
  setYolo(userId: number, on?: boolean, session?: string): { yolo: boolean } {
    const b = session ? this.sessions.get(this.lifecycle.ownedUserSession(userId, session)) : this.lifecycle.activeLive(userId);
    if (!b) throw new Error('brain not started');
    return this.permissionSvc.setYolo(userId, b, on);
  }

  /** Delete one of the user's stored conversations (never a channel session, never someone else's).
   *  A live session is disposed first; deleting the active conversation just clears the pointer —
   *  the next start() falls back to the most recent remaining one. */
  deleteSession(userId: number, sessionId: string): void {
    const row = this.d.store.getSession(sessionId);
    if (!isOwnedUserSession(row, userId, sessionId)) throw new Error('unknown session');
    this.teardownDeletedSession(userId, sessionId);
    this.d.store.deleteSession(sessionId);
  }

  /** Everything a conversation owns, released before its row is dropped — shared by the user-facing
   *  delete and the admin one so the two cannot drift apart (they already had: only one of them cleared
   *  the active pointer and the card cache, so an admin delete of the active conversation left
   *  `activeSessionId` naming a row that no longer existed).
   *
   *  A delete spares nothing, unlike a stop: a detached delegate or a background workflow keeps burning
   *  tokens for an inbox that has ceased to exist. */
  private teardownDeletedSession(userId: number, id: string): void {
    // Tear down any chat terminal bound to this conversation FIRST (docs order: terminal, then session).
    // Fire-and-forget — the delete paths are sync and the binding row outlives store.deleteSession
    // (separate table), so the async teardown still resolves the row; the janitor is the backstop if
    // it's unwired. No-op when the conversation has no bound terminal (channel/task sessions never do).
    void this.terminalTeardown?.(userId, id).catch((e) => logger('brain').error(`terminal teardown failed for ${id}`, e));
    this.cleanupProcessesForTree(id);
    this.cancelDelegatedWorkFor(id);
    this.elicitation.cancelForSession(id, 'conversation deleted'); // release a parked turn before dropping its session
    this.goals.cancelGoalContinuation(id);
    this.cards.clearSession(id);
    if (isChannelSession(id)) this.sessions.channelDispose(channelIdOf(id));
    else this.sessions.dispose(id);
    // The in-memory pointer must not survive the row it names, or status/send would keep answering for a
    // conversation that no longer exists (lifecycle.activeSessionId trusts the pointer verbatim).
    if (this.sessions.activeIdFor(userId) === id) this.sessions.clearActive(userId);
  }

  /** Stop the DELEGATED work a deleted conversation is still driving: the workflow DAG that keeps
   *  launching fresh nodes into it, and every running delegated child whose result now has nowhere to be
   *  delivered. cleanupProcessesForTree reaches only the shell processes those children spawned, never
   *  the agent turns themselves.
   *
   *  Fired and logged rather than awaited: the workflow control lives behind the plugin registry (async)
   *  while both delete entry points are synchronous — the same contract the terminal teardown above uses.
   *  Cancel the engine BEFORE the children, or it relaunches a node the moment an aborted one settles. */
  private cancelDelegatedWorkFor(id: string): void {
    const children = this.sessions.childrenOf(id);
    void (async () => {
      await this.cancelWorkflowsFor(id);
      for (const child of children) {
        if (isChannelSession(child)) await this.channelService.abort(channelIdOf(child));
        this.sessions.setChildRunning(id, child, false);
      }
    })().catch((e) => logger('brain').error(`delegated teardown failed for ${id}`, e));
  }

  renameSession(userId: number, sessionId: string, title: string): { id: string; title: string } {
    const row = this.d.store.getSession(sessionId);
    const clean = title.trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!isOwnedUserSession(row, userId, sessionId)) throw new Error('unknown session');
    if (!clean) throw new Error('title cannot be empty');
    const changed = row.title !== clean;
    this.d.store.renameSession(sessionId, clean);
    // A visible marker + one-shot notice when the conversation is live; when it isn't (renamed from the
    // picker), the marker is simply persisted for the next transcript load.
    if (changed) recordSessionEvent(this.d.store, sessionId, this.sessions.get(sessionId), 'rename', clean);
    return { id: sessionId, title: clean };
  }

  goalStatus(userId: number, session?: string): BrainGoalRow | null {
    return this.goals.goalStatus(userId, session);
  }

  async setGoal(userId: number, text: string, opts?: { draft?: boolean; turnBudget?: number }, session?: string): Promise<BrainGoalRow> {
    return this.goals.setGoal(userId, text, opts, session);
  }

  goalAction(userId: number, action: 'pause' | 'resume' | 'clear', session?: string): BrainGoalRow | null {
    return this.goals.goalAction(userId, action, session);
  }

  subgoal(userId: number, action: 'add' | 'remove' | 'clear', value?: string | number, session?: string): BrainGoalRow {
    return this.goals.subgoal(userId, action, value, session);
  }

  /** The user's conversations with live/active/attached flags — see BrainStatusService.listSessions.
   *  Pagination is opt-in: no `opts` → the historical bare array; with `opts` → a paged window. */
  listSessions(userId: number): SessionListItem[];
  listSessions(userId: number, opts: SessionPageOpts): SessionPage<SessionListItem>;
  listSessions(userId: number, opts?: SessionPageOpts): SessionListItem[] | SessionPage<SessionListItem> {
    return opts ? this.statusView.listSessions(userId, opts) : this.statusView.listSessions(userId);
  }

  /** The caller's conversations eligible to bind into a channel (the /context picker) — the bare default
   *  is excluded. Always paginated — see BrainStatusService.listContextSessions. */
  listContextSessions(userId: number, opts?: SessionPageOpts): SessionPage<SessionListItem> {
    return this.statusView.listContextSessions(userId, opts);
  }

  /** Bind (MOVE, not fork) one of the caller's own conversations INTO a platform channel slot so the
   *  channel's next turn continues in that conversation's history. IRREVERSIBLE by design: the chosen
   *  session is re-keyed onto the deterministic `brain-ch-<channel>` id, and whatever occupied the slot
   *  is archived under a fresh id (nothing is lost, exactly like idle rollover). Guards: only the caller's
   *  OWN sessions are bindable (owner-scope); never the bare default `brain-<uid>` (re-keying it would
   *  strip the user's default id) and never a channel/task session; a session can hold only one slot, so a
   *  second bind of the same id finds nothing and throws. Serialized on the channel session lock so it
   *  cannot race that channel's turn/compact/rollover. Returns the bound conversation's title for the
   *  adapter's confirmation message. */
  async bindChannelContext(callerUserId: number, channelKey: string, chosenSessionId: string): Promise<{ title: string }> {
    // Guard (b), id-only so it needs no store read: the bare default must never be re-keyed, and only a
    // real personal conversation (not a channel/task shell) may move into a shared channel.
    if (chosenSessionId === defaultUserSessionId(callerUserId) || isNonUserSession(chosenSessionId)) {
      throw new Error('this conversation cannot be bound to a channel');
    }
    const channelSession = channelSessionId(channelKey);
    // The channel session lock (same key the channel turn/compact/rollover take) serializes the whole move.
    return this.serial(channelSession, async () => {
      // Guards (a) + (c), resolved INSIDE the lock: only the caller's own session is bindable, and a second
      // bind of an already-moved id finds nothing here (the id ceased to exist on the first bind).
      const row = this.d.store.getSession(chosenSessionId);
      if (!row || row.user_id !== callerUserId) throw new Error('unknown session');
      // Smallest safe fix for the /context move (Tier 2 #13): durable bindings move with reassignSession
      // below, but the in-memory maps (attachments, live children, processes, the goal loop) do not, so a
      // session with real work still keyed on its OLD id would be orphaned by the move — refuse it
      // outright rather than migrate every one of those maps (judged needlessly risky).
      if (!this.isBindQuiescent(chosenSessionId)) {
        throw new Error('this conversation has work in progress and cannot be moved into a channel right now');
      }
      // A bound `elowen chat` terminal was launched with `--session <chosenSessionId>`; the re-key below
      // moves that id out from under it, so its tmux would resume a gone id and the next sweep would reap
      // it as 'conversationGone' — killing the live pane and revoking its token. Tear it down cleanly
      // first (mirrors deleteSession), a no-op when the conversation has no bound terminal.
      void this.terminalTeardown?.(callerUserId, chosenSessionId).catch((e) => logger('brain').error(`terminal teardown failed for ${chosenSessionId}`, e));
      // Live-session safety: a conversation open in web/CLI must not have its id changed underneath the
      // live PI object — dispose it and clear the active pointer first (mirrors deleteSession).
      if (this.sessions.get(chosenSessionId)) this.sessions.dispose(chosenSessionId);
      if (this.sessions.activeIdFor(callerUserId) === chosenSessionId) this.sessions.clearActive(callerUserId);
      // Clear the chosen session's in-memory sidecar state keyed on its OLD id before the re-key: the durable
      // rows move with reassignSession, but a goal-continuation timer, a parked question, or the cards cache
      // would otherwise dangle on an id that ceases to exist. Background processes/subagents are deliberately
      // NOT torn down — this is a move that keeps the work, not a delete.
      this.goals.cancelGoalContinuation(chosenSessionId);
      this.elicitation.cancelForSession(chosenSessionId, 'moved to channel');
      this.cards.clearSession(chosenSessionId);
      // Mirror the channel rollover (channels.ts): drop the live PI on the slot, ARCHIVE whatever occupies
      // `brain-ch-<key>` under a fresh id (a no-op touching 0 rows if the channel never spawned), then MOVE
      // the chosen session into the now-free deterministic channel slot in one transaction.
      this.sessions.channelDispose(channelKey);
      this.d.store.reassignSession(channelSession, archivedChannelSessionId(channelKey));
      this.d.store.reassignSession(chosenSessionId, channelSession);
      return { title: this.d.store.getSession(channelSession)?.title ?? '' };
    });
  }

  /** Fulltext search across the user's stored conversations — see BrainStatusService.searchMessages. */
  searchMessages(userId: number, query: string): BrainSearchHit[] {
    return this.statusView.searchMessages(userId, query);
  }

  /** ADMIN session-management view (the sessions/ panel) — see BrainStatusService.listManagedSessions. */
  listManagedSessions(userId: number): ManagedSessionView[] {
    return this.statusView.listManagedSessions(userId);
  }

  /** Delete ANY of the owner's brain sessions by id (admin panel) — disposing a live conversation or
   *  channel session first. Deliberately bypasses the isNonUserSession guard: this IS the management
   *  surface. Returns how many were deleted (0 or 1). */
  deleteManagedSession(userId: number, id: string): number {
    const row = this.d.store.getSession(id);
    if (!row || row.user_id !== userId) return 0;
    this.teardownDeletedSession(userId, id);
    this.d.store.deleteSession(id);
    return 1;
  }

  private cleanupProcessesForTree(id: string): void {
    const stack = [id];
    for (let index = 0; index < stack.length; index += 1) {
      const sessionId = stack[index]!;
      processRegistry.killSession(sessionId);
      for (const child of this.d.store.getSubagentRuns(sessionId)) stack.push(child.sessionId);
    }
  }

  /** Every delegated descendant session id under `id` (breadth-first via the sub-agent run tree), the
   *  root excluded. The janitor uses this to purge a stale conversation's sub-agent transcripts WITH it —
   *  deleteSession only detaches children to top-level, where their `brain-ch-` prefix then excludes them
   *  from staleConversationIds forever, leaking the transcripts. */
  private descendantSessionIds(id: string): string[] {
    const out: string[] = [];
    const stack = [id];
    for (let index = 0; index < stack.length; index += 1) {
      for (const child of this.d.store.getSubagentRuns(stack[index]!)) { out.push(child.sessionId); stack.push(child.sessionId); }
    }
    return out;
  }

  /** Delete ALL of the owner's brain sessions (the panel's "delete everything" — the client confirms).
   *  Returns the count removed. */
  deleteAllManagedSessions(userId: number): number {
    let n = 0;
    for (const s of this.d.store.listSessions(userId)) n += this.deleteManagedSession(userId, s.id);
    return n;
  }

  /** Retention janitor: delete this user's own idle top-level conversations older than `days`. The store
   *  query already excludes non-user shells, delegated children and unspoken rows; here we add the live
   *  exclusions it cannot see — a running session, the user's active conversation, any session whose
   *  sub-agent is still running (deleting it would kill that child), and any conversation a PENDING cron
   *  wake-up was scheduled FROM (purging it would strand the wake-up's context and demote its reply to
   *  the notification channel). Returns the count removed. */
  async purgeStaleSessionsForUser(userId: number, days: number): Promise<number> {
    // The cronjob plugin owns the wake-up jobs, so ask through its typed control; with the plugin
    // disabled/absent no control is registered → nothing to protect. A failed plugin LOAD rejects
    // instead — fail closed (the sweep skips, the caller logs) rather than delete a conversation a
    // wake-up may still need.
    const cron = (await this.resolvePlugins())?.control('cron');
    const pendingOrigins = new Set(cron?.pendingWakeupOriginSessionIds(userId) ?? []);
    const activeId = this.lifecycle.activeSessionId(userId);
    let n = 0;
    for (const id of this.d.store.staleConversationIds(userId, days)) {
      if (id === activeId || pendingOrigins.has(id)) continue;
      if (this.sessions.has(id) || this.sessions.hasActiveChildren(id)) continue;
      // Purge the whole delegated tree, not just the root: collect the sub-agent descendants FIRST (before
      // deleteSession detaches them), then delete each. Otherwise their transcripts leak forever.
      for (const descId of this.descendantSessionIds(id)) n += this.deleteManagedSession(userId, descId);
      n += this.deleteManagedSession(userId, id);
    }
    return n;
  }

  /** Start (or resume) a conversation — see ConversationLifecycle.start. */
  async start(userId: number, opts?: { provider?: string; model?: string; session?: string; fresh?: boolean; cwd?: string; clientId?: string; clientGeneration?: number }): Promise<{ sessionId: string }> {
    const started = await this.lifecycle.start(userId, opts);
    // Drain only — never sweep. Opening a conversation says nothing about whether its still-'running'
    // delegation rows are orphans (see reconcileDelegationsOnBoot); the inbox may hold a background child's
    // result, or a restart orphan's synthetic one that boot enqueued but deliberately left undelivered.
    void this.turnRunner.drainPendingSubagentResults(userId, started.sessionId);
    return started;
  }

  /** Follow the user's ACTIVE conversation live — see ConversationLifecycle.subscribe. */
  subscribe(userId: number, listener: (e: BrainEvent) => void, clientId?: string, clientGeneration?: number): () => void {
    return this.lifecycle.subscribe(userId, listener, clientId, clientGeneration);
  }

  /** Follow one of the CALLER'S OWN sessions live, by explicit id — see ConversationLifecycle.tapSession. */
  tapSession(userId: number, sessionId: string, listener: (e: BrainEvent) => void, clientId?: string, clientGeneration?: number): () => void {
    return this.lifecycle.tapSession(userId, sessionId, listener, clientId, clientGeneration);
  }

  /** Install a fixed-session tap and capture its durable+live snapshot without yielding. The caller
   *  must buffer listener events until it has written `snapshot`; because both operations are
   *  synchronous, every event belongs exactly once (inside the snapshot or after it). */
  tapSessionSnapshot(userId: number, sessionId: string, listener: (e: BrainEvent) => void, clientId?: string, clientGeneration?: number, history?: MessagePageOpts): { off: () => void; snapshot: BrainStreamSnapshot } {
    // A reconnect can carry the pre-rollover id while its stable client binding has already moved to the
    // fresh session. Resolve once up front so BOTH the tap and atomic history/journal snapshot name the
    // same target; otherwise the tap follows fresh but the first frame accidentally hydrates old history.
    const targetSessionId = this.lifecycle.resolveStreamSession(userId, sessionId, clientId, clientGeneration);
    const off = this.lifecycle.tapSession(userId, targetSessionId, listener, clientId, clientGeneration);
    try { return { off, snapshot: this.statusView.streamSnapshot(userId, targetSessionId, history) }; }
    catch (error) { off(); throw error; }
  }

  /** Resolve the durable, immutable scope for an owner drill-in. Kept synchronous so the HTTP route can
   * reject a legacy/corrupt child before it fire-and-forgets the actual long-running continuation. */
  private delegatedContinuation(userId: number, sessionId: string): {
    row: { id: string; user_id: number; parent_session_id: string | null };
    parentSessionId: string;
    scope: DelegatedExecutionScope;
  } {
    const row = this.d.store.getSession(sessionId);
    if (!row || row.user_id !== userId) throw new Error('unknown session');
    if (!isSubagentSession(sessionId)) throw new Error('not a sub-agent session');
    const parentSessionId = row.parent_session_id;
    if (!parentSessionId) throw new Error('invalid parent session');
    const parent = this.d.store.getSession(parentSessionId);
    if (!parent || parent.user_id !== userId) throw new Error('invalid parent session');
    const scope = this.d.store.delegatedAccessFor(sessionId);
    if (!scope) throw new Error('delegated access unavailable');
    return { row, parentSessionId, scope };
  }

  /** Synchronous route preflight for `/brain/subagent/send`: a legacy child with no immutable scope
   * must return 409 now, not be silently swallowed by the route's detached promise. */
  preflightSubagentSend(userId: number, sessionId: string): void {
    this.delegatedContinuation(userId, sessionId);
  }

  /** The owner talking INTO a delegated sub-agent's session: steers the message into the child's
   *  RUNNING turn (mid-run course correction), or runs it as a fresh turn when the child is idle
   *  (continue the conversation after it finished). Restricted to the caller's OWN
   *  `brain-ch-subagent-*` sessions — the child executes with access inherited from the caller's own
   *  delegation, so this can never escalate; shared platform channels are deliberately NOT reachable
   *  here (steering another member's turn would mix privileges). */
  async sendToSubagent(userId: number, sessionId: string, text: string): Promise<void> {
    await this.sendDelegated(userId, sessionId, text);
  }

  /** A delegating turn reading the final stored reply of one of its own sub-agents. The durable parent
   *  relation and sub-agent id family are the confidentiality boundary; requiring a resolvable delegated
   *  scope also rejects legacy/corrupt children exactly like continuation does.
   *
   *  `scopeExceedsCurrentAccess` deliberately does not apply here: reading stored text executes no child
   *  tools and cannot revive its captured permissions. Applying a write-time execution check would only
   *  make an already-authorized parent lose access to its own durable result after its tool scope narrows.
   *
   *  Deliberately NOT `lastAssistantText` (which is `lastAssistant` — literally the last row). A follow-up
   *  attempt on this child that later errored (a bad model route, a dropped connection) appends its own
   *  empty-text assistant row AFTER the real answer, and the shared helper would then report the child as
   *  having "no final text" even though it plainly does — one row further back. Scanning backward for the
   *  last NON-EMPTY assistant text is what "the sub-agent's answer" actually means here. */
  readSubagent(parentSessionId: string, childSessionId: string): string {
    const row = this.d.store.getSession(childSessionId);
    if (!row || row.parent_session_id !== parentSessionId || !isSubagentSession(childSessionId)) {
      throw new Error('unknown sub-agent for this conversation — use DelegateList to choose an id from this conversation');
    }
    if (this.sessions.isActiveChild(childSessionId)) {
      throw new Error('that sub-agent is still running — wait for it to finish before reading its final assistant text');
    }
    const scope = this.d.store.delegatedAccessFor(childSessionId);
    if (!scope) throw new Error('delegated access unavailable');
    const messages = this.d.store.getMessages(childSessionId);
    let text = '';
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]!.role !== 'assistant') continue;
      try {
        const candidate = extractText(JSON.parse(messages[i]!.content));
        if (candidate) { text = candidate; break; }
      } catch { /* malformed row — keep scanning further back */ }
    }
    if (!text) {
      throw new Error('that sub-agent has not produced final assistant text yet — wait for it to finish, then try DelegateRead again; if it finished empty, use DelegateContinue to ask for a conclusion');
    }
    return text;
  }

  /** Stop a runaway or no-longer-needed DIRECT sub-agent — the targeted counterpart of the whole-tree
   *  teardown `/stop` already does. Same ownership guard as {@link readSubagent}: the child must belong to
   *  THIS conversation, so a sibling's or another account's sub-agent is not addressable, and stopping one
   *  never reaches past it — `ChannelSessionService.abort` recurses into whatever that child itself
   *  delegated, exactly like a platform `/stop`, so the whole stuck branch (a foreground-blocked middle
   *  agent together with the grandchild it is blocked on) comes down together. `{stopped: false}` for a
   *  child that already finished (or never started) is not an error — there is simply nothing to stop. */
  async stopSubagent(parentSessionId: string, childSessionId: string): Promise<{ stopped: boolean }> {
    const row = this.d.store.getSession(childSessionId);
    if (!row || row.parent_session_id !== parentSessionId || !isSubagentSession(childSessionId)) {
      throw new Error('unknown sub-agent for this conversation — use DelegateList to choose an id from this conversation');
    }
    if (!this.sessions.isActiveChild(childSessionId)) return { stopped: false };
    await this.channelService.abort(channelIdOf(childSessionId));
    return { stopped: true };
  }

  /** A delegating TURN continuing one of its own sub-agents: the child picks its transcript back up
   *  (rehydrated from SQLite) and answers this follow-up, whose reply is returned to the caller — the
   *  agent-facing counterpart of the owner's drill-in `sendToSubagent`, which streams to a human instead.
   *
   *  Three guards, in order, and each of them is the point:
   *  - `parentSessionId` comes from the HOST's own turn scope, never from the calling plugin, and the
   *    child must name exactly it. That is what keeps a conversation inside its own delegation tree —
   *    a sibling conversation's (or another account's) child is simply not addressable.
   *  - A child with a turn in flight is refused rather than steered. `sendToSubagent` deliberately steers
   *    (a human correcting a running agent mid-flight), but two agents driving one transcript is a race
   *    with no owner, so the delegating turn is told to wait instead.
   *  - The persisted scope may not exceed what this conversation holds NOW (see
   *    scopeExceedsCurrentAccess). It is then narrowed further by the caller's current denies. */
  async continueSubagent(
    parentSessionId: string,
    childSessionId: string,
    text: string,
    access: Parameters<typeof scopeExceedsCurrentAccess>[1],
    onEvent?: (e: BrainEvent) => void,
  ): Promise<string> {
    const row = this.d.store.getSession(childSessionId);
    if (!row || row.parent_session_id !== parentSessionId || !isSubagentSession(childSessionId)) {
      throw new Error('unknown sub-agent for this conversation');
    }
    if (this.sessions.isActiveChild(childSessionId)) {
      throw new Error('that sub-agent is still running — wait for it to finish before sending it more');
    }
    const scope = this.d.store.delegatedAccessFor(childSessionId);
    if (!scope) throw new Error('delegated access unavailable');
    const exceeds = scopeExceedsCurrentAccess(scope, access);
    if (exceeds) throw new Error(`cannot continue that sub-agent: ${exceeds}`);
    return this.sendDelegated(row.user_id, childSessionId, text, {
      extraDeny: access.toolPolicy?.deny ?? [],
      ...(onEvent ? { onEvent } : {}),
    });
  }

  /** The single delegated-turn dispatch, shared by the owner's drill-in continuations (`sendToSubagent`)
   *  and hidden host system turns (durable sub-agent result delivery, via `internalSystem`). Resolves the
   *  child's immutable execution scope, rebuilds its captured policy + current account deny-list, and drives
   *  channelService.send with `ownerSteer`. `idleRolloverMs` is pinned to Infinity: a drill-in or a
   *  result-delivery turn must NEVER roll the delegate's transcript over (archiving it under a fresh id out
   *  from under the still-owned child) — the child's own delegation owns that transcript. */
  private async sendDelegated(
    userId: number, sessionId: string, content: string,
    opts?: {
      internalSystem?: { customType: string; resultId: string };
      /** Additional tool denies from the CALLING turn, layered on the account's own. Only ever narrows;
       *  the captured allow-list stays authoritative (see ChannelSessionService.delegatedExecution). */
      extraDeny?: string[];
      onEvent?: (e: BrainEvent) => void;
    },
  ): Promise<string> {
    const { row, parentSessionId, scope } = this.delegatedContinuation(userId, sessionId);
    const policy = scope.admin
      ? { allowedProjectIds: 'all' as const, allowedPaths: () => [] }
      : this.d.policyForProjects?.(scope.projectIds)
        ?? { allowedProjectIds: new Set(scope.projectIds), allowedPaths: () => [] };
    const deniedTools = [...(this.d.users.get(userId)?.disabled_tools ?? []), ...(opts?.extraDeny ?? [])];
    return this.channelService.send({
      channelId: channelIdOf(sessionId),
      ownerUserId: row.user_id,
      // A drill-in continuation is a new child run, not a standalone channel turn. Preserve the durable
      // edge so parent stop/status and eviction guards keep owning it even after the child respawns.
      parentSessionId,
      policy,
      delegatedAccess: scope,
      promptAppend: scope.promptAppend,
      trusted: scope.admin,
      // The captured allow/deny policy remains authoritative; current account disabled tools may only add
      // a deny. A mid-run steer still executes under the already-running child's original turn scope.
      toolPolicy: delegatedToolPolicy(scope, deniedTools),
      identity: this.identity.forDelegatedTurn(scope, row.user_id),
      ownerSteer: true,
      idleRolloverMs: Number.POSITIVE_INFINITY,
      ...(opts?.internalSystem ? { internalSystem: opts.internalSystem } : {}),
      ...(opts?.onEvent ? { onEvent: opts.onEvent } : {}),
    }, content);
  }

  /** Run one user turn — see BrainTurnRunner.send. `display` is the client's clean rendering of the
   *  message (before @mention/prompt expansion) that the authoritative `user` echo shows; absent → the
   *  model-facing text is echoed. */
  /** Whether `userId` is the instance operator (the owner). Exposed so owner-only API surfaces — e.g. the
   *  background-process routes, which read/kill children of the owner-only terminal tools — gate on the same
   *  notion the tools do, not merely `is_admin` (a second admin is admin-but-not-owner). */
  isOwner(userId: number | undefined): boolean {
    return this.identity.isOwner(userId);
  }

  /** Push a background-process snapshot to the OWNER's live client streams (the CLI/web process panel),
   *  so it refreshes out of turn on every spawn/exit/kill. Wired to the process registry's change
   *  listener in the daemon. Owner-only: a command line can carry a secret, so the event is delivered
   *  ONLY to streams attached to the owner's own sessions, never a second admin's. */
  broadcastProcesses(sessionId: string, processes: ProcessInfo[]): void {
    const event: BrainEvent = { type: 'process', processes };
    for (const [listener, attachedSessionId] of this.attachments.clientStreams) {
      if (attachedSessionId === sessionId && this.isOwner(this.d.store.getSession(attachedSessionId)?.user_id)) listener(event);
    }
  }

  /** Ownership of ONE process, independent of any session scope. The originating session row decides: a
   *  process spawned inside a DELEGATED child (sub-agent) carries `handle.userId === null` — that turn's
   *  identity has no Elowen user — so the child session's `user_id` is the only reliable owner. The handle's
   *  own userId is the fallback for a process whose session row is already gone. */
  private ownsProcess(userId: number, handle: ProcessHandle): boolean {
    const sessionOwner = handle.sessionId ? this.d.store.getSession(handle.sessionId)?.user_id : undefined;
    return (sessionOwner ?? handle.userId ?? null) === userId;
  }

  /** Resolve an EXPLICIT `?session=` process scope. Throws (→ 404) on an unknown or foreign session — the
   *  CLI's bound-session contract. The sessionless surfaces below never call it: they span the user's whole
   *  process tree instead. */
  private ownedProcessSession(userId: number, sessionId: string): string {
    const row = this.d.store.getSession(sessionId);
    if (!row || row.user_id !== userId) throw new Error('unknown session');
    return sessionId;
  }

  /** The user's background processes. Without a session: EVERY process they own, across conversations,
   *  channels and sub-agent children — the web panel's view, and the only surface that can reach a service
   *  process an orphaned delegate left behind. With a session: that conversation only (CLI). */
  processes(userId: number, sessionId?: string): ProcessInfo[] {
    if (sessionId) return processRegistry.listForSession(this.ownedProcessSession(userId, sessionId));
    // The cross-conversation (web panel) view excludes in-flight `foreground` Bash commands: they are
    // transient tool calls owned by their live turn (Ctrl+B backgrounds them), not managed background
    // processes to list and kill. The session-scoped path above keeps them — the CLI's Ctrl+B gate reads it.
    return processRegistry.listWhere((handle) => this.ownsProcess(userId, handle) && handle.completionMode !== 'foreground');
  }

  processOutput(userId: number, processId: string, sessionId?: string): string | null {
    if (sessionId) return processRegistry.outputForSession(this.ownedProcessSession(userId, sessionId), processId);
    const handle = processRegistry.get(processId);
    return handle && this.ownsProcess(userId, handle) ? handle.readAll() : null;
  }

  killProcess(userId: number, processId: string, sessionId?: string): boolean {
    // A foreground command is owned by its live turn; the process API never kills it (that would SIGKILL a
    // command the CLI is still awaiting). Ctrl+B backgrounds it; session deletion still reaps it via killSession.
    if (processRegistry.get(processId)?.completionMode === 'foreground') return false;
    if (sessionId) return processRegistry.killForSession(this.ownedProcessSession(userId, sessionId), processId);
    const handle = processRegistry.get(processId);
    return handle !== undefined && this.ownsProcess(userId, handle) && processRegistry.kill(processId);
  }

  async send(request: TurnRequest): Promise<void> {
    return this.turnRunner.send(request);
  }

  /** Convert every authenticated foreground delegate currently blocking this parent into a detached
   * background job. The plugin owns child state; core owns session authorization and result delivery. */
  async detachForegroundSubagents(
    userId: number,
    session?: string,
    client?: BoundClientRequest,
  ): Promise<{ detached: number }> {
    const target = this.preflightSend(userId, session, client);
    const registry = await this.d.plugins?.get();
    const control = registry?.control('subagent');
    if (!control) return { detached: 0 };
    return control.detachForeground({ sessionId: target, principal: `elowen:${userId}` });
  }

  /** Convert every running foreground `Bash` command in this conversation into a detached background job.
   * Mirror of detachForegroundSubagents against the terminal plugin's control — the plugin keeps the
   * process running and its eventual exit nudges this same conversation, exactly like Bash(background). */
  async detachForegroundCommands(
    userId: number,
    session?: string,
    client?: BoundClientRequest,
  ): Promise<{ detached: number }> {
    const target = this.preflightSend(userId, session, client);
    const registry = await this.d.plugins?.get();
    const control = registry?.control('terminal');
    if (!control) return { detached: 0 };
    return control.detachForeground({ sessionId: target, principal: `elowen:${userId}` });
  }

  /** Hard-kill every running foreground `Bash` command in this conversation — the stop ESCALATION (a
   * further Esc / repeat Ctrl+C after the graceful interrupt). PI's agent loop only re-checks its abort
   * signal between tool calls, so a long command otherwise pins the aborted turn until it exits on its
   * own; the terminal plugin SIGKILLs the process group and the settled Bash tool resolves as `[killed]`,
   * unwinding the turn. Structural mirror of detachForegroundCommands; never invoked by the daemon on its
   * own — the escalation decision stays with the client, so one client's innocent stop can never SIGKILL
   * a command another client's turn is running. */
  async killForegroundCommands(
    userId: number,
    session?: string,
    client?: BoundClientRequest,
  ): Promise<{ killed: number }> {
    const target = this.preflightSend(userId, session, client);
    const registry = await this.d.plugins?.get();
    const control = registry?.control('terminal');
    if (!control) return { killed: 0 };
    return control.killForeground({ sessionId: target, principal: `elowen:${userId}` });
  }

  /** Convert every foreground `WorkflowStart` currently blocking this parent into a detached background
   * workflow. Same shape as detachForegroundSubagents/Commands — the engine keeps running the DAG and
   * delivers its summary back into this conversation. Detach rides the workflow control (which already
   * owns `cancelForSession` — see api.ts KnownControls). */
  async detachForegroundWorkflows(
    userId: number,
    session?: string,
    client?: BoundClientRequest,
  ): Promise<{ detached: number }> {
    const target = this.preflightSend(userId, session, client);
    const registry = await this.d.plugins?.get();
    const control = registry?.control('workflow');
    if (!control) return { detached: 0 };
    return control.detachForeground({ sessionId: target, principal: `elowen:${userId}` });
  }

  /** Start a user turn and expose its two real lifecycle boundaries. `admitted` resolves only after the
   * prompt is durable and its authoritative user event has been published; `completed` covers the full
   * model/tool turn. This lets HTTP acknowledge safely without holding the request for a long turn. */
  startSend(request: TurnRequest): { admitted: Promise<string>; completed: Promise<void> } {
    let resolveAdmitted!: (sessionId: string) => void;
    let rejectAdmitted!: (error: unknown) => void;
    let admissionSettled = false;
    const admitted = new Promise<string>((resolve, reject) => {
      resolveAdmitted = resolve;
      rejectAdmitted = reject;
    });
    const completed = this.turnRunner.send({
      ...request,
      onAdmitted: (sessionId) => {
        if (admissionSettled) return;
        admissionSettled = true;
        resolveAdmitted(sessionId);
      },
    }).then(
      () => {
        if (admissionSettled) return;
        admissionSettled = true;
        rejectAdmitted(new Error('turn completed before admission'));
      },
      (error) => {
        if (!admissionSettled) {
          admissionSettled = true;
          rejectAdmitted(error);
        }
        throw error;
      },
    );
    return { admitted, completed };
  }

  /** Surface a failure that happened after HTTP admission through the same ordered replay stream the
   * TUI/headless client already consumes. Returns false only if teardown removed the live session. */
  publishAcceptedSendFailure(sessionId: string, error: unknown): boolean {
    const live = this.sessions.get(sessionId);
    if (!live) return false;
    const message = error instanceof Error ? error.message : String(error);
    live.replay.publish({ type: 'error', message: message || 'accepted turn failed' });
    return true;
  }

  /** Synchronous admission check for the HTTP send route. Model turns may run for minutes; the route
   * acknowledges immediately after this check so reverse-proxy timeouts cannot turn a healthy streamed
   * tool-heavy response into a client-side `fetch failed` transcript row. */
  preflightSend(userId: number, session?: string, client?: BoundClientRequest): string {
    const target = session
      ? this.lifecycle.ownedUserSession(userId, session)
      : this.lifecycle.activeSessionId(userId);
    const row = this.d.store.getSession(target);
    if (!row || row.user_id !== userId) throw new Error('brain not started for user');
    if (client && !this.lifecycle.authorizeClientRequest(userId, client.id, client.generation, target)) {
      throw new Error('client session has stopped');
    }
    return target;
  }

  /** Restart a user's live session so changed settings apply — see ConversationLifecycle.restart. */
  async restart(userId: number, opts: { reapplyModelPreference?: boolean } = {}): Promise<void> {
    return this.lifecycle.restart(userId, opts);
  }

  /** A user saved their auto-compact settings: re-apply the threshold to every conversation of theirs that
   *  is ALREADY live — their own chats and the channel sessions they own. Without this the new percentage
   *  only reached a session on its next respawn (model switch, rollover, daemon restart), so the setting
   *  looked broken: it was saved, and nothing happened to the conversation the user was sitting in.
   *
   *  No respawn happens here — PI reads its compaction settings at each check, so replacing the reserve in
   *  place is enough. Channels keep proactive compaction ALWAYS on (long-lived and unattended); only the
   *  threshold follows the owner, exactly as at spawn. */
  applyAutoCompactSettings(userId: number): void {
    const settings = this.d.userSettings?.(userId);
    const globalPct = settings?.autoCompactAt ?? DEFAULT_AUTO_COMPACT_PCT;
    // The same per-model resolution the spawner does, against the model this session actually runs on.
    const pctFor = (live: LiveBrain): number => (live.providerId
      ? resolveAutoCompactPct(settings?.autoCompactAtByModel, live.providerId, live.model, globalPct)
      : globalPct);
    for (const [sessionId, live] of this.sessions.liveEntries()) {
      if (this.d.store.getSession(sessionId)?.user_id !== userId) continue;
      live.applyCompaction(!!settings?.autoCompact, pctFor(live));
    }
    for (const [, live] of this.sessions.channelEntries()) {
      if (this.d.store.getSession(live.sessionId)?.user_id !== userId) continue;
      live.applyCompaction(true, pctFor(live));
    }
  }

  /** A user changed their active personality profile: respawn so the new persona chunk lands in the
   *  system prompt. The user's own owner-chat session restarts (per-user, safe), AND every channel
   *  session THIS USER OWNS is reset so a Discord room respawns on the owner's fresh 'discord' persona —
   *  the channel session is owner-anchored and shared, so it must not keep the stale persona. Scoped by
   *  owner: persona is resolved per channel-session owner at spawn, so a global reset would interrupt
   *  every OTHER user's channels for a setting that never touched them. History rehydrates from SQLite on
   *  respawn. Rare operation; serialized on its own key so it never interleaves a reload. */
  async applyPersonalityChange(userId: number): Promise<void> {
    await this.serial(`personality-${userId}`, async () => {
      await this.restart(userId);
      await this.channelService.resetChannels('personality changed', (ownerUserId) => ownerUserId === userId);
    });
  }

  /** Invalidate the shared plugin registry and restart every live session — called when the admin flips
   *  a plugin on/off so the change applies without a daemon restart. Channel sessions are simply dropped;
   *  the next inbound message re-opens them with the fresh registry. The shared invalidation also covers
   *  the elowen-exec brain workers — their next launch composes from the fresh registry. */
  async reloadPlugins(): Promise<void> {
    // Serialized: two rapid plugin toggles must not interleave stopAll()/startAll() and leave
    // duplicate connected adapters (a distinct lock key from any session, so it never blocks a turn).
    await this.serial('plugins-reload', async () => {
      // Every live session is about to be torn down — release any parked AskUserQuestion across all of
      // them so a pending question can't stall the reload (or leave a turn hanging on a disposed session).
      this.elicitation.cancelAll('plugins reloaded');
      // Let plugins observe the reload boundary. Observational only (fail-open, no mutation) — fires on
      // the CURRENT registry's hooks before we swap it out.
      const before = await this.d.plugins?.get();
      if (before) await new PluginHookBus({ hooks: before.hooks }).emit('plugin.reload.before', {});
      this.d.plugins?.invalidate();
      for (const userId of this.sessions.activeUserIds()) await this.restart(userId);
      // Non-active live sessions just drop; they respawn with the new registry on next resume.
      const activeIds = this.sessions.activeIds();
      for (const [id] of this.sessions.liveEntries()) {
        if (!activeIds.includes(id)) this.sessions.dispose(id);
      }
      await this.channelService.resetChannels('plugins reloaded');
      // Platform adapters were built by the old registry — disconnect them and start the fresh set.
      this.platforms.stopAll();
      await this.platforms.startAll();
      // reload.after fires against the freshly rebuilt registry so plugins can re-prime state.
      const after = await this.d.plugins?.get();
      if (after) await new PluginHookBus({ hooks: after.hooks }).emit('plugin.reload.after', {});
    });
  }

  /** A plugin's request (from inside a turn) to apply a plugin-set change live — the skills plugin calls
   *  it after CreateSkill/DeleteSkill writes to disk. Coalesced onto a flag and drained when the turn
   *  settles; reloading synchronously here would tear down the session running the tool. */
  requestPluginReload(): void {
    this.pendingPluginReload = true;
  }

  /** Post-turn hook (fired from the turn runner once a turn has fully settled): if a plugin requested a
   *  reload mid-turn, apply it now on the freed session. reloadPlugins is idempotent + serialized, so a
   *  concurrent turn draining the same flag just no-ops here (the flag is cleared before the reload). */
  private drainDeferredPluginReload(): void {
    if (!this.pendingPluginReload) return;
    this.pendingPluginReload = false;
    void this.reloadPlugins().catch((e) => logger('brain').error(`deferred plugin reload failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** Push a proactive message out through the platform adapters (cron/tick echoes). */
  async notify(text: string, channelId?: string): Promise<void> {
    await this.platforms.notify(text, channelId);
  }

  /** Start every plugin-contributed platform adapter — see PlatformOrchestrator. */
  async startPlatforms(log?: { info(m: string): void; error(m: string): void }): Promise<void> {
    await this.platforms.startAll(log);
  }

  /** Send one channel message (e.g. a Discord mention) — see ChannelSessionService. */
  async channelSend(opts: ChannelSendOpts, text: string): Promise<string> {
    return this.channelService.send(opts, text);
  }

  stop(userId: number): void {
    this.lifecycle.stop(userId);
  }

  /** The user's stored ACTIVE conversation, shaped for display — see BrainStatusService.history. */
  history(userId: number): BrainMessageView[] {
    return this.statusView.history(userId);
  }

  /** ANY of the owner's stored sessions, shaped for display — see BrainStatusService.messagesOf. */
  messagesOf(userId: number, sessionId: string): BrainMessageView[] {
    return this.statusView.messagesOf(userId, sessionId);
  }

  /** A backwards-paged window over a conversation's history (chat lazy-load) — see
   *  BrainStatusService.messagesPage. */
  messagesPage(userId: number, sessionId: string | undefined, opts: MessagePageOpts): MessagePage {
    return this.statusView.messagesPage(userId, sessionId, opts);
  }

  /** Export one of the caller's OWN conversations (owner-scoped exactly like messagesOf) as a
   *  self-contained HTML transcript or a JSONL session file. Reads history from the store and renders
   *  through PI's own exporter into a private temp dir — no live PI session required. Throws for an
   *  unknown or foreign session; the returned handle's cleanup() removes the temp dir. */
  exportSession(userId: number, sessionId: string, format: ExportFormat): Promise<SessionExport> {
    const row = this.d.store.getSession(sessionId);
    if (!row || row.user_id !== userId) throw new Error('unknown session');
    return exportBrainSession({ store: this.d.store, sessionId, cwd: row.work_dir || process.cwd(), title: row.title, format });
  }
}
