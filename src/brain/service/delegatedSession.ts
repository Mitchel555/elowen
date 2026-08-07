import type { BrainStore } from '../../store/brainStore.js';
import { syntheticRestartResultId } from '../../store/brainStore.js';
import type { BrainDeps } from '../brainDeps.js';
import type { ChannelSessionService } from '../channels.js';
import type { DelegatedExecutionScope } from '../delegatedScope.js';
import { delegatedToolPolicy, scopeExceedsCurrentAccess } from '../delegatedScope.js';
import type { BrainEvent } from '../events.js';
import type { IdentityResolver } from '../identity.js';
import { extractText } from '../messageView.js';
import type { BrainModelSelection } from '../providers.js';
import type { LiveBrain } from '../session/liveBrain.js';
import type { LiveSessionRegistry } from '../session/liveRegistry.js';
import { channelIdOf, isSubagentSession } from '../sessionId.js';
import { terminalizeWorkflow } from '../workflowRuns.js';
import type { SubagentProgressEvent } from '../../plugins/api.js';
import { logger } from '../../shared/logger.js';

/** Parse a `provider/model` spec into a brain model selection. Splits on the FIRST slash only — model
 *  ids themselves may contain slashes (e.g. `ai-coresynth-io/deepseek/deepseek-v4-flash`), so a naive
 *  `split('/')` would carve the model id in half. A bare id without a slash passes through as a model
 *  with no provider, exactly like the stored-row form in sendDelegated. */
function modelSelectionFromSpec(spec: string): BrainModelSelection {
  const slash = spec.indexOf('/');
  if (slash > 0) return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
  return { model: spec };
}

/** The BrainEvent members whose live fields actually feed a delegated child's progress row: the child's
 *  session id, tool starts, and step/idle token usage. The host narrows every child event onto the plugin
 *  contract ({@link SubagentProgressEvent}) before invoking the delegating plugin's callback, so a
 *  BrainEvent change must fail HERE at compile time instead of silently widening or starving what the
 *  plugin receives. The pin below asserts the source members still fit the declared shape (catches a
 *  field type change) AND still carry every declared key (catches a field removal). */
type SubagentProgressSource = Extract<BrainEvent, { type: 'session' | 'tool' | 'step' | 'idle' }>;
type SubagentProgressKeys = 'type' | 'name' | 'detail' | 'sessionId' | 'usage';
type SourceKeysOf<T> = T extends T ? keyof T : never;
const subagentProgressContract: (SubagentProgressSource extends SubagentProgressEvent ? true : never)
  & (SubagentProgressKeys extends SourceKeysOf<SubagentProgressSource> ? true : never) = true;
void subagentProgressContract;

/** Narrow a child's BrainEvent onto the declared progress shape the plugin's callback expects. The child's
 *  full event stream reaches the delegating conversation, but the contract promises only
 *  type/name/detail/sessionId/usage.totalTokens — forwarding the raw event would leak fields the contract
 *  never declared, and reading the fields explicitly is what makes a future BrainEvent change fail the
 *  typecheck instead of silently changing what the plugin observes. */
function narrowSubagentProgress(e: BrainEvent): SubagentProgressEvent {
  return {
    type: e.type,
    ...('name' in e && e.name !== undefined ? { name: e.name } : {}),
    ...('detail' in e && e.detail !== undefined ? { detail: e.detail } : {}),
    ...('sessionId' in e && e.sessionId !== undefined ? { sessionId: e.sessionId } : {}),
    ...('usage' in e && e.usage !== undefined ? { usage: { totalTokens: e.usage.totalTokens } } : {}),
  };
}

interface DelegatedSessionDeps {
  store: BrainStore;
  /** The shared live-session state (owned by the BrainService facade). */
  sessions: LiveSessionRegistry<LiveBrain>;
  /** Runs the child's turn (send) and its targeted teardown (abort) — the same channel service platform
   *  turns use, so a delegate rides the exact path a channel message does. */
  channelService: ChannelSessionService;
  identity: IdentityResolver;
  users: BrainDeps['users'];
  policyForProjects?: BrainDeps['policyForProjects'];
  /** Ask the sub-agent runner to drop its live record for a child before this process rehydrates it.
   *  Every send below runs the turn HERE, so a record still held over there would leave one session live
   *  in two processes at once. Absent (no runner) ⇒ there is nothing to release. */
  releaseRemote?: (channelId: string) => Promise<{ busy: boolean }>;
}

/** The sub-agent delegation half of the brain facade: the durable boot reconcile of restart-zombie
 *  delegation rows, the ownership-guarded drill-in paths (read/continue/stop a direct child), and the
 *  single delegated-turn dispatch shared by owner drill-ins and hidden result delivery. Everything here
 *  is keyed on the parent session the caller resolves — a plugin or route can never address another
 *  conversation's children. */
export class DelegatedSessionService {
  constructor(private d: DelegatedSessionDeps) {}

  /** The delegation twin of GoalLoopService.reconcileGoalsOnBoot: every durable sub-agent/workflow row the
   *  DB still marks `running` at boot is a zombie, because the in-memory child registrations died with the
   *  process. Terminalize them ONCE, HERE. Boot is the only moment the blanket rule is sound — no live
   *  delegation can exist yet. The same sweep run lazily from start() cannot tell an orphan from a healthy
   *  delegation whose registration it simply cannot see, and killed live work from the outside on every
   *  client reconnect. Sweeping globally also repairs the state for good instead of hiding it per read, and
   *  reaches the channel/task sessions an owner start() never visits.
   *
   *  Only an autoDeliver child ever promised automatic delivery, so only it gets a synthetic "interrupted
   *  by daemon restart" result — enqueued durably, NOT delivered here: draining would respawn every
   *  orphaned conversation at boot. start() and the post-turn hook drain the inbox when the conversation is
   *  next used. */
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
        // No timeline marker here on purpose: this runs at boot before any client attaches, so there is no
        // live replay to publish to and the marker is display-only (never persisted to session events). The
        // panel reflects the terminal status on next read; the marker is for finishes that happen live.
        if (!this.d.store.upsertSubagentRun(sessionId, terminal)) continue;
        if (run.autoDeliver !== true) continue;
        this.d.store.enqueueSubagentResult(sessionId, {
          id: syntheticRestartResultId(sessionId, run.toolCallId), toolCallId: run.toolCallId,
          sessionId: run.sessionId, status: 'error', task: run.task,
          error: 'sub-agent interrupted by daemon restart', tools: run.tools, tokens: run.tokens,
          seconds: run.seconds, model: run.model,
        });
      }
      // The loop above can only repair what getSubagentRuns returns, and that read requires a live direct
      // same-owner child. A row whose child session vanished or changed hands is skipped by it AND rejected
      // by upsertSubagentRun, so it would keep claiming `running` for good. Repair it straight on the row.
      const orphaned = this.d.store.terminalizeOrphanedSubagentRuns(sessionId);
      if (orphaned > 0) {
        logger('brain').warn(`boot reconcile terminalized ${orphaned} delegation row(s) of ${sessionId} whose child session no longer resolves`);
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

  /** Synchronous route preflight for `/brain/subagent/send`: a legacy child with no immutable scope
   *  must return 409 now, not be silently swallowed by the route's detached promise. */
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
    if (this.d.sessions.isActiveChild(childSessionId)) {
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
    if (!this.d.sessions.isActiveChild(childSessionId)) return { stopped: false };
    await this.d.channelService.abort(channelIdOf(childSessionId));
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
    onEvent?: (e: SubagentProgressEvent) => void,
    model?: string,
  ): Promise<string> {
    const row = this.d.store.getSession(childSessionId);
    if (!row || row.parent_session_id !== parentSessionId || !isSubagentSession(childSessionId)) {
      throw new Error('unknown sub-agent for this conversation');
    }
    if (this.d.sessions.isActiveChild(childSessionId)) {
      throw new Error('that sub-agent is still running — wait for it to finish before sending it more');
    }
    const scope = this.d.store.delegatedAccessFor(childSessionId);
    if (!scope) throw new Error('delegated access unavailable');
    const exceeds = scopeExceedsCurrentAccess(scope, access);
    if (exceeds) throw new Error(`cannot continue that sub-agent: ${exceeds}`);
    return this.sendDelegated(row.user_id, childSessionId, text, {
      extraDeny: access.toolPolicy?.deny ?? [],
      // The plugin's callback contract is the narrow progress shape, while the child's stream is the full
      // BrainEvent set — narrow every event at this boundary so the value matches the declared contract.
      ...(onEvent ? { onEvent: (e: BrainEvent) => onEvent(narrowSubagentProgress(e)) } : {}),
      ...(model ? { model } : {}),
    });
  }

  /** Resolve the durable, immutable scope for an owner drill-in. Kept synchronous so the HTTP route can
   *  reject a legacy/corrupt child before it fire-and-forgets the actual long-running continuation. */
  private delegatedContinuation(userId: number, sessionId: string): {
    // `model`/`provider` are carried because a continuation has to resume on the model the sub-agent
    // actually ran on — see sendDelegated, where omitting them silently fell back to the account default.
    row: { id: string; user_id: number; parent_session_id: string | null; model: string; provider: string };
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

  /** The single delegated-turn dispatch, shared by the owner's drill-in continuations (`sendToSubagent`)
   *  and hidden host system turns (durable sub-agent result delivery, via `internalSystem`). Resolves the
   *  child's immutable execution scope, rebuilds its captured policy + current account deny-list, and drives
   *  channelService.send with `ownerSteer`. `idleRolloverMs` is pinned to Infinity: a drill-in or a
   *  result-delivery turn must NEVER roll the delegate's transcript over (archiving it under a fresh id out
   *  from under the still-owned child) — the child's own delegation owns that transcript. */
  // `async` matters even though the body has no await of its own: delegatedContinuation() throws
  // SYNCHRONOUSLY (unknown session, bad parent, missing scope). Without it those escape a function
  // declaring Promise<string>, so a caller using the `void fn().catch(...)` style — as the HTTP route for
  // sendToSubagent does — would take an uncaught throw instead of the rejection it guards against.
  async sendDelegated(
    userId: number, sessionId: string, content: string,
    opts?: {
      internalSystem?: { customType: string; resultId: string };
      /** Additional tool denies from the CALLING turn, layered on the account's own. Only ever narrows;
       *  the captured allow-list stays authoritative (see ChannelSessionService.delegatedExecution). */
      extraDeny?: string[];
      /** Explicit `provider/model` override for this continuation (from the tool's `model` argument).
       *  Takes precedence over the model stored on the child's session row — see the send call below. */
      model?: string;
      onEvent?: (e: BrainEvent) => void;
    },
  ): Promise<string> {
    const { row, parentSessionId, scope } = this.delegatedContinuation(userId, sessionId);
    // The child may be living in the sub-agent runner. Reclaim it before rehydrating it here — and refuse
    // outright while it is still WORKING there, because steering a turn this process cannot see would run
    // two live sessions on one transcript. (`continueSubagent` already refuses a running child through
    // the registry; this covers the owner's drill-in, which deliberately steers instead of refusing.)
    // Guarded rather than `await this.d.releaseRemote?.(…)`: without a runner there is nothing to wait
    // for, and an await here would still push the send below past a microtask — this path reaches
    // channelService.send synchronously by design.
    const release = this.d.releaseRemote;
    if (release) {
      const { busy } = await release(channelIdOf(sessionId));
      if (busy) throw new Error('that sub-agent is running in the sub-agent runner — wait for it to finish before sending it more');
    }
    const policy = scope.admin
      ? { allowedProjectIds: 'all' as const, allowedPaths: () => [] }
      : this.d.policyForProjects?.(scope.projectIds)
        ?? { allowedProjectIds: new Set(scope.projectIds), allowedPaths: () => [] };
    const deniedTools = [...(this.d.users.get(userId)?.disabled_tools ?? []), ...(opts?.extraDeny ?? [])];
    return this.d.channelService.send({
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
      identity: this.d.identity.forDelegatedTurn(scope, row.user_id),
      // The child's OWN model, read back from its session row. Without this the continuation passed no
      // selection at all, and a child whose channel had since been evicted respawned on whatever
      // resolveBrainModelRoute picks from an EMPTY selection: the first configured provider's first
      // model (providers.ts:342-346). That is list order, not anybody's default — in practice it meant a
      // sub-agent delegated to kimi-coding/k3 came back as ai-coresynth-io/gpt-image-2, an image model
      // that cannot hold a conversation at all. The respawn then WROTE that over the session row, so the
      // original model was lost and a second continuation could not recover it either. A legacy row with
      // no recorded model still falls through to the old behaviour, which is all that is left for it.
      // An explicit `model` from the caller overrides the stored selection: the recorded model may have
      // become unavailable since the child last ran, or the user consciously wants to switch. Without one
      // the stored model stays authoritative — it is what the sub-agent originally ran on.
      ...(opts?.model
        ? { model: modelSelectionFromSpec(opts.model) }
        : row.model ? { model: { model: row.model, ...(row.provider ? { provider: row.provider } : {}) } } : {}),
      ownerSteer: true,
      idleRolloverMs: Number.POSITIVE_INFINITY,
      ...(opts?.internalSystem ? { internalSystem: opts.internalSystem } : {}),
      ...(opts?.onEvent ? { onEvent: opts.onEvent } : {}),
    }, content);
  }
}
