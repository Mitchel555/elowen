/** The daemon↔web wire contract: the shapes the daemon serves over its HTTP/SSE surfaces and the web
 *  dock renders — the display transcript (`GET /brain/messages`, the SSE stream) AND the REST DTOs the
 *  dock lists (user, memories, memory categories/events, brain limits/usage, git commit rows). This is
 *  the ONE definition both toolchains import, so a field added on the daemon can never be silently
 *  missing on the web mirror — the exact drift this file exists to end (ToolOutputView.notes, the
 *  workflow `wf` segment, the `kind`/`detail` event rows, the sub-agent state fields, and the /auth/me
 *  `User` all diverged while these were hand-copied).
 *
 *  It carries TYPES only and imports nothing, so:
 *   - the daemon (NodeNext) and web (Bundler) resolvers both accept `../shared/wireContract.js`;
 *   - a type-only import erases at build time, adding zero runtime code to the Next bundle.
 *
 *  The owning daemon modules (src/store/*, src/brain/events.ts, src/integrations/projectFiles.ts) and
 *  `web/lib/types.ts` re-export these to their own sides; none redeclares the shapes. */

export interface ToolOutputView {
  title: string;
  kind: 'console' | 'result';
  text: string;
  fullText?: string;
  command?: string;
  /** Working directory of a console run, lifted out of the terminal plugin's `(cwd: …)` framing line so
   *  the body carries only real output. Renderers show it as faint context under the command echo. */
  cwd?: string;
  status?: string;
  tone?: 'normal' | 'success' | 'warning' | 'danger';
  /** Hook-appended annotations lifted off `result.details.notes` (the `tools.call.after` contract —
   *  e.g. "formatted a.ts with prettier"). Rendered as faint suffix lines under the output body. */
  notes?: string[];
}

/** Durable latest state attached to a delegated tool call (a sub-agent `Task`). */
export interface BrainSubagentView {
  sessionId: string;
  status: 'running' | 'done' | 'error';
  task: string;
  detail?: string;
  tools: number;
  tokens?: number;
  seconds: number;
  model?: string;
  background?: boolean;
  autoDeliver?: boolean;
  resultDelivery?: 'pending' | 'acknowledged';
}

/** Durable latest state of a workflow DAG attached to its `WorkflowStart` call. */
export interface BrainWorkflowView {
  id: string;
  toolCallId: string;
  title?: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  nodes: {
    id: string;
    task: string;
    status: 'pending' | 'running' | 'done' | 'error';
    deps: string[];
    sessionId?: string;
    detail?: string;
    tokens?: number;
    seconds?: number;
    model?: string;
    /** Epoch ms of the node's launch — clients tick live elapsed time from it between snapshots. */
    startedAt?: number;
    /** Short preview of a terminal node's outcome (bounded by the engine and again on persist). */
    result?: string;
    error?: string;
  }[];
}

/** One display piece of an assistant turn, in the order it happened: a text block, or a tool call (with a
 *  short argument summary and, for edits, the display diff). The call id stays on the wire so a
 *  post-parent-idle background update can patch the already-settled row.
 *
 *  `plan` carries the markdown a finished ExitPlanMode call submitted, so the client can render the plan
 *  panel and raise the decision from the CALL rather than by pattern-matching the assistant's prose. It
 *  is a distinct field precisely because prose could never be trusted here: a model quoting a plan tag
 *  while merely discussing plan mode is indistinguishable from one proposing a plan. */
export type BrainSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; id?: string; detail?: string; diff?: string; output?: ToolOutputView; command?: string; sub?: BrainSubagentView; wf?: BrainWorkflowView; plan?: string };

/** A durable display row (the `GET /brain/messages` payload). `id` is the SQLite message UUID when the
 *  source is a real store row (the only case served over HTTP); structural callers may omit it. `text` is
 *  the flat reply; `segments` preserve the true order. `kind`/`detail` mark a non-message system row (a
 *  model/mode/rename/cwd event) rather than an assistant/user turn. */
export interface BrainMessageView { id?: string; role: string; text: string; segments?: BrainSegment[]; kind?: string; detail?: string }

/** The mode a turn runs in: `build` (the default), `plan` (planning only, tools clamped) or `workflow`.
 *  Part of the wire contract because a surface stamps it per send AND reads it back off the daemon: the
 *  mode is otherwise per-client, so plan mode entered in one surface is invisible to every other. */
export type BrainWorkMode = 'build' | 'plan' | 'workflow';

/** A plan an `ExitPlanMode` call submitted that is still waiting on the user's implement/cancel decision.
 *  `id` is the submitting tool call's id — the key a client dedupes on so one plan raises one decision;
 *  it is absent only for a call PI minted no id for, where the plan text is the key instead. */
export interface BrainPendingPlan { id?: string; plan: string }

/** Which chat surface exposes a slash command. Part of the wire contract because `GET /brain/commands`
 *  serves the filtered list to every surface (CLI, web dock, platform bots). */
export type SlashSurface = 'cli' | 'discord' | 'whatsapp' | 'telegram' | 'msteams' | 'web';

/** How a surface handles a command once picked: `action` (server effect), `info` (fetch+render),
 *  `picker` (surface-local chooser), `mode` (local work-mode switch), `prompt` (plugin prompt macro). */
type SlashKind = 'action' | 'info' | 'picker' | 'mode' | 'prompt';

/** A chat slash command as served over `GET /brain/commands`. Defined ONCE here so the daemon's
 *  canonical list (src/brain/slashCommands.ts) and the web dock's menu can never drift — the web copy had
 *  silently lost `surfaces` (which gates visibility) and `plugin` (menu attribution). */
export interface SlashCommandDef {
  name: string;
  /** One-line help shown in every surface's menu. English (surfaces localize their own chrome only). */
  description: string;
  kind: SlashKind;
  /** Gated to admins (server-side check is `user.is_admin`). e.g. `restart`. */
  adminOnly?: boolean;
  /** Which surfaces expose it. Omitted → all. */
  surfaces?: SlashSurface[];
  /** For `kind:'prompt'` (plugin) commands: the prompt template PI expands when the raw slash arrives. */
  prompt?: string;
  /** For plugin commands: the owning plugin's name (menu attribution + provenance). */
  plugin?: string;
}

/** One option of an `AskUserQuestion` choice, as it rides the `ask` SSE event. Referenced only through
 *  `AskQuestion`, so it stays unexported — both former copies were file-local too. */
interface AskOption { label: string; description?: string; preview?: string }
/** One question of a parked `AskUserQuestion`. Clients POST the picked labels back to `/brain/answer`. */
export interface AskQuestion { question: string; header: string; multiSelect: boolean; custom?: boolean; options: AskOption[] }

/** Authoritative control state of the tapped conversation, carried on the snapshot frame and read on the
 *  same event-loop tick as the run journal. The journal alone cannot answer either question: it is cleared
 *  at settle, bounded, and deliberately holds no terminal event across an internal retry — so "is a turn
 *  running" and "is a question parked" come from the live session and the elicitation registry instead of
 *  being guessed from the tail's shape.
 *
 *  Every field is EXPLICIT: omitted-means-unchanged is what let a client keep showing a question the daemon
 *  had already settled, because a set-only hydration can never clear anything. Defined here so the daemon's
 *  snapshot and the web's reader cannot drift on the one contract that decides whether the Stop button and
 *  the question card are live. */
export interface BrainStreamControl {
  /** A turn is in flight right now — PI streaming, or a delegated child still working. */
  streaming: boolean;
  /** The question parked for this conversation, `null` when none is. */
  pendingAsk: { id: string; questions: AskQuestion[]; kind?: 'approval' } | null;
  /** Mode of the last turn the daemon ran for this conversation. The mode is stamped per send and kept
   *  nowhere else, so this is the ONLY way a client learns that another surface put the conversation in
   *  plan mode — without it a plan submitted from the CLI reaches a web tab as an ordinary tool call. */
  workMode: BrainWorkMode;
  /** The submitted plan awaiting an implement/cancel decision, `null` when none is. Explicit for the same
   *  reason as `pendingAsk`: a set-only hydration could never clear a decision the daemon has moved past. */
  pendingPlan: BrainPendingPlan | null;
}

/* ─── REST DTOs (the dock's lists and forms) ───────────────────────────────── */

/** The user as served by `GET /auth/me` — the shape that actually drifted once: the daemon grew
 *  `advisor_exec`/`advisor_autostart` and the web mirror silently rendered `undefined` until an AST
 *  mirror test caught it (see web/tests/lib/dtoMirror.test.ts). */
export interface User { id: number; username: string; created_at: string; is_admin: boolean; allowed_execs: string[]; disabled_tools: string[]; name: string; email: string; avatar: string; default_exec: string; advisor_exec: string; advisor_autostart: boolean }

/** A durable RAW memory row (v1: user-scoped; `GET /memory`). Deletes are SOFT (`status='deleted'`).
 *  `status` is a closed set because the daemon's own API schema enums exactly these three
 *  (api/schemas/memory.ts) and the web switches over them. */
export interface MemoryRow {
  id: number;
  user_id: number;
  body: string;
  kind: string;
  importance: number;
  confidence: number;
  source: string;
  status: 'active' | 'archived' | 'deleted';
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  use_count: number;
  category_id: number | null;
}

/** A user-scoped memory category (`GET /memory/categories`). `is_builtin` is 0/1; `icon` is a lucide
 *  name from the shared allowlist the daemon clamps to (src/store/memoryCategoryStore.ts), which the UI
 *  badge renders. */
export interface MemoryCategoryRow {
  id: number;
  user_id: number;
  name: string;
  description: string;
  color: string;
  icon: string;
  is_builtin: number;
  created_at: string;
}

/** One entry of a memory's audit trail (`GET /memory/:id/events`). `memory_id` is null for events whose
 *  memory was hard-removed; before/after_json are raw JSON snapshots. `model` names the model that
 *  inferred the change and is null for a user or system action — that is what tells an automatic edit
 *  apart from a deliberate one when the trail is read back. */
export interface MemoryEventRow {
  id: number;
  memory_id: number | null;
  user_id: number;
  action: string;
  before_json: string | null;
  after_json: string | null;
  actor: string;
  reason: string;
  model: string | null;
  created_at: string;
}

/** Operator-tunable brain limits (Settings → Elowen AI → Limits): each a whole number the daemon clamps
 *  to a sane range. Served inside `ElowenConfig.brain.limits` and PATCHed back as a partial. */
export interface BrainLimits {
  toolOutputMaxLines: number;
  toolOutputMaxChars: number;
  toolResultInlineBytes: number;
  elicitationTimeoutMs: number;
  memoryRecallCount: number;
  memoryRecallChars: number;
  goalTurnBudget: number;
  goalMaxTurns: number;
  channelSessionCap: number;
  delegateContextChars: number;
}

/** Operator-tunable runtime limits (Settings → Elowen AI → Runtime): each a whole number the daemon
 *  clamps to a sane range. A SIBLING of `BrainLimits` rather than more fields on it: these govern the
 *  daemon's surrounding runtime — the CLI's `!` escape, the memory relevance floor, the deferred-tool
 *  policy and activity-log retention — not the per-turn brain budget, and `BrainLimits` already mixes
 *  more domains than one editor should. Served inside `ElowenConfig.runtime` and PATCHed as a partial.
 *
 *  `memorySemanticFloorPerMille` is a cosine threshold carried in PER MILLE (300 = 0.30) because every
 *  value in these groups is rounded to a whole number on save — a float would round to 0 and floor
 *  nothing. `MemoryService` divides it back by 1000. */
export interface RuntimeLimits {
  localShellTimeoutMs: number;
  memorySemanticFloorPerMille: number;
  toolDeferThreshold: number;
  eventRetentionDays: number;
}

/** The runtime block as served/patched: the numeric limits plus the deferral kill switch (its own field
 *  because the group is uniformly numeric — one clamp loop, one slider table). */
export interface RuntimeConfig {
  limits: RuntimeLimits;
  /** Global kill switch for deferred tools. `false` → nothing is ever withheld from the prompt. */
  toolDeferralEnabled: boolean;
}

/** Statusline data for one live conversation: current context fill + session totals. The breakdown
 *  fields are the session's own cumulative sums; optional because tests and custom producers build
 *  partial literals — treat absence as 0/unknown. */
export interface BrainUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
  totalTokens: number;
  cost: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Reasoning tokens (a SUBSET of `output`, display only). */
  reasoning?: number;
  /** Average output tokens/sec across the session's measured generations; null when none measured yet. */
  outputTps?: number | null;
}

/** Durable state of one autonomous goal, served in the stream snapshot frame (`goal`). The store row
 *  and every client view use the same shape so lifecycle transitions cannot drift between polling and
 *  live streams. */
export interface BrainGoalState {
  session_id: string;
  user_id: number;
  status: 'active' | 'draft' | 'paused' | 'done';
  goal: string;
  draft: string;
  subgoals: string;
  turns_used: number;
  turn_budget: number;
  last_verdict: string;
  last_evidence: string;
  paused_reason: string;
  created_at: string;
  updated_at: string;
}

/** One file's +added/−deleted churn within a commit — a project's git log rows and a task's frozen
 *  change list both render from this. */
export interface CommitFileChange { path: string; added: number; deleted: number }

/** One commit of a project's git log (newest first). */
export interface CommitLogEntry { hash: string; subject: string; author: string; timestamp: number; files: CommitFileChange[] }
