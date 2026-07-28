import type { Db } from './db.js';
import type { WorkflowNode, WorkflowUpdate } from '../brain/events.js';
import { isSubagentSession } from '../brain/sessionId.js';

/** Validated latest UI state of one delegated child. The child id is a first-class indexed column in
 *  brain_subagent_runs; this JSON state contains only bounded display data. */
interface BrainSubagentRunState {
  status: 'running' | 'done' | 'error';
  task: string;
  detail?: string;
  tools: number;
  tokens?: number;
  seconds: number;
  model?: string;
  thinkingLevel?: string;
  thinkingLabel?: string;
  background?: boolean;
  autoDeliver?: boolean;
  resultDelivery?: 'pending' | 'acknowledged';
}
/** Store-neutral display shape consumed by shapeBrainMessages. */
export interface BrainSubagentRun extends BrainSubagentRunState {
  toolCallId: string;
  sessionId: string;
}
/** The validated latest snapshot of one workflow DAG (see brain_workflows). Aliases the wire payload on
 *  purpose: a `workflow` event carries the WHOLE DAG, so the durable row IS the snapshot and the row,
 *  the event and the state attached to the tool item cannot drift apart. Bounded display data only. */
export type BrainWorkflowRun = WorkflowUpdate;
/** One delegated child of a conversation, as its PARENT sees it: enough to recognise which sub-agent
 *  this was and decide whether to continue it. `task`/`status`/`model` come from the child's
 *  brain_subagent_runs row and are absent for a child the engine never recorded one for (a workflow
 *  node), which is why the listing is driven by the durable session relation instead. */
export interface DelegatedChildSummary {
  sessionId: string;
  title: string;
  task?: string;
  status?: 'running' | 'done' | 'error';
  /** Turns already in the child's transcript — what a continuation would resume on top of. */
  messages: number;
  model?: string;
  startedAt: string;
  updatedAt: string;
}

/** Ceiling for one listing. A conversation that fanned out hundreds of children must not turn a single
 *  tool call into an unbounded transcript dump. */
const MAX_DELEGATED_CHILDREN = 50;

export interface BrainSubagentResult {
  /** Which producer enqueued this row (see brain_subagent_results.kind). A 'workflow' result carries an
   *  empty `sessionId` and a `workflowId` instead of a child session. */
  kind: 'subagent' | 'workflow';
  id: string;
  parentSessionId: string;
  toolCallId: string;
  sessionId: string;
  workflowId?: string;
  status: 'done' | 'error';
  task: string;
  result?: string;
  error?: string;
  tools: number;
  tokens?: number;
  seconds: number;
  model?: string;
  delivery: 'pending' | 'acknowledged';
  attempts: number;
}
/** A daemon-restart reconcile enqueues a SYNTHETIC terminal result for each orphaned running child so an
 *  autoDeliver parent still gets woken. Its id carries this prefix so a real completion arriving later for
 *  the same (parent_session_id, tool_call_id) can UPGRADE the still-pending synthetic row in place (see
 *  enqueueSubagentResult) rather than colliding with it. */
const SYNTHETIC_RESTART_RESULT_PREFIX = 'restart-';
export const syntheticRestartResultId = (parentSessionId: string, toolCallId: string): string =>
  `${SYNTHETIC_RESTART_RESULT_PREFIX}${parentSessionId}-${toolCallId}`;

const bounded = (value: string, max: number): string => value.length <= max ? value : value.slice(0, max);

/** The delivery-path twin of `bounded` for the one field a parent reads as the ANSWER: an over-long result
 *  keeps its END, because a report's conclusion is its last paragraph. Head-first is still right everywhere a
 *  bound produces a preview (a task line, a snapshot row) and for an error, which leads with what broke.
 *
 *  Deliberate mirror of `clipTail` in plugins/subagent/lib/results.mjs — a plugin may not import daemon
 *  sources and the daemon may not import a plugin's ESM, so the two carry the same note and the same
 *  arithmetic. tests/store/brainStore.test.ts asserts they agree character for character. */
const truncationNote = (dropped: number): string =>
  `[truncated: first ${dropped} chars dropped, end kept — read it in full with DelegateRead]\n`;
const boundedTail = (value: string, max: number): string => {
  if (value.length <= max) return value;
  const kept = Math.max(0, max - truncationNote(value.length).length);
  // `slice(-0)` is `slice(0)` — the whole string — so a zero-width tail has to be spelled out.
  return `${truncationNote(value.length - kept)}${kept === 0 ? '' : value.slice(-kept)}`;
};

// Bounds for a persisted workflow snapshot, mirroring the engine's own limits (dag.mjs MAX_NODES /
// MAX_ID_CHARS, workflow.mjs SNAPSHOT_TASK_PREVIEW). The whole DAG re-fans on every tool event of every
// node, so an unbounded blob would be a write amplifier as much as a DoS: `deps` dominates the ceiling,
// since every node may name every other, so 64 nodes x ~5.4k caps a row near 350k. `task` allows the
// preview plus its ellipsis; `detail` is one "tool + arg" line, so it gets far less room than a
// sub-agent's 2k -- 64 of those at that size would be 128k per snapshot.
const MAX_WORKFLOW_NODES = 64;
const MAX_WORKFLOW_ID_CHARS = 64;
const MAX_WORKFLOW_TASK_CHARS = 600;
const MAX_WORKFLOW_DETAIL_CHARS = 500;
// Terminal result/error previews (engine clips to SNAPSHOT_RESULT_PREVIEW + a truncation marker).
const MAX_WORKFLOW_RESULT_CHARS = 600;

/** One node of a persisted DAG. Rejects rather than coerces: a malformed node means the snapshot came
 *  from something other than the engine, and guessing its intent would put fiction on the user's screen. */
function normalizeWorkflowNode(raw: unknown): WorkflowNode | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id || o.id.length > MAX_WORKFLOW_ID_CHARS) return undefined;
  if (typeof o.task !== 'string') return undefined;
  if (o.status !== 'pending' && o.status !== 'running' && o.status !== 'done' && o.status !== 'error') return undefined;
  if (!Array.isArray(o.deps) || o.deps.length > MAX_WORKFLOW_NODES) return undefined;
  if (!o.deps.every((d): d is string => typeof d === 'string' && !!d && d.length <= MAX_WORKFLOW_ID_CHARS)) return undefined;
  if (o.sessionId !== undefined && (typeof o.sessionId !== 'string' || !o.sessionId || o.sessionId.length > 512)) return undefined;
  if (o.detail !== undefined && typeof o.detail !== 'string') return undefined;
  if (o.model !== undefined && typeof o.model !== 'string') return undefined;
  if (o.tokens !== undefined && (typeof o.tokens !== 'number' || !Number.isSafeInteger(o.tokens) || o.tokens < 0)) return undefined;
  if (o.seconds !== undefined && (typeof o.seconds !== 'number' || !Number.isSafeInteger(o.seconds) || o.seconds < 0)) return undefined;
  if (o.startedAt !== undefined && (typeof o.startedAt !== 'number' || !Number.isSafeInteger(o.startedAt) || o.startedAt < 0)) return undefined;
  if (o.result !== undefined && typeof o.result !== 'string') return undefined;
  if (o.error !== undefined && typeof o.error !== 'string') return undefined;
  return {
    id: o.id,
    task: bounded(o.task, MAX_WORKFLOW_TASK_CHARS),
    status: o.status,
    deps: o.deps,
    ...(typeof o.sessionId === 'string' ? { sessionId: o.sessionId } : {}),
    ...(typeof o.detail === 'string' ? { detail: bounded(o.detail, MAX_WORKFLOW_DETAIL_CHARS) } : {}),
    ...(typeof o.tokens === 'number' ? { tokens: o.tokens } : {}),
    ...(typeof o.seconds === 'number' ? { seconds: o.seconds } : {}),
    ...(typeof o.model === 'string' ? { model: bounded(o.model, 512) } : {}),
    ...(typeof o.startedAt === 'number' ? { startedAt: o.startedAt } : {}),
    ...(typeof o.result === 'string' ? { result: bounded(o.result, MAX_WORKFLOW_RESULT_CHARS) } : {}),
    ...(typeof o.error === 'string' ? { error: bounded(o.error, MAX_WORKFLOW_RESULT_CHARS) } : {}),
  };
}

/** Runtime validation for an engine-produced or DB-loaded workflow snapshot. Same reject-don't-coerce
 *  contract as normalizeSubagentState, plus the DAG's own rule that node ids are unique — a duplicate
 *  would make the modal's per-node keying ambiguous. */
function normalizeWorkflowState(raw: unknown): BrainWorkflowRun | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id || o.id.length > 512) return undefined;
  if (typeof o.toolCallId !== 'string' || !o.toolCallId || o.toolCallId.length > 512) return undefined;
  if (o.status !== 'running' && o.status !== 'done' && o.status !== 'error' && o.status !== 'cancelled') return undefined;
  if (o.title !== undefined && typeof o.title !== 'string') return undefined;
  if (o.background !== undefined && typeof o.background !== 'boolean') return undefined;
  if (!Array.isArray(o.nodes) || o.nodes.length > MAX_WORKFLOW_NODES) return undefined;
  const nodes: WorkflowNode[] = [];
  const seen = new Set<string>();
  for (const raw of o.nodes) {
    const node = normalizeWorkflowNode(raw);
    if (!node || seen.has(node.id)) return undefined;
    seen.add(node.id);
    nodes.push(node);
  }
  return {
    id: o.id,
    toolCallId: o.toolCallId,
    ...(typeof o.title === 'string' ? { title: bounded(o.title, 200) } : {}),
    status: o.status,
    // Load-bearing, not display trivia: BrainService.sparedChildSessionIds reads it to spare a background
    // workflow's node sessions from a parent abort, exactly as it spares a detached delegate's child.
    // Dropping it here silently turned that sparing into dead code, so any stop/detach on the origin
    // conversation killed every node of a running background workflow.
    ...(o.background === true ? { background: true } : {}),
    nodes,
  };
}

/** Runtime validation for plugin-produced progress and DB JSON. Reject malformed numeric/status fields
 *  rather than letting NaN, negative counters, or arbitrary objects reach every connected renderer. */
function normalizeSubagentState(raw: unknown): BrainSubagentRunState | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (o.status !== 'running' && o.status !== 'done' && o.status !== 'error') return undefined;
  if (typeof o.task !== 'string') return undefined;
  if (typeof o.tools !== 'number' || !Number.isSafeInteger(o.tools) || o.tools < 0) return undefined;
  if (typeof o.seconds !== 'number' || !Number.isSafeInteger(o.seconds) || o.seconds < 0) return undefined;
  if (o.tokens !== undefined && (typeof o.tokens !== 'number' || !Number.isSafeInteger(o.tokens) || o.tokens < 0)) return undefined;
  if (o.detail !== undefined && typeof o.detail !== 'string') return undefined;
  if (o.model !== undefined && typeof o.model !== 'string') return undefined;
  if (o.thinkingLevel !== undefined && typeof o.thinkingLevel !== 'string') return undefined;
  if (o.thinkingLabel !== undefined && typeof o.thinkingLabel !== 'string') return undefined;
  if (o.background !== undefined && typeof o.background !== 'boolean') return undefined;
  if (o.autoDeliver !== undefined && typeof o.autoDeliver !== 'boolean') return undefined;
  if (o.resultDelivery !== undefined && o.resultDelivery !== 'pending' && o.resultDelivery !== 'acknowledged') return undefined;
  return {
    status: o.status,
    task: bounded(o.task, 8_000),
    ...(typeof o.detail === 'string' ? { detail: bounded(o.detail, 2_000) } : {}),
    tools: o.tools,
    ...(typeof o.tokens === 'number' ? { tokens: o.tokens } : {}),
    seconds: o.seconds,
    ...(typeof o.model === 'string' ? { model: bounded(o.model, 512) } : {}),
    ...(typeof o.thinkingLevel === 'string' ? { thinkingLevel: bounded(o.thinkingLevel, 64) } : {}),
    ...(typeof o.thinkingLabel === 'string' ? { thinkingLabel: bounded(o.thinkingLabel, 64) } : {}),
    ...(typeof o.background === 'boolean' ? { background: o.background } : {}),
    ...(typeof o.autoDeliver === 'boolean' ? { autoDeliver: o.autoDeliver } : {}),
    ...(o.resultDelivery === 'pending' || o.resultDelivery === 'acknowledged' ? { resultDelivery: o.resultDelivery } : {}),
  };
}

function normalizeSubagentResult(raw: unknown): Omit<BrainSubagentResult, 'parentSessionId' | 'delivery' | 'attempts' | 'kind' | 'workflowId'> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id || o.id.length > 512) return undefined;
  if (typeof o.toolCallId !== 'string' || !o.toolCallId || o.toolCallId.length > 512) return undefined;
  if (typeof o.sessionId !== 'string' || (o.sessionId.length === 0 && o.status !== 'error')) return undefined;
  if (o.status !== 'done' && o.status !== 'error') return undefined;
  if (typeof o.task !== 'string') return undefined;
  if (typeof o.tools !== 'number' || !Number.isSafeInteger(o.tools) || o.tools < 0) return undefined;
  if (typeof o.seconds !== 'number' || !Number.isSafeInteger(o.seconds) || o.seconds < 0) return undefined;
  if (o.tokens !== undefined && (typeof o.tokens !== 'number' || !Number.isSafeInteger(o.tokens) || o.tokens < 0)) return undefined;
  if (o.result !== undefined && typeof o.result !== 'string') return undefined;
  if (o.error !== undefined && typeof o.error !== 'string') return undefined;
  if (o.model !== undefined && typeof o.model !== 'string') return undefined;
  return {
    id: o.id, toolCallId: o.toolCallId, sessionId: o.sessionId, status: o.status,
    task: bounded(o.task, 8_000),
    ...(typeof o.result === 'string' ? { result: boundedTail(o.result, 100_000) } : {}),
    ...(typeof o.error === 'string' ? { error: bounded(o.error, 100_000) } : {}),
    tools: o.tools, ...(typeof o.tokens === 'number' ? { tokens: o.tokens } : {}), seconds: o.seconds,
    ...(typeof o.model === 'string' ? { model: bounded(o.model, 512) } : {}),
  };
}

/** The terminal payload the workflow engine emits for a detached/background workflow. Mirrors the
 *  sub-agent completion, but the whole DAG summary is one body and its link is the workflow's origin
 *  call, not a child session. `cancelled` collapses to 'error' for the queue's binary status column;
 *  the summary body still names the true engine status. */
function normalizeWorkflowCompletion(
  raw: unknown,
): { id: string; toolCallId: string; status: 'done' | 'error'; task: string; result: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id || o.id.length > 512) return undefined;
  if (typeof o.toolCallId !== 'string' || !o.toolCallId || o.toolCallId.length > 512) return undefined;
  if (o.status !== 'done' && o.status !== 'error' && o.status !== 'cancelled') return undefined;
  if (typeof o.result !== 'string') return undefined;
  const title = typeof o.title === 'string' && o.title ? o.title : o.id;
  return {
    id: o.id,
    toolCallId: o.toolCallId,
    status: o.status === 'done' ? 'done' : 'error',
    task: bounded(title, 8_000),
    // A DAG summary is every node's result end to end, so it is the one payload here that really can exceed
    // the ceiling — and cutting its head costs the FIRST nodes, not the last ones the parent was waiting for.
    result: boundedTail(o.result, 100_000),
  };
}

/** Persistence for the delegated-execution slice of the embedded brain: sub-agent runs (live progress),
 *  sub-agent results (the terminal payload delivered back to a parent turn), and workflow-run DAG
 *  snapshots. Extracted from {@link BrainStore} (which delegates to it) — it shares only the {@link Db}
 *  handle. Same reject-don't-coerce validation and durable-relation revalidation as before the split. */
export class BrainDelegationStore {
  constructor(private db: Db) {}

  /** Persist the newest progress snapshot for one delegate tool call. This is deliberately synchronous:
   *  a background child may finish after the parent turn has already settled, and the live event must
   *  never race ahead of the durable state a reconnect reads. Both sessions must exist, have the same
   *  owner, and be a DIRECT parent/child pair; a plugin cannot smuggle a foreign transcript id into the
   *  parent's drill-in UI. A tool-call id is permanently bound to its first child. */
  upsertSubagentRun(parentSessionId: string, raw: unknown): boolean {
    if (!parentSessionId || !raw || typeof raw !== 'object') return false;
    const update = raw as Record<string, unknown>;
    if (typeof update.id !== 'string' || !update.id || update.id.length > 512) return false;
    if (typeof update.sessionId !== 'string' || !update.sessionId) return false;
    const state = normalizeSubagentState(update);
    if (!state) return false;
    return this.db.transaction(() => {
      const relation = this.db.prepare(
        `SELECT p.user_id AS parent_user, c.user_id AS child_user, c.parent_session_id AS linked_parent
           FROM brain_sessions p JOIN brain_sessions c ON c.id = ?
          WHERE p.id = ?`
      ).get(update.sessionId, parentSessionId) as { parent_user: number; child_user: number; linked_parent: string | null } | undefined;
      if (!relation || relation.parent_user !== relation.child_user || relation.linked_parent !== parentSessionId) return false;
      const prior = this.db.prepare(
        'SELECT child_session_id FROM brain_subagent_runs WHERE parent_session_id = ? AND tool_call_id = ?'
      ).get(parentSessionId, update.id) as { child_session_id: string } | undefined;
      if (prior && prior.child_session_id !== update.sessionId) return false;
      this.db.prepare(
        `INSERT INTO brain_subagent_runs (parent_session_id, tool_call_id, child_session_id, state)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(parent_session_id, tool_call_id) DO UPDATE SET
           state = excluded.state, updated_at = datetime('now')`
      ).run(parentSessionId, update.id, update.sessionId, JSON.stringify(state));
      return true;
    })();
  }

  /** Read only still-valid direct same-owner relations. Malformed legacy/corrupted JSON is ignored at
   *  this boundary, so all downstream wire shapes remain trusted and finite. */
  getSubagentRuns(parentSessionId: string): BrainSubagentRun[] {
    const rows = this.db.prepare(
      `SELECT r.tool_call_id, r.child_session_id, r.state, x.delivery_state
         FROM brain_subagent_runs r
         JOIN brain_sessions p ON p.id = r.parent_session_id
         JOIN brain_sessions c ON c.id = r.child_session_id
         LEFT JOIN brain_subagent_results x
           ON x.parent_session_id = r.parent_session_id AND x.tool_call_id = r.tool_call_id
        WHERE r.parent_session_id = ?
          AND c.parent_session_id = p.id
          AND c.user_id = p.user_id
        ORDER BY r.updated_at ASC, r.rowid ASC`
    ).all(parentSessionId) as { tool_call_id: string; child_session_id: string; state: string; delivery_state: string | null }[];
    const out: BrainSubagentRun[] = [];
    for (const row of rows) {
      let parsed: unknown;
      try { parsed = JSON.parse(row.state); } catch { continue; }
      const state = normalizeSubagentState(parsed);
      if (state) out.push({
        toolCallId: row.tool_call_id, sessionId: row.child_session_id, ...state,
        ...(row.delivery_state === 'pending' || row.delivery_state === 'acknowledged'
          ? { resultDelivery: row.delivery_state } : {}),
      });
    }
    return out;
  }

  /** The delegated sub-agents ONE conversation spawned, newest first — the parent's own record of what
   *  it already ran, and the only way it may address a child for a continuation.
   *
   *  Scoped by the durable relation alone: a row is returned only when it names THIS parent and still
   *  shares its owner. That is the security boundary — the caller passes no user id and cannot widen the
   *  query, so a conversation can never see (or reach) a sibling conversation's or another account's
   *  children. Ownership is re-derived on every read rather than trusted from the row, so a child that
   *  changed hands stops being listable immediately.
   *
   *  Unlike getSubagentRuns this starts from brain_sessions and only ENRICHES from brain_subagent_runs:
   *  a workflow node is a real continuable child even though the engine records the DAG instead of a
   *  per-child run row. Non-sub-agent nested sessions (a bound channel) are filtered out — they are not
   *  delegated children and have no immutable scope to resume under. */
  listDelegatedChildren(parentSessionId: string, limit = MAX_DELEGATED_CHILDREN): DelegatedChildSummary[] {
    if (!parentSessionId) return [];
    const rows = this.db.prepare(
      `SELECT c.id, c.title, c.created_at, c.updated_at, r.state, r.updated_at AS run_updated_at,
              (SELECT COUNT(*) FROM brain_messages m WHERE m.session_id = c.id) AS messages
         FROM brain_sessions c
         JOIN brain_sessions p ON p.id = c.parent_session_id
         LEFT JOIN brain_subagent_runs r
           ON r.parent_session_id = c.parent_session_id AND r.child_session_id = c.id
        WHERE c.parent_session_id = ?
          AND c.user_id = p.user_id
        ORDER BY c.created_at DESC, c.rowid DESC`
    ).all(parentSessionId) as {
      id: string; title: string; created_at: string; updated_at: string;
      state: string | null; run_updated_at: string | null; messages: number;
    }[];
    const capped = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_DELEGATED_CHILDREN) : MAX_DELEGATED_CHILDREN;
    const out: DelegatedChildSummary[] = [];
    for (const row of rows) {
      if (out.length >= capped) break;
      if (!isSubagentSession(row.id)) continue;
      // Malformed run JSON degrades to "no run detail" rather than hiding the child: the transcript is
      // still there and still continuable, which is what this listing exists to expose.
      let state: BrainSubagentRunState | undefined;
      if (row.state) {
        try { state = normalizeSubagentState(JSON.parse(row.state)); } catch { state = undefined; }
      }
      out.push({
        sessionId: row.id,
        title: row.title,
        ...(state ? { task: state.task, status: state.status } : {}),
        ...(state?.model ? { model: state.model } : {}),
        messages: Number(row.messages) || 0,
        startedAt: row.created_at,
        updatedAt: row.run_updated_at ?? row.updated_at,
      });
    }
    return out;
  }

  /** Persist the newest whole-DAG snapshot for one `WorkflowStart` tool call. Synchronous for the same
   *  reason as upsertSubagentRun: the live event must never race ahead of the durable state a reconnect
   *  reads. The origin session must exist, and a tool call is permanently bound to its first workflow id.
   *
   *  Node child sessions are deliberately NOT validated here. A node's `session` event can outrun its
   *  store row, and rejecting the whole DAG over one not-yet-verifiable node would lose the workflow —
   *  worse, stripping the id at write time would lose the drill-in permanently. getWorkflowRuns re-derives
   *  each node's target from the live relation instead, which is also correct for children deleted later. */
  upsertWorkflowRun(parentSessionId: string, raw: unknown): boolean {
    if (!parentSessionId) return false;
    const state = normalizeWorkflowState(raw);
    if (!state) return false;
    return this.db.transaction(() => {
      const parent = this.db.prepare('SELECT id FROM brain_sessions WHERE id = ?').get(parentSessionId) as { id: string } | undefined;
      if (!parent) return false;
      const prior = this.db.prepare(
        'SELECT workflow_id FROM brain_workflows WHERE parent_session_id = ? AND tool_call_id = ?'
      ).get(parentSessionId, state.toolCallId) as { workflow_id: string } | undefined;
      if (prior && prior.workflow_id !== state.id) return false;
      this.db.prepare(
        `INSERT INTO brain_workflows (parent_session_id, tool_call_id, workflow_id, state)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(parent_session_id, tool_call_id) DO UPDATE SET
           state = excluded.state, updated_at = datetime('now')`
      ).run(parentSessionId, state.toolCallId, state.id, JSON.stringify(state));
      return true;
    })();
  }

  /** Read the durable DAGs of one conversation, with each node's drill-in target re-derived from the
   *  LIVE parent/child relation: a node whose session is gone, foreign-owned, or not a direct child of
   *  this conversation keeps its row but loses `sessionId`, so a stored id can never point the drill-in
   *  UI at a transcript this conversation does not own.
   *
   *  Note the deliberate difference from getSubagentRuns, which JOINs the child and so hides the whole
   *  run when it disappears: a workflow must not vanish because ONE of its nodes did. Per-node
   *  degradation is the right granularity — the DAG is still the record of what ran. */
  getWorkflowRuns(parentSessionId: string): BrainWorkflowRun[] {
    const rows = this.db.prepare(
      `SELECT w.state FROM brain_workflows w
         JOIN brain_sessions p ON p.id = w.parent_session_id
        WHERE w.parent_session_id = ?
        ORDER BY w.updated_at ASC, w.rowid ASC`
    ).all(parentSessionId) as { state: string }[];
    if (rows.length === 0) return [];
    const children = new Set((this.db.prepare(
      `SELECT c.id FROM brain_sessions c JOIN brain_sessions p ON p.id = c.parent_session_id
        WHERE c.parent_session_id = ? AND c.user_id = p.user_id`
    ).all(parentSessionId) as { id: string }[]).map((r) => r.id));
    const out: BrainWorkflowRun[] = [];
    for (const row of rows) {
      let parsed: unknown;
      try { parsed = JSON.parse(row.state); } catch { continue; }
      const state = normalizeWorkflowState(parsed);
      if (!state) continue;
      out.push({
        ...state,
        nodes: state.nodes.map(({ sessionId, ...node }) =>
          (sessionId && children.has(sessionId) ? { ...node, sessionId } : node)),
      });
    }
    return out;
  }

  /** Every parent session holding a sub-agent run or workflow row still marked `running`. Read ONCE at
   *  daemon boot, where such a row is by definition a restart orphan — the in-memory registrations that
   *  drove it died with the process. Deliberately not scoped to a user: the boot reconcile must reach the
   *  channel and task sessions no owner `start()` ever visits. The `json_valid` guard is load-bearing —
   *  `json_extract` THROWS on a malformed row, which would fail the query for every other session too. */
  runningDelegationParentSessionIds(): string[] {
    const rows = this.db.prepare(
      `SELECT DISTINCT parent_session_id AS id FROM brain_subagent_runs
        WHERE json_valid(state) AND json_extract(state, '$.status') = 'running'
       UNION
       SELECT DISTINCT parent_session_id AS id FROM brain_workflows
        WHERE json_valid(state) AND json_extract(state, '$.status') = 'running'`
    ).all() as { id: string }[];
    return rows.map((row) => row.id);
  }

  /** Persist a terminal child result before any attempt to wake the parent. Stable result/tool ids make
   * duplicate plugin callbacks idempotent; the durable direct-child relation is revalidated here. */
  enqueueSubagentResult(parentSessionId: string, raw: unknown): boolean {
    const result = normalizeSubagentResult(raw);
    if (!parentSessionId || !result) return false;
    return this.db.transaction(() => {
      const linked = result.sessionId ? this.db.prepare(
        `SELECT 1 FROM brain_subagent_runs r
          JOIN brain_sessions p ON p.id = r.parent_session_id
          JOIN brain_sessions c ON c.id = r.child_session_id
         WHERE r.parent_session_id = ? AND r.tool_call_id = ? AND r.child_session_id = ?
           AND c.parent_session_id = p.id AND c.user_id = p.user_id`
      ).get(parentSessionId, result.toolCallId, result.sessionId) : this.db.prepare(
        'SELECT 1 FROM brain_sessions WHERE id = ?'
      ).get(parentSessionId);
      if (!linked || (!result.sessionId && result.status !== 'error')) return false;
      const payload = JSON.stringify({
        result: result.result, error: result.error, tools: result.tools, tokens: result.tokens,
        seconds: result.seconds, model: result.model,
      });
      // Handle BOTH unique constraints (result_id PK + parent/tool_call) so a late or duplicate callback can
      // never throw and silently drop a result. A real completion arriving for a (parent, tool_call) that a
      // restart reconcile already filled with a SYNTHETIC `restart-` row UPGRADES it in place, keeping its
      // queue position (created_at untouched). That holds even once the synthetic was delivered: the parent
      // was told the delegate had been interrupted, so the truth has to reach it — the row goes back to
      // pending and is delivered again. A synthetic never overwrites a real row, and a real row is never
      // clobbered by a second distinct real result (first-write-wins).
      this.db.prepare(
        `INSERT INTO brain_subagent_results
          (result_id, parent_session_id, tool_call_id, child_session_id, status, task, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(result_id) DO NOTHING
         ON CONFLICT(parent_session_id, tool_call_id) DO UPDATE SET
           result_id = excluded.result_id, child_session_id = excluded.child_session_id,
           status = excluded.status, task = excluded.task, payload = excluded.payload,
           attempts = 0, delivery_state = 'pending'
         WHERE brain_subagent_results.result_id LIKE '${SYNTHETIC_RESTART_RESULT_PREFIX}%'
           AND excluded.result_id NOT LIKE '${SYNTHETIC_RESTART_RESULT_PREFIX}%'`
      ).run(result.id, parentSessionId, result.toolCallId, result.sessionId, result.status, result.task, payload);
      const row = this.db.prepare(
        `SELECT parent_session_id, tool_call_id, child_session_id FROM brain_subagent_results WHERE result_id = ?`
      ).get(result.id) as { parent_session_id: string; tool_call_id: string; child_session_id: string } | undefined;
      return row?.parent_session_id === parentSessionId && row.tool_call_id === result.toolCallId && row.child_session_id === result.sessionId;
    })();
  }

  /** Persist a terminal WORKFLOW result before waking the parent. Same durable queue as a sub-agent
   *  completion (one place for retry/backoff/drain/ack), but the linkage is kind-aware: the row is
   *  accepted only against an existing brain_workflows DAG for this exact (parent_session_id,
   *  tool_call_id). A workflow leaves child_session_id empty and carries its id in workflow_id.
   *  First-write-wins and idempotent on a duplicate emit; workflows never take part in the synthetic
   *  restart upgrade (a daemon restart drops the in-memory engine, so there is nothing to reconcile). */
  enqueueWorkflowResult(parentSessionId: string, raw: unknown): boolean {
    const result = normalizeWorkflowCompletion(raw);
    if (!parentSessionId || !result) return false;
    return this.db.transaction(() => {
      // The workflow id is part of the linkage, not just the (parent, tool_call) pair: without it a
      // completion naming a DIFFERENT workflow is accepted and filed under this row, so the parent is
      // woken with a summary that belongs to another DAG. upsertWorkflowRun already refuses to let a
      // second workflow id take over a tool call, so the stored id is the authoritative one.
      const linked = this.db.prepare(
        'SELECT 1 FROM brain_workflows WHERE parent_session_id = ? AND tool_call_id = ? AND workflow_id = ?'
      ).get(parentSessionId, result.toolCallId, result.id);
      if (!linked) return false;
      const payload = JSON.stringify({ result: result.result });
      this.db.prepare(
        `INSERT INTO brain_subagent_results
          (result_id, parent_session_id, tool_call_id, child_session_id, kind, workflow_id, status, task, payload)
         VALUES (?, ?, ?, '', 'workflow', ?, ?, ?, ?)
         ON CONFLICT(result_id) DO NOTHING
         ON CONFLICT(parent_session_id, tool_call_id) DO NOTHING`
      ).run(result.id, parentSessionId, result.toolCallId, result.id, result.status, result.task, payload);
      const row = this.db.prepare(
        'SELECT parent_session_id, tool_call_id FROM brain_subagent_results WHERE result_id = ?'
      ).get(result.id) as { parent_session_id: string; tool_call_id: string } | undefined;
      return row?.parent_session_id === parentSessionId && row.tool_call_id === result.toolCallId;
    })();
  }

  pendingSubagentResults(parentSessionId: string): BrainSubagentResult[] {
    const rows = this.db.prepare(
      `SELECT * FROM brain_subagent_results WHERE delivery_state = 'pending'
       AND parent_session_id = ? ORDER BY created_at, rowid`
    ).all(parentSessionId) as Record<string, unknown>[];
    return rows.flatMap((row): BrainSubagentResult[] => {
      // `null` and bare scalars are valid JSON, so parsing is not enough: reading `payload.result` off a
      // `null` throws and kills the WHOLE drain, leaving every pending result of this parent undelivered
      // over one bad row. Only an object payload is usable; anything else drops just its own row.
      let parsed: unknown;
      try { parsed = JSON.parse(String(row.payload)); } catch { return []; }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
      const payload = parsed as Record<string, unknown>;
      // A workflow row has no child session and a whole-DAG summary body, so it is read directly rather
      // than through the sub-agent validator (which requires a non-empty child sessionId).
      if (row.kind === 'workflow') {
        return [{
          kind: 'workflow' as const, id: String(row.result_id), parentSessionId: String(row.parent_session_id),
          toolCallId: String(row.tool_call_id), sessionId: '',
          ...(typeof row.workflow_id === 'string' ? { workflowId: row.workflow_id } : {}),
          status: row.status === 'done' ? 'done' as const : 'error' as const, task: String(row.task ?? ''),
          ...(typeof payload.result === 'string' ? { result: payload.result } : {}),
          tools: 0, seconds: 0, delivery: 'pending' as const, attempts: Number(row.attempts) || 0,
        }];
      }
      const normalized = normalizeSubagentResult({
        id: row.result_id, toolCallId: row.tool_call_id, sessionId: row.child_session_id,
        status: row.status, task: row.task, ...payload,
      });
      return normalized ? [{
        ...normalized, kind: 'subagent' as const, parentSessionId: String(row.parent_session_id),
        delivery: 'pending' as const, attempts: Number(row.attempts) || 0,
      }] : [];
    });
  }

  acknowledgeSubagentResult(parentSessionId: string, resultId: string): boolean {
    return this.db.prepare(
      `UPDATE brain_subagent_results SET delivery_state = 'acknowledged'
       WHERE parent_session_id = ? AND result_id = ? AND delivery_state = 'pending'`
    ).run(parentSessionId, resultId).changes === 1;
  }

  noteSubagentResultFailure(parentSessionId: string, resultId: string): void {
    this.db.prepare(
      `UPDATE brain_subagent_results SET attempts = attempts + 1
       WHERE parent_session_id = ? AND result_id = ? AND delivery_state = 'pending'`
    ).run(parentSessionId, resultId);
  }
}
