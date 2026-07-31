/** The daemon↔web wire contract: the pure display-transcript shapes the daemon serves over
 *  `GET /brain/messages` and the SSE stream, and the web dock renders. This is the ONE definition both
 *  toolchains import, so a field added on the daemon can never be silently missing on the web mirror —
 *  the exact drift this file exists to end (ToolOutputView.notes, the workflow `wf` segment, the
 *  `kind`/`detail` event rows, and the sub-agent state fields all diverged while these were hand-copied).
 *
 *  It carries TYPES only and imports nothing, so:
 *   - the daemon (NodeNext) and web (Bundler) resolvers both accept `../shared/wireContract.js`;
 *   - a type-only import erases at build time, adding zero runtime code to the Next bundle.
 *
 *  `src/brain/messageView.ts` re-exports these to the daemon; `web/lib/types.ts` re-exports them to the
 *  web. Neither redeclares the shapes. */

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
