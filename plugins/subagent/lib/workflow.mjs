// Workflow engine: runs a declarative DAG of sub-agents. Each node is spawned through the SAME host
// `run` handler the `delegate` tool uses (System 1 in-process PI sessions — never Orca/overseer), so a
// node inherits the caller's access/model and its usage rolls up to the originating conversation. The
// engine holds the DAG in memory (like delegate's background jobs) and streams the whole snapshot to the
// parent's clients as `workflow` events on every state change. It does NOT emit `subagent` events, so a
// workflow node never doubles up in the flat sub-agent panel.
import { randomUUID } from 'node:crypto';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { validateWorkflowNodes, mergeWorkflowNodes, readyNodeIds } from './dag.mjs';
import {
  CONTEXT_HEADER,
  MAX_CONTEXT_CHUNK_CHARS,
  MAX_CONTEXT_CHUNKS,
  TRUNCATION_MARKER,
  resolveContextTotalChars,
} from './limits.mjs';
import { clipTail } from './results.mjs';

const MAX_WORKFLOWS = 16;
const WORKFLOW_RETENTION_MS = 60 * 60_000;
const MAX_RESULT_CHARS = 8_000;
// The workflow snapshot re-emits every node on each state change; the UI only previews a node's task, so
// the snapshot carries at most this many chars of it (the full task still drives the child's turn).
const SNAPSHOT_TASK_PREVIEW = 500;
// Same bound for a terminal node's result/error preview: the modal dock shows a line or two, and the
// full MAX_RESULT_CHARS body already reaches the parent through the blocking WorkflowStart return.
const SNAPSHOT_RESULT_PREVIEW = 500;
// Never hand a node a slice too small to carry a finding. A fan-in whose results cannot each reach this
// is REFUSED (see buildNodeAccess): a node reporting conclusions drawn from three words per dependency —
// or, once the forced minimum overran the budget, from dependencies it was never shown — is worse than a
// node that fails and says why.
const DEP_MIN_CHARS = 400;
// The blank line joining two result blocks inside one chunk.
const DEP_BLOCK_SEPARATOR = '\n\n';

const ok = (text, details = {}) => ({ content: [{ type: 'text', text }], details });
const errorText = (e) => (e instanceof Error ? e.message : String(e));
const clip = (text, limit) => (text.length <= limit ? text : `${text.slice(0, limit)}${TRUNCATION_MARKER}`);
/** A dependency block keeps the END of the result for the same reason the result itself does — the finding is
 *  in the last paragraph — but with the bare marker PREPENDED rather than clipTail's note. It costs exactly
 *  TRUNCATION_MARKER.length, which the per-block budget arithmetic below reserves, and DelegateRead would be
 *  no use to a node anyway: it reads a session's own children, and a sibling node is not one. `depIntro`
 *  already names, to the node, every dependency it is not seeing whole. */
const clipDep = (text, limit) => (text.length <= limit ? text : `[truncated]\n${text.slice(-limit)}`);
const depBlockHeading = (id) => `## Result from node "${id}"\n`;
/** The note introducing the dependency blocks, naming the ones the node is not seeing in full. */
const depIntro = (truncatedIds) => 'Results from the nodes this one depends on follow, one block per node.'
  + (truncatedIds.length
    ? `\n\nThese were truncated to fit and you are NOT seeing them in full: ${truncatedIds.join(', ')}. `
      + 'Say so in your output rather than treating what you received as the complete result.'
    : '');
// Some models (seen: Qwen max preview) double-escape non-ASCII in tool-call JSON, so the parsed title
// still carries literal backslash-u sequences ("Docs \u2014 write" instead of "Docs — write"). The title
// is pure display, so decoding is always what the model meant; surrogate pairs recombine naturally.
const decodeUnicodeEscapes = (s) =>
  (s.includes('\\u') ? s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) : s);

// The node-declaration shape shared by WorkflowStart and WorkflowAddNodes.
const NODE_SHAPE = Type.Object({
  id: Type.String({ description: 'Short unique id for this node (referenced by other nodes\' deps).' }),
  task: Type.String({ description: 'The complete, self-contained instruction for this node\'s sub-agent — it cannot see the conversation.' }),
  deps: Type.Optional(Type.Array(Type.String(), { description: 'Ids of nodes that must finish before this one starts. Omit for a root node.' })),
  model: Type.Optional(Type.String({ description: 'Run this node on a DIFFERENT model (value from DelegateModels). Omit to inherit yours.' })),
  read_only: Type.Optional(Type.Boolean({ description: 'Give this node only read-only tools (explore/report, no writing or delegation).' })),
  tools: Type.Optional(Type.Array(Type.String(), { description: 'Give this node EXACTLY these tools (names from your own toolset). Narrows only.' })),
  subagent_type: Type.Optional(Type.String({ description: 'Run this node as a named sub-agent TYPE (from the delegate tool\'s type list) — it supplies the role prompt and toolset (a read-only type already includes read-only shell). Omit for a generic node.' })),
});

/** Register the workflow tools on the subagent plugin. `getRun` returns the host channel handler once
 *  connected; `helpers` are the delegate primitives reused verbatim so node spawning matches delegation
 *  exactly (same narrowing invariant, same principal check, same context chunking). */
export function registerWorkflow(ctx, getRun, { resolveDelegateTools, principalOf, delegateContextChunks }) {
  /** id -> workflow. In-memory only (mirrors delegate's `jobs`): a workflow does not survive a daemon
   *  restart, and its node child sessions persist on their own. */
  const workflows = new Map();

  const freshNodeState = () => ({ status: 'pending', sessionId: '', tools: 0, detail: undefined, tokens: undefined, seconds: undefined, model: undefined, startedAt: undefined, result: undefined, error: undefined });

  const statusMap = (wf) => {
    const map = {};
    for (const [id, s] of wf.state) map[id] = s.status;
    return map;
  };

  const pruneWorkflows = (now = Date.now()) => {
    for (const [id, wf] of workflows) {
      if (wf.finishedAt !== undefined && now - wf.finishedAt >= WORKFLOW_RETENTION_MS) workflows.delete(id);
    }
    // Bounded memory without blocking new starts: once retained history grows past MAX_WORKFLOWS, evict
    // the OLDEST finished entries first (a finished workflow no longer counts against the start limit
    // below, so this only trims history, never a workflow anyone is still waiting on).
    if (workflows.size > MAX_WORKFLOWS) {
      const finished = [...workflows.values()]
        .filter((wf) => wf.finishedAt !== undefined)
        .sort((a, b) => a.finishedAt - b.finishedAt);
      for (const wf of finished) {
        if (workflows.size <= MAX_WORKFLOWS) break;
        workflows.delete(wf.id);
      }
    }
  };

  /** Resolve a workflow the CURRENT turn is allowed to see/extend. Two authorized callers, fail closed:
   *   - one of the workflow's OWN node child sessions (self-expansion). A delegated node turn always runs
   *     as the anonymous `subagent:subagent` principal (identity.forDelegatedTurn), so its principal can
   *     never match the origin's — membership in `childSessions` is the authorization here, and it is
   *     unforgeable: a session lands there only via THIS workflow's own node `session` events.
   *   - the ORIGIN session itself, which must carry the same real principal that started the workflow. */
  const authWorkflow = (id) => {
    const wf = workflows.get(id);
    if (!wf) return undefined;
    const sessionId = ctx.currentSessionId();
    if (!sessionId) return undefined;
    if (wf.childSessions.has(sessionId)) return wf;
    const principal = principalOf(ctx.currentIdentity());
    return principal && wf.originPrincipal === principal && sessionId === wf.originSessionId ? wf : undefined;
  };

  const snapshot = (wf) => {
    if (!wf.emit) return;
    const nodes = wf.nodes.map((n) => {
      const s = wf.state.get(n.id);
      return {
        id: n.id,
        // The whole snapshot re-fans on every tool/step event; the panel/modal only preview the task, so
        // send a bounded slice rather than up to 4k chars × N nodes each time.
        task: n.task.length > SNAPSHOT_TASK_PREVIEW ? `${n.task.slice(0, SNAPSHOT_TASK_PREVIEW)}…` : n.task,
        status: s.status,
        deps: n.deps,
        ...(s.sessionId ? { sessionId: s.sessionId } : {}),
        ...(s.detail ? { detail: s.detail } : {}),
        ...(s.tokens !== undefined ? { tokens: s.tokens } : {}),
        ...(s.seconds !== undefined ? { seconds: s.seconds } : {}),
        // The resolved model once the node has started; before that, the declared override if there is one.
        ...(s.model ?? n.model ? { model: s.model ?? n.model } : {}),
        ...(s.startedAt !== undefined ? { startedAt: s.startedAt } : {}),
        ...(s.result ? { result: clip(s.result, SNAPSHOT_RESULT_PREVIEW) } : {}),
        ...(s.error ? { error: clip(s.error, SNAPSHOT_RESULT_PREVIEW) } : {}),
      };
    });
    // Always the ORIGIN's WorkflowStart call, never whatever tool call is executing right now: a node's
    // own turn can trigger a snapshot (WorkflowAddNodes), and it must still land on the origin's row.
    // `background` rides the snapshot because it is not display trivia: the host reads it to decide which
    // node sessions a parent abort must SPARE, and the CLI to decide what Ctrl+B still has left to detach.
    try {
      wf.emit({
        id: wf.id, toolCallId: wf.toolCallId, ...(wf.title ? { title: wf.title } : {}),
        status: wf.status, ...(wf.background ? { background: true } : {}), nodes,
      });
    }
    catch (e) { ctx.logger.warn(`workflow snapshot fan-out failed: ${errorText(e)}`); }
  };

  /** Build one node's access from the captured parent scope + the node's own model/tool narrowing —
   *  mirrors the `delegate` access assembly exactly (can only ever narrow the parent). May reject. */
  const buildNodeAccess = async (wf, node) => {
    let model = wf.parentModel ? { provider: wf.parentModel.provider, model: wf.parentModel.model } : undefined;
    if (node.model) {
      const list = await ctx.listModels().catch(() => []);
      const hit = list.find((m) => `${m.provider}/${m.model}` === node.model || m.model === node.model);
      if (!hit) throw new Error(`model "${node.model}" is not available for node "${node.id}"`);
      model = { provider: hit.provider, model: hit.model };
    }
    // Nodes inherit the workflow origin's reasoning effort by default (the host drops it if a node's own
    // model has no such level), mirroring the delegate tool.
    const thinkingLevel = wf.parentModel?.thinkingLevel;
    // A named sub-agent TYPE, validated against the live catalog exactly as the delegate tool does — the
    // host resolves the name into the node's role prompt, toolset and (for a read-only type) boundary.
    let agentType;
    if (node.subagentType) {
      const types = ctx.subagentTypes?.() ?? [];
      if (!types.some((t) => t.name === node.subagentType)) {
        throw new Error(`unknown subagent_type "${node.subagentType}" for node "${node.id}". Available: ${types.map((t) => t.name).join(', ') || '(none)'}.`);
      }
      agentType = node.subagentType;
    }
    const restricted = resolveDelegateTools(wf.parentAccess.toolPolicy?.allow, node.tools, ctx.toolNames());
    if (restricted.error) throw new Error(restricted.error);
    const toolPolicy = restricted.allow
      ? { ...(wf.parentAccess.toolPolicy?.deny ? { deny: wf.parentAccess.toolPolicy.deny } : {}), allow: restricted.allow }
      : wf.parentAccess.toolPolicy;
    // A node that keeps full access (no read_only, no explicit toolset) may extend the DAG; a narrowed
    // node cannot (it may not even hold WorkflowAddNodes), so it is never invited to.
    const canExpand = !node.readOnly && !node.tools;
    // Read live (Settings → Elowen AI → Limits), so raising the budget applies to the next node without a
    // daemon restart.
    const contextTotal = resolveContextTotalChars(ctx.delegateContextChars?.());
    const contextParts = [];
    if (canExpand) {
      contextParts.push(`You are node "${node.id}" of a running workflow (id "${wf.id}"). Only if completing this `
        + `task clearly reveals concrete follow-up sub-tasks, you may call WorkflowAddNodes with that workflowId `
        + `to add them; otherwise just finish your task and report.`);
    }
    if (wf.sharedContext) contextParts.push(wf.sharedContext);
    // What the node waited for. Without this a dependency edge only ORDERS the run: the node still starts
    // with an empty context and has to re-derive — or invent — whatever its dependencies already produced,
    // which is precisely the "gather → analyze → write" shape the tool advertises. Appended last, after the
    // workflow-wide shared context, so the stable part of the prefix stays identical across nodes.
    const depResults = (node.deps ?? [])
      .map((id) => ({ id, result: wf.state.get(id)?.result }))
      .filter((d) => d.result);
    if (depResults.length) {
      // Each dependency gets its OWN prompt chunk (several share one only when the DAG is wider than the
      // chunk budget), so the per-chunk ceiling bounds a SINGLE result rather than all of them joined.
      //
      // The division is against EXACT packaging, not estimates of it: delegateContextChunks puts the
      // context header on the first chunk and reserves the truncation marker on every chunk, and a block
      // costs its own heading plus the node id. Rounded guesses plus a forced minimum slice is what made a
      // wide fan-in overrun the total — the chunker then clipped and dropped the last groups, and the node
      // ran on dependencies it had never been shown, with nothing in its context saying so.
      const spent = contextParts.reduce((n, part) => n + part.length + TRUNCATION_MARKER.length,
        CONTEXT_HEADER.length + 1);
      // Chunks left for the results, after the parts already queued and the note that introduces them.
      const slots = Math.max(1, MAX_CONTEXT_CHUNKS - contextParts.length - 1);
      const perChunk = Math.ceil(depResults.length / slots);
      const groups = Math.ceil(depResults.length / perChunk);
      // Reserve the note at its WORST case — every dependency named — so the reservation cannot be
      // undercut by which of them turns out to need truncating.
      const introChars = depIntro(depResults.map((d) => d.id)).length + TRUNCATION_MARKER.length;
      const blockChars = depResults.reduce((n, d) => n + depBlockHeading(d.id).length + TRUNCATION_MARKER.length, 0)
        + DEP_BLOCK_SEPARATOR.length * (depResults.length - groups);
      const perDep = Math.min(
        Math.floor((contextTotal - spent - introChars - groups * TRUNCATION_MARKER.length - blockChars)
          / depResults.length),
        Math.floor((MAX_CONTEXT_CHUNK_CHARS - TRUNCATION_MARKER.length
          - perChunk * (Math.max(...depResults.map((d) => depBlockHeading(d.id).length)) + TRUNCATION_MARKER.length)
          - DEP_BLOCK_SEPARATOR.length * (perChunk - 1)) / perChunk),
      );
      // Refuse rather than starve. Below this the node would be reasoning from fragments, and forcing the
      // minimum anyway is precisely what overran the budget and lost whole dependencies.
      if (perDep < DEP_MIN_CHARS) {
        throw new Error(`node "${node.id}" waits on ${depResults.length} dependencies whose results cannot fit its `
          + `${contextTotal}-char context budget: each would get ${Math.max(0, perDep)} chars, below the `
          + `${DEP_MIN_CHARS}-char minimum. Aggregate them through intermediate nodes, or raise the delegate `
          + 'context budget in Settings → Elowen AI → Limits.');
      }
      // Say so IN the context. A node reading a truncated dependency cannot tell whether the finding it is
      // looking for was absent or merely cut off, and that difference decides whether it should re-derive.
      contextParts.push(depIntro(depResults.filter((d) => d.result.length > perDep).map((d) => d.id)));
      for (let i = 0; i < depResults.length; i += perChunk) {
        contextParts.push(depResults.slice(i, i + perChunk)
          .map((d) => `${depBlockHeading(d.id)}${clipDep(d.result, perDep)}`)
          .join(DEP_BLOCK_SEPARATOR));
      }
    }
    const context = delegateContextChunks(contextParts, contextTotal);
    return {
      ...wf.parentAccess,
      ...(toolPolicy ? { toolPolicy } : {}),
      model,
      parentSessionId: wf.originSessionId,
      ...(wf.parentCwd ? { cwd: wf.parentCwd } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      // Number.MAX_SAFE_INTEGER, not Infinity, so the value survives any JSON round-trip (Infinity would
      // serialize to null) — keeps the node transcript pinned to this workflow instead of rolling over
      // mid-run, even though this object stays host-in-memory today.
      sessionIdleMs: Number.MAX_SAFE_INTEGER,
      // read_only selects the host-side read-only MODE (preset toolset + minted boundary), same as delegate.
      ...(node.readOnly ? { readOnly: true } : {}),
      // A typed node gets its role prompt from the host (resolved from `agentType`); an untyped node uses
      // the generic workflow-node prompt. Mirrors the delegate tool's typed/untyped split.
      ...(agentType
        ? { agentType }
        : { prompt: 'You are a focused sub-agent running one node of a workflow. Complete the task and report the result concisely — no preamble.' }),
      ...(context.length ? { context } : {}),
    };
  };

  const runNode = async (wf, node) => {
    const ns = wf.state.get(node.id);
    ns.startedAt = ns.startedAt ?? Date.now();
    const onEvent = (e) => {
      if (e.type === 'session' && e.sessionId) { ns.sessionId = e.sessionId; wf.childSessions.add(e.sessionId); snapshot(wf); }
      else if (e.type === 'tool' && e.name) { ns.tools += 1; ns.detail = e.detail ? `${e.name} ${e.detail}` : e.name; ns.seconds = Math.round((Date.now() - ns.startedAt) / 1000); snapshot(wf); }
      else if ((e.type === 'step' || e.type === 'idle') && e.usage?.totalTokens) { ns.tokens = e.usage.totalTokens; ns.seconds = Math.round((Date.now() - ns.startedAt) / 1000); snapshot(wf); }
    };
    try {
      const access = await buildNodeAccess(wf, node);
      // The EFFECTIVE model, not the node's override. `node.model` is only set when the caller named a
      // different one, so a node that inherits — the common case — would otherwise report nothing at all,
      // which is exactly when you most want to see what is actually running.
      ns.model = access.model ? `${access.model.provider}/${access.model.model}` : undefined;
      snapshot(wf);
      const channelId = `wf-${wf.id}-${node.id}-${randomUUID()}`;
      const collectSource = { platform: 'subagent', userId: 'subagent', roleIds: [], channelId, access };
      const raw = await getRun()(collectSource, node.task, onEvent);
      const reply = raw || '(the node returned nothing)';
      if (reply.startsWith('Error:')) { ns.status = 'error'; ns.error = clip(reply.slice('Error:'.length).trim() || reply, MAX_RESULT_CHARS); }
      // The node's answer reaches the parent through `summarize` and its dependents through the blocks above:
      // keep its END, where a report's conclusion is. An error stays head-first — it leads with what broke.
      else { ns.status = 'done'; ns.result = clipTail(reply, MAX_RESULT_CHARS); }
    } catch (e) {
      ns.status = 'error';
      ns.error = clip(errorText(e), MAX_RESULT_CHARS);
    }
    ns.seconds = Math.round((Date.now() - (ns.startedAt ?? Date.now())) / 1000);
    snapshot(wf);
    tick(wf);
  };

  /** Launch every node whose dependencies are all done. Marks them running BEFORE the async spawn so a
   *  re-entrant tick (from a concurrently finishing node) can never double-launch one. Coalesced + safe. */
  const tick = (wf) => {
    if (wf.finished) return;
    const ready = readyNodeIds(wf.nodes, statusMap(wf));
    if (ready.length) {
      for (const id of ready) wf.state.get(id).status = 'running';
      snapshot(wf);
      for (const id of ready) void runNode(wf, wf.nodes.find((n) => n.id === id));
    }
    maybeFinish(wf);
  };

  const maybeFinish = (wf) => {
    if (wf.finished) return;
    const states = [...wf.state.values()];
    const anyRunning = states.some((s) => s.status === 'running');
    // With nothing running and nothing newly-ready, any still-pending node is permanently blocked by a
    // failed dependency — the workflow is done (as far as it can get).
    if (anyRunning || readyNodeIds(wf.nodes, statusMap(wf)).length) return;
    wf.finished = true;
    wf.resolveDone?.();
  };

  const summarize = (wf) => {
    const lines = [`Workflow ${wf.title ? `"${wf.title}" ` : ''}finished with status: ${wf.status}.`];
    for (const n of wf.nodes) {
      const s = wf.state.get(n.id);
      lines.push('', `[${n.id}] ${s.status.toUpperCase()}${n.deps.length ? ` (after ${n.deps.join(', ')})` : ''}`);
      if (s.status === 'done') lines.push(s.result || '(no output)');
      else if (s.status === 'error') lines.push(`Error: ${s.error}`);
      else lines.push(wf.status === 'cancelled' ? '(did not run — the workflow was cancelled)' : '(did not run — a dependency failed)');
    }
    return lines.join('\n');
  };

  /** Start the DAG ONCE and resolve with the final summary when it settles. The single `tick(wf)` here is
   *  the only launch point, so a foreground blocking call and a detach/background call share ONE run: a
   *  detach never re-starts the engine, it only stops the parent waiting on it. Settles the terminal
   *  status, finishes the row (drives retention) and yields the summary the caller returns or delivers. */
  const runToCompletion = (wf) => {
    wf.status = 'running';
    snapshot(wf);
    return new Promise((resolve) => { wf.resolveDone = resolve; tick(wf); }).then(() => {
      // A cancel settles the status itself — the late arithmetic here must not repaint it as done/error
      // when the aborted node children eventually error out.
      if (wf.status !== 'cancelled') {
        wf.status = [...wf.state.values()].some((s) => s.status === 'error') ? 'error' : 'done';
      }
      wf.finished = true;
      wf.finishedAt = Date.now();
      snapshot(wf);
      return summarize(wf);
    });
  };

  /** Deliver a detached/background workflow's summary through the turn-captured durable host sink, so an
   *  explicit `background` and a Ctrl+B detach follow the exact same result path. A never-detached
   *  foreground workflow returns its summary inline instead, so this is gated on `wf.background`. */
  const deliverCompletion = (wf, summary) => {
    if (!wf.background || !wf.emitCompletion) return;
    try {
      wf.emitCompletion({ id: wf.id, toolCallId: wf.toolCallId, ...(wf.title ? { title: wf.title } : {}), status: wf.status, result: summary });
    } catch (e) {
      ctx.logger.warn(`workflow completion persistence failed: ${errorText(e)}`);
    }
  };

  /** The abort seam core calls when a parent turn is torn down (Esc-Esc, /stop, queue interrupt). The
   *  abort tree kills the node children that are RUNNING; this stops the engine from launching the rest
   *  — without it, every node whose deps had already finished would spawn a fresh child AFTER the abort,
   *  with nothing left alive to tear it down. Running nodes are left to settle: their sessions are being
   *  aborted by the same cascade, and `tick` no longer relaunches anything once `finished` is set.
   *
   *  A BACKGROUND workflow is deliberately spared. Outliving the turn that started it is the whole promise
   *  of Ctrl+B and of background:true, and the host spares a detached delegate's children on this same
   *  abort for exactly that reason. Without the check, any later Esc-Esc in the conversation — related or
   *  not — silently killed work the user had been told keeps running. */
  const cancelForSession = (sessionId) => {
    let cancelled = 0;
    for (const wf of workflows.values()) {
      if (wf.finished || wf.background || wf.originSessionId !== sessionId) continue;
      wf.status = 'cancelled';
      wf.finished = true;
      wf.finishedAt = Date.now();
      cancelled += 1;
      snapshot(wf);
      wf.resolveDone?.();
    }
    return { cancelled };
  };
  /** Ctrl+B seam (see api.ts KnownControls.workflow). Flip every foreground workflow blocking THIS origin
   *  into a background one: resolve the parent's blocking wait — never abort the nodes, they keep running —
   *  and mark it for automatic delivery. An already-background workflow is skipped, so it is never counted
   *  as newly detached. Foreground and background share ONE run, exactly like the sub-agent jobs. */
  const detachForeground = (sessionId, principal) => {
    let detached = 0;
    for (const wf of workflows.values()) {
      if (wf.finished || wf.background || wf.status !== 'running'
        || wf.originSessionId !== sessionId || wf.originPrincipal !== principal) continue;
      wf.background = true;
      wf.resolveDetached?.();
      wf.resolveDetached = undefined;
      snapshot(wf);
      detached += 1;
    }
    return { detached };
  };
  // The `workflow` control name is taken by cancelForSession, so the detach seam rides the same control.
  ctx.registerControl('workflow', {
    cancelForSession: ({ sessionId }) => cancelForSession(sessionId),
    detachForeground: ({ sessionId, principal }) => detachForeground(sessionId, principal),
  });

  ctx.registerTool(defineTool({
    name: 'WorkflowStart', label: 'Run a workflow',
    description: [
      'Run a DAG of sub-agents: you declare nodes (each a self-contained task) and their dependencies, and the engine executes them as dependencies clear — independent nodes run in parallel, dependents wait for what they need. Each node is a fresh sub-agent that inherits your access; it cannot see this conversation, so every task must be complete and standalone.',
      'Use a workflow instead of several separate delegate calls when the subtasks have an ORDER or dependency between them (gather → analyze → write), or when a later step needs earlier steps\' results. For a set of fully independent tasks, plain parallel delegate calls are simpler.',
      'A node is given the results of the nodes it depends on as context, so a later task can refer to "your dependency results" instead of repeating the work or being told it twice.',
      'By default the call BLOCKS and returns a summary of every node\'s result once the whole workflow finishes. Set background=true to return a handle immediately and have the summary delivered to you in a NEW turn when the DAG finishes — do other work meanwhile, then end your turn. A node whose dependency failed is reported as skipped. Give each node a short unique id and list its dependency ids in deps. Use read_only/tools/model per node exactly as with delegate — you can only ever narrow your own access.',
    ].join(' '),
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: 'Human label for the workflow, shown in the CLI panel: AT MOST 4 WORDS, in the user\'s language, no trailing punctuation (the UI appends an ellipsis).' })),
      context: Type.Optional(Type.String({ description: 'Background shared by ALL nodes (added to each node\'s cache-friendly system prefix) — findings, conventions, ids they would otherwise re-derive.' })),
      nodes: Type.Array(NODE_SHAPE, { description: 'The workflow nodes. At least one must have no deps (a root).' }),
      background: Type.Optional(Type.Boolean({ description: 'Start asynchronously and return a handle immediately; the summary is delivered to you in a NEW turn when the workflow finishes. Omit or false to wait for the result.' })),
    }),
    execute: async (toolCallId, p) => {
      if (!getRun()) return ok('Error: workflows are not wired up on this server.');
      const originSessionId = ctx.currentSessionId();
      const originPrincipal = principalOf(ctx.currentIdentity());
      if (!originSessionId || !originPrincipal) return ok('Error: workflows run only inside an authenticated conversation.');
      const { nodes, error } = validateWorkflowNodes(p.nodes);
      if (error) return ok(`Error: ${error}`);
      pruneWorkflows();
      // Only UNFINISHED workflows compete for the slot — a finished one sitting in memory for retention
      // is not "running" and must never block a new start (that was the bug: 16 quickly-finished
      // workflows locked the tool out for an hour even with nothing actually in flight).
      const runningCount = [...workflows.values()].filter((wf) => wf.finishedAt === undefined).length;
      if (runningCount >= MAX_WORKFLOWS) return ok(`Error: too many workflows (${MAX_WORKFLOWS}) are running; wait for one to finish.`);
      // Capture the durable completion sink on the ORIGIN turn, before any node is scheduled — node turns
      // run in their own scope where this accessor no longer resolves to this conversation.
      const emitCompletion = ctx.workflowCompletionEmitter?.() ?? undefined;
      const wf = {
        id: `wf-${randomUUID()}`,
        // THIS call — the origin's WorkflowStart. Every snapshot names it, so the host can persist the
        // DAG against the transcript row this call produced (mirrors delegate's `toolCallId`).
        toolCallId,
        title: typeof p.title === 'string' ? decodeUnicodeEscapes(p.title.trim()).slice(0, 200) || undefined : undefined,
        status: 'running',
        nodes,
        state: new Map(nodes.map((n) => [n.id, freshNodeState()])),
        parentAccess: ctx.currentAccess(),
        parentModel: ctx.currentModel() ?? undefined,
        // The origin turn's working directory, inherited by every node so a node's tools resolve against
        // the SAME project the workflow was launched in, never the daemon's `/`.
        parentCwd: ctx.currentWorkDir?.(),
        emit: ctx.workflowEmitter(),
        sharedContext: typeof p.context === 'string' && p.context.trim() ? p.context.trim() : undefined,
        originSessionId,
        originPrincipal,
        childSessions: new Set(),
        finished: false,
        finishedAt: undefined,
        resolveDone: undefined,
        // A detach (Ctrl+B) or explicit background flips this on; foreground and background share ONE run.
        background: p.background === true,
        emitCompletion,
        resolveDetached: undefined,
      };
      workflows.set(wf.id, wf);
      // Start the DAG once. This promise settles the terminal status, finishes the row and yields the
      // summary — a foreground blocking call and a detach/background call ride this SAME run.
      const completion = runToCompletion(wf).catch((e) => {
        wf.status = 'error';
        wf.finished = true;
        wf.finishedAt = Date.now();
        return `Error: workflow failed: ${errorText(e)}`;
      });

      if (p.background === true) {
        // No durable sink on this surface (worker/cron) — block rather than silently drop the result.
        if (!emitCompletion) return ok(await completion);
        void completion.then((summary) => deliverCompletion(wf, summary));
        return ok(
          `Started background workflow ${wf.id}.\n`
            + 'Its result is delivered to you automatically in a NEW turn when it finishes — you do not have to '
            + 'fetch it. Do any other useful work now, then end your turn. If there is nothing else to do, say so '
            + 'briefly and end the turn: waiting inside this turn only delays the result.',
          { workflowId: wf.id, status: 'running' },
        );
      }

      // Foreground: block on the DAG, but let Ctrl+B detach the wait — the run keeps going in the
      // background and delivers its summary through the completion sink, exactly like explicit background.
      const detached = new Promise((resolve) => { wf.resolveDetached = resolve; });
      const winner = await Promise.race([
        completion.then((summary) => ({ kind: 'done', summary })),
        detached.then(() => ({ kind: 'detached' })),
      ]);
      if (winner.kind === 'done') return ok(winner.summary);
      void completion.then((summary) => deliverCompletion(wf, summary));
      return ok(
        `The user moved this workflow to the background. It is still running as ${wf.id}; continue helping the `
        + 'user now. Its result is delivered to you automatically in a new turn when it finishes, so once you have '
        + 'nothing else to do, end your turn instead of waiting or polling for it.',
        { workflowId: wf.id, status: 'running', detached: true },
      );
    },
  }));

  ctx.registerTool(defineTool({
    name: 'WorkflowAddNodes', label: 'Extend a workflow',
    description: 'Add nodes to a workflow that is already running (dynamic expansion). New node ids must be '
      + 'unique, may depend on existing or new nodes, and must not create a cycle. Available to the node '
      + 'sub-agents themselves so a workflow can grow as work reveals more work. Returns which nodes were added.',
    parameters: Type.Object({
      workflowId: Type.String({ description: 'The id of the running workflow (from WorkflowStart / your node briefing).' }),
      nodes: Type.Array(NODE_SHAPE, { description: 'The nodes to add.' }),
    }),
    // `_id` is THIS call's tool id, and this tool usually runs inside a NODE's own turn. It is
    // deliberately unused: the snapshot must address the origin's WorkflowStart row, which `snapshot()`
    // reads off wf.toolCallId. Keying anything here off `_id` would fork a phantom row per expansion.
    execute: async (_id, p) => {
      const wf = authWorkflow(p.workflowId);
      if (!wf) return ok(`Error: no running workflow ${p.workflowId} you can extend.`);
      if (wf.finished) return ok(`Error: workflow ${p.workflowId} has already finished; start a new one.`);
      const { nodes, error } = mergeWorkflowNodes(wf.nodes, p.nodes);
      if (error) return ok(`Error: ${error}`);
      for (const n of nodes) { wf.nodes.push(n); wf.state.set(n.id, freshNodeState()); }
      snapshot(wf);
      tick(wf);
      return ok(`Added ${nodes.length} node(s) to workflow ${wf.id}: ${nodes.map((n) => n.id).join(', ')}.`);
    },
  }));

  ctx.registerTool(defineTool({
    name: 'WorkflowStatus', label: 'Check a workflow',
    description: 'Return a snapshot of a workflow: each node\'s status, dependencies and progress. A one-off '
      + 'view for when the user asks how it is going. A foreground WorkflowStart already blocks and returns '
      + 'the full result; a background one delivers its result to you on its own in a new turn — so either '
      + 'way you do not need this to collect results, and polling it in a loop is never the answer.',
    parameters: Type.Object({ workflowId: Type.String({ description: 'The workflow id from WorkflowStart.' }) }),
    execute: async (_id, p) => {
      const wf = authWorkflow(p.workflowId);
      if (!wf) return ok(`Error: no workflow ${p.workflowId}, or it has expired.`);
      const lines = [`Workflow ${wf.id}${wf.title ? ` "${wf.title}"` : ''}: ${wf.status}`];
      for (const n of wf.nodes) {
        const s = wf.state.get(n.id);
        lines.push(`- [${n.id}] ${s.status}${n.deps.length ? ` (deps: ${n.deps.join(', ')})` : ''}`
          + `${s.tokens !== undefined ? ` · ${s.tokens} tok` : ''}${s.seconds !== undefined ? ` · ${s.seconds}s` : ''}`
          + `${s.detail ? ` · ${s.detail}` : ''}`);
      }
      return ok(lines.join('\n'), { workflowId: wf.id, status: wf.status });
    },
  }));

  ctx.logger.info('workflow tools registered (start/add_nodes/status)');
}
