import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { registerWorkflow } = await import(resolve(repoRoot, 'plugins/subagent/lib/workflow.mjs')) as {
  registerWorkflow(ctx: unknown, getRun: unknown, helpers: unknown): void;
};
// The REAL chunker, not a double. A pass-through double is what let a wide fan-in ship broken: the engine
// sized its slices against a budget the packaging could never hold, and the only thing that would have
// caught it was the very function the double replaced.
const { delegateContextChunks } = await import(resolve(repoRoot, 'plugins/subagent/index.mjs')) as {
  delegateContextChunks(raw: unknown, totalChars?: number): string[];
};

interface Tool { name: string; execute(id: string, p: unknown): Promise<{ content: { text: string }[]; details?: Record<string, unknown> }> }

/** Build a workflow harness: a mock plugin ctx that captures the registered tools + emitted snapshots,
 *  and a controllable fake `run` handler. `run` resolves each node to `done:<task>` unless the task
 *  contains "FAIL" (then it returns an Error), recording the order nodes were launched. */
interface WorkflowControl { cancelForSession(input: { sessionId: string }): { cancelled: number } }

/** When set, the harness `run` parks the matching task on this promise and settles it as an aborted
 *  child ("Error: interrupted") once released — the cancel test's stand-in for the host's abort tree. */
let gate: { task: string; promise: Promise<void> } | null = null;

function harness(opts: { toolPolicyAllow?: string[]; contextChars?: number } = {}) {
  gate = null;
  const tools = new Map<string, Tool>();
  const controls = new Map<string, WorkflowControl>();
  const snapshots: { id: string; toolCallId: string; title?: string; status: string; nodes: { id: string; status: string; deps: string[]; startedAt?: number; result?: string; error?: string }[] }[] = [];
  const launched: string[] = [];
  /** The context chunks each node was actually handed, by task — what the child can see, not what we hoped. */
  const contexts = new Map<string, string[]>();
  // A resume test needs a node that fails its FIRST run and succeeds on retry — real recovery, not a
  // second guaranteed failure. FAIL_ONCE tracks attempts per exact task string.
  const attempts = new Map<string, number>();
  /** Every launch as the host saw it: which channel the node ran in, and the VERBATIM task it received.
   *  A resume is only real if the channel id repeats — that is what puts the retry back in the same session. */
  const runs: { task: string; channelId: string; fullTask: string }[] = [];
  const run = async (source: { access?: { context?: string[] }; channelId?: string }, fullTask: string, onEvent: (e: unknown) => void) => {
    // A resumed node is handed its task plus a trailing resume note. Everything keyed by identity here
    // (launch order, session id, FAIL_ONCE attempts) must key on the TASK, or a retry would read as a
    // different node and FAIL_ONCE would fail forever.
    const task = fullTask.split('\n\nNote: an earlier attempt')[0]!;
    launched.push(task);
    runs.push({ task, channelId: source.channelId ?? '', fullTask });
    contexts.set(task, source.access?.context ?? []);
    onEvent({ type: 'session', sessionId: `s-${task}` });
    onEvent({ type: 'tool', name: 'Read' });
    onEvent({ type: 'idle', usage: { totalTokens: 100 } });
    if (gate && task === gate.task) { await gate.promise; return 'Error: interrupted'; }
    if (task.includes('FAIL_ONCE')) {
      const n = (attempts.get(task) ?? 0) + 1;
      attempts.set(task, n);
      if (n === 1) return 'Error: boom (will succeed on retry)';
    } else if (task.includes('FAIL')) return 'Error: boom';
    // A node's own task is capped at 4 000 chars, so a report bigger than that cannot be echoed back from
    // it — `BULK:<n>` asks for a result of n chars instead, the way a real node returns far more than it
    // was asked. It ends in `:CONCLUSION`, so a test can tell whether the END of a report survived.
    const bulk = /BULK:(\d+)/.exec(task);
    return bulk ? `done:${task}:${'x'.repeat(Number(bulk[1]))}:CONCLUSION` : `done:${task}`;
  };
  /** Mutable so a test can call a tool AS one of the workflow's own node sessions. */
  const sessionId = { current: 'brain-parent' };
  const ctx = {
    registerTool: (def: Tool) => { tools.set(def.name, def); },
    registerControl: (name: string, control: WorkflowControl) => { controls.set(name, control); },
    logger: { info() {}, warn() {} },
    currentSessionId: () => sessionId.current,
    currentIdentity: () => ({ elowenUserId: 1, platform: 'cli', userId: '1' }),
    currentAccess: () => ({ toolPolicy: opts.toolPolicyAllow ? { allow: opts.toolPolicyAllow } : undefined }),
    currentModel: () => ({ provider: 'p', model: 'm' }),
    workflowEmitter: () => (u: (typeof snapshots)[number]) => { snapshots.push(u); },
    listModels: async () => [],
    toolNames: () => ['Read', 'Write', 'Bash'],
    delegateContextChars: () => opts.contextChars ?? undefined,
  };
  const helpers = {
    resolveDelegateTools: (_inheritedAllow: string[] | undefined, requested: string[] | undefined) =>
      (requested ? { allow: requested } : { allow: undefined }),
    principalOf: (identity: unknown) => (identity ? 'elowen:1' : null),
    delegateContextChunks,
  };
  registerWorkflow(ctx, () => run, helpers);
  /** Everything the node can read, as one string — the chunks are a transport detail, not the content. */
  const contextOf = (task: string) => (contexts.get(task) ?? []).join('\n\n');
  return { tools, controls, snapshots, launched, contexts, contextOf, sessionId, runs };
}

describe('workflow engine', () => {
  it('runs a linear DAG in dependency order and returns every node result', async () => {
    const { tools, launched } = harness();
    const res = await tools.get('WorkflowStart')!.execute('t1', {
      nodes: [
        { id: 'a', task: 'a' },
        { id: 'b', task: 'b', deps: ['a'] },
        { id: 'c', task: 'c', deps: ['b'] },
      ],
    });
    expect(launched).toEqual(['a', 'b', 'c']);
    const text = res.content[0]!.text;
    expect(text).toMatch(/status: done/);
    expect(text).toContain('done:a');
    expect(text).toContain('done:c');
  });

  it('runs independent nodes that share one dependency in parallel after it', async () => {
    const { tools, launched } = harness();
    await tools.get('WorkflowStart')!.execute('t2', {
      nodes: [
        { id: 'root', task: 'root' },
        { id: 'x', task: 'x', deps: ['root'] },
        { id: 'y', task: 'y', deps: ['root'] },
      ],
    });
    expect(launched[0]).toBe('root');
    expect(launched.slice(1).sort()).toEqual(['x', 'y']);
  });

  it('marks the workflow errored and skips dependents of a failed node', async () => {
    const { tools, launched } = harness();
    const res = await tools.get('WorkflowStart')!.execute('t3', {
      nodes: [
        { id: 'a', task: 'a FAIL' },
        { id: 'b', task: 'b', deps: ['a'] },
      ],
    });
    expect(launched).toEqual(['a FAIL']); // b never launches
    const text = res.content[0]!.text;
    expect(text).toMatch(/status: error/);
    expect(text).toMatch(/did not run/);
  });

  it('emits a live snapshot stream ending in a terminal status', async () => {
    const { tools, snapshots } = harness();
    await tools.get('WorkflowStart')!.execute('t4', { nodes: [{ id: 'a', task: 'a' }] });
    expect(snapshots.length).toBeGreaterThan(1);
    expect(snapshots[0]!.status).toBe('running');
    const last = snapshots.at(-1)!;
    expect(last.status).toBe('done');
    expect(last.nodes[0]!.status).toBe('done');
  });

  // A dependency edge used to only ORDER the run: the dependent node started with an empty context and had
  // to re-derive, or invent, what its dependencies had already produced. That made the tool's own
  // "gather → analyze → write" promise false, and a real synthesis node reported it could not do its job
  // because the reports it was told it would receive were nowhere in its context.
  it('hands a node the results of the dependencies it waited for', async () => {
    const { tools, contextOf } = harness();
    await tools.get('WorkflowStart')!.execute('t-deps', {
      nodes: [
        { id: 'gather', task: 'gather' },
        { id: 'other', task: 'other' },
        { id: 'write', task: 'write', deps: ['gather'] },
      ],
    });
    const write = contextOf('write');
    expect(write).toContain('done:gather');
    expect(write).toContain('gather'); // attributed to the node it came from
    // Only what it actually depends on — a sibling branch is not its business.
    expect(write).not.toContain('done:other');
    // A root node has nothing to inherit and must not be handed a phantom results block.
    expect(contextOf('gather')).not.toContain('Results from the nodes');
  });

  // A wide fan-in used to lose everything but its first dependency. The slices were cut to fit a budget
  // six times larger than the one context chunk could hold, so the join was clipped from the front and a
  // seven-branch synthesis node received one truncated report and six that were simply absent. It said
  // so in its output, which is the only reason anyone noticed — so the fix has to divide what is really
  // left AND tell the node which results it is not seeing in full.
  it('gives a wide fan-in every dependency, and names the ones it had to truncate', async () => {
    const { tools, contextOf } = harness();
    const branches = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    // Each branch reports far more than its slice can hold, the way a real review section does.
    const longTask = (id: string) => `${id}:${'x'.repeat(3_000)}`;
    await tools.get('WorkflowStart')!.execute('t-fanin', {
      nodes: [
        ...branches.map((id) => ({ id, task: longTask(id) })),
        { id: 'synthesis', task: 'synthesise', deps: branches },
      ],
    });
    const synthesis = contextOf('synthesise');
    // Every branch is present and attributed — not just however many fit before the clip.
    for (const id of branches) expect(synthesis).toContain(`## Result from node "${id}"`);
    // And the node is told, by name, what it is reading only part of.
    expect(synthesis).toContain('truncated to fit');
    for (const id of branches) expect(synthesis).toMatch(new RegExp(`truncated to fit[^\\n]*${id}`));
  });

  // The fan-in the seven-branch test never reached: with dozens of dependencies the divided budget fell
  // below the 400-char floor, which the engine then applied anyway. The blocks that resulted overran the
  // context budget, delegateContextChunks cut the last GROUPS off, and the node ran — and reported — on
  // dependencies it had never been shown. An input it cannot represent must fail the node, not shrink it.
  it('refuses a fan-in it cannot represent instead of running the node on missing dependencies', async () => {
    const { tools, launched, contextOf } = harness({ contextChars: 26_000 });
    const branches = Array.from({ length: 63 }, (_, i) => `n${i}`);
    const res = await tools.get('WorkflowStart')!.execute('t-wide', {
      nodes: [
        ...branches.map((id) => ({ id, task: `${id} BULK:600` })),
        { id: 'synthesis', task: 'synthesise', deps: branches },
      ],
    });
    const text = res.content[0]!.text;
    expect(text).toMatch(/status: error/);
    expect(text).toMatch(/\[synthesis\] ERROR/);
    // Actionable: it names the fan-in and the budget that could not carry it.
    expect(text).toMatch(/63 dependenc/);
    expect(text).toMatch(/26000|26 000/);
    // And it never started on a partial context.
    expect(launched).not.toContain('synthesise');
    expect(contextOf('synthesise')).toBe('');
  });

  // A width the budget CAN represent, with every dependency reporting far more than its slice: the packed
  // context must then sit right under the budget, so each dependency arrives as its own attributed block
  // and none is cut off the end by the chunker. This is where an ESTIMATED block cost overruns.
  it('carries a wide fan-in in full when the budget can hold it, without breaching the scope bounds', async () => {
    const { tools, contexts } = harness({ contextChars: 26_000 });
    const branches = Array.from({ length: 24 }, (_, i) => `n${i}`);
    await tools.get('WorkflowStart')!.execute('t-wide-ok', {
      nodes: [
        ...branches.map((id) => ({ id, task: `${id} BULK:8000` })),
        { id: 'synthesis', task: 'synthesise', deps: branches },
      ],
    });
    const chunks = contexts.get('synthesise') ?? [];
    const joined = chunks.join('\n\n');
    for (const id of branches) expect(joined).toContain(`## Result from node "${id}"`);
    expect(joined).not.toContain('further context block'); // nothing silently cut by the chunker
    expect(chunks.length).toBeLessThanOrEqual(16);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(8_000);
    expect(chunks.reduce((n, chunk) => n + chunk.length, 0)).toBeLessThanOrEqual(26_000);
    // Every dependency got the SAME slice. An overrun does not announce itself: the chunker simply shaves
    // the tail of the chunk it no longer has room for, which shows up here as one short final block.
    const sizes = [...receivedPerNode(joined, branches).values()];
    expect(new Set(sizes).size).toBe(1);
    expect(sizes[0]).toBeGreaterThanOrEqual(400);
  });

  /** How many chars of each dependency's own report actually reached the dependent node. */
  const receivedPerNode = (context: string, ids: string[]): Map<string, number> => {
    const sizes = new Map<string, number>();
    for (const id of ids) {
      const body = context.split(`## Result from node "${id}"\n`)[1] ?? '';
      sizes.set(id, body.split('## Result from node "')[0]!.trim().length);
    }
    return sizes;
  };

  // Five dependencies of 3 000 chars are 15 000 chars in total — far more than one prompt chunk can hold,
  // which is why they used to arrive at ~1 000 chars each (13% of the text). One chunk per dependency
  // carries them whole.
  it('hands a five-way fan-in every dependency in full when the budget allows', async () => {
    const { tools, contextOf } = harness();
    const branches = ['a', 'b', 'c', 'd', 'e'];
    const report = (id: string) => `${id}:${'x'.repeat(3_000)}`;
    await tools.get('WorkflowStart')!.execute('t-five', {
      nodes: [
        ...branches.map((id) => ({ id, task: report(id) })),
        { id: 'synthesis', task: 'synthesise', deps: branches },
      ],
    });
    const synthesis = contextOf('synthesise');
    expect(synthesis).not.toContain('[truncated]');
    expect(synthesis).not.toContain('truncated to fit');
    // Every branch's whole report, verbatim — `done:` is what the harness `run` prefixes a result with.
    for (const id of branches) expect(synthesis).toContain(`done:${report(id)}`);
  });

  // The measured regression: five dependencies at the 8 000-char result cap used to reach the dependent
  // node as ~1 093 chars each. The prompt total still cannot carry 40 000 chars, so they ARE truncated —
  // but each must keep a usable share of its report, and the node must be told which ones were cut.
  it('keeps a usable share of each dependency when a five-way fan-in cannot fit whole', async () => {
    const { tools, contextOf } = harness({ contextChars: 26_000 });
    const branches = ['a', 'b', 'c', 'd', 'e'];
    await tools.get('WorkflowStart')!.execute('t-five-big', {
      nodes: [
        ...branches.map((id) => ({ id, task: `${id} BULK:8000` })),
        { id: 'synthesis', task: 'synthesise', deps: branches },
      ],
    });
    const synthesis = contextOf('synthesise');
    for (const [id, size] of receivedPerNode(synthesis, branches)) {
      expect(size, `node ${id}`).toBeGreaterThan(3_000);
    }
    for (const id of branches) expect(synthesis).toMatch(new RegExp(`truncated to fit[^\\n]*${id}`));
  });

  // A node's report is capped at 8 000 chars before it reaches the parent's summary or any dependent. Over
  // that cap it has to lose its HEAD: a report's conclusion is its last line, and cutting the tail is exactly
  // what destroyed a delegated report's conclusion on delivery.
  it('keeps the END of an over-cap node result, in the summary and in what a dependent reads', async () => {
    const { tools, contextOf } = harness();
    const res = await tools.get('WorkflowStart')!.execute('t-tail', {
      nodes: [
        { id: 'a', task: 'a BULK:9000' },
        { id: 'b', task: 'b', deps: ['a'] },
      ],
    });
    const summary = res.content[0]!.text;
    expect(summary).toContain(':CONCLUSION'); // the end survived
    expect(summary).not.toContain('done:a BULK:9000'); // the head is what paid for it
    expect(summary).toMatch(/\[truncated: first \d+ chars dropped, end kept — read it in full with DelegateRead\]/);
    // The dependent reads the same end, marked as cut. It is NOT pointed at DelegateRead: that reads a
    // session's own children, and the node it depends on is a sibling.
    const dependent = contextOf('b');
    expect(dependent).toContain(':CONCLUSION');
    expect(dependent).toContain('[truncated]');
    expect(dependent).not.toContain('DelegateRead');
  });

  // The budget is an operator setting (Settings → Elowen AI → Limits), read live off the plugin context.
  // A workflow that ignored it would silently keep the built-in default whatever the operator chose.
  it('sizes the dependency slices from the operator-configured budget', async () => {
    const branches = ['a', 'b', 'c', 'd', 'e'];
    const nodes = [
      ...branches.map((id) => ({ id, task: `${id} BULK:8000` })),
      { id: 'synthesis', task: 'synthesise', deps: branches },
    ];
    const generous = harness({ contextChars: 26_000 });
    await generous.tools.get('WorkflowStart')!.execute('t-generous', { nodes });
    const tight = harness({ contextChars: 6_000 });
    await tight.tools.get('WorkflowStart')!.execute('t-tight', { nodes });
    const big = receivedPerNode(generous.contextOf('synthesise'), branches).get('a')!;
    const small = receivedPerNode(tight.contextOf('synthesise'), branches).get('a')!;
    expect(big).toBeGreaterThan(small * 2);
    // Even on the tight budget nothing disappears without the node hearing about it.
    for (const id of branches) expect(tight.contextOf('synthesise')).toMatch(new RegExp(`truncated to fit[^\\n]*${id}`));
  });

  // The modal reports which model is burning a node's tokens. `node.model` is only set when the caller
  // named a DIFFERENT one, so reporting that alone left every inheriting node blank — the common case,
  // and the one where "what is actually running?" matters most (it is how a whole review workflow can
  // silently run on the wrong model).
  it('reports the EFFECTIVE model of a node that inherits, not just an explicit override', async () => {
    const { tools, snapshots } = harness();
    await tools.get('WorkflowStart')!.execute('t-model', { nodes: [{ id: 'a', task: 'a' }] });
    const node = snapshots.at(-1)!.nodes[0]!;
    expect(node.model).toBe('p/m'); // the parent's model, which the node inherited
  });

  // Regression: qwen3.8-max-preview double-escaped non-ASCII in the title argument, so the parsed string
  // carried a literal backslash-u sequence and the CLI rail showed "Docs update \u2014 write" verbatim.
  it('decodes double-escaped unicode sequences in the model-authored title', async () => {
    const { tools, snapshots } = harness();
    await tools.get('WorkflowStart')!.execute('t-esc', {
      title: 'Docs \\u2014 p\\u0159epis',
      nodes: [{ id: 'a', task: 'a' }],
    });
    expect(snapshots[0]!.title).toBe('Docs — přepis');
  });

  // The dock previews a terminal node's outcome straight from the snapshot, so the emitted nodes must
  // carry result/error (clipped) and startedAt — the engine tracks them internally either way.
  it('carries startedAt plus clipped result and error previews in snapshots', async () => {
    const { tools, snapshots } = harness();
    await tools.get('WorkflowStart')!.execute('t-prev', {
      nodes: [
        { id: 'good', task: `g${'x'.repeat(600)}` },
        { id: 'bad', task: 'bad FAIL' },
      ],
    });
    const last = snapshots.at(-1)!;
    const good = last.nodes.find((n) => n.id === 'good')!;
    const bad = last.nodes.find((n) => n.id === 'bad')!;
    expect(good.startedAt).toBeTypeOf('number');
    expect(good.result).toMatch(/^done:gx/);
    expect(good.result!.length).toBeLessThan(560); // 500-char preview + truncation marker, not the full body
    expect(good.result).toMatch(/\[truncated\]$/);
    expect(bad.error).toBe('boom');
  });

  // Every snapshot names the origin's WorkflowStart call: it is the durable anchor that binds the DAG
  // to the parent's transcript row, so the host can persist it and the marker survives a reconnect.
  it('stamps every snapshot with the originating WorkflowStart tool call id', async () => {
    const { tools, snapshots } = harness();
    await tools.get('WorkflowStart')!.execute('call-42', { nodes: [{ id: 'a', task: 'a' }] });
    expect(snapshots.length).toBeGreaterThan(1);
    expect(snapshots.every((s) => s.toolCallId === 'call-42')).toBe(true);
  });

  it('runs nodes added dynamically while the workflow is still running', async () => {
    const tools = new Map<string, Tool>();
    const launched: string[] = [];
    const snapshots: { id: string; toolCallId: string; status: string }[] = [];
    let releaseRoot!: () => void;
    const rootGate = new Promise<void>((r) => { releaseRoot = r; });
    const run = async (_s: unknown, task: string, onEvent: (e: unknown) => void) => {
      launched.push(task);
      onEvent({ type: 'session', sessionId: `s-${task}` });
      if (task === 'root') await rootGate; // hold the workflow open so we can extend it mid-flight
      return `done:${task}`;
    };
    const ctx = {
      registerTool: (def: Tool) => { tools.set(def.name, def); },
      registerControl: () => {},
      logger: { info() {}, warn() {} },
      currentSessionId: () => 'brain-parent',
      currentIdentity: () => ({ elowenUserId: 1, platform: 'cli', userId: '1' }),
      currentAccess: () => ({ toolPolicy: undefined }),
      currentModel: () => ({ provider: 'p', model: 'm' }),
      workflowEmitter: () => (u: { id: string; toolCallId: string; status: string }) => { snapshots.push(u); },
      listModels: async () => [],
      toolNames: () => ['Read'],
    };
    registerWorkflow(ctx, () => run, {
      resolveDelegateTools: () => ({ allow: undefined }),
      principalOf: () => 'elowen:1',
      delegateContextChunks,
    });
    const startP = tools.get('WorkflowStart')!.execute('t6', { title: 'dyn', nodes: [{ id: 'root', task: 'root' }] });
    await new Promise((r) => setTimeout(r, 5)); // let root launch and park on the gate
    const wfId = snapshots[0]!.id; // learn the generated workflow id from the first live snapshot
    const added = await tools.get('WorkflowAddNodes')!.execute('a1', {
      workflowId: wfId,
      nodes: [{ id: 'leaf', task: 'leaf', deps: ['root'] }],
    });
    expect(added.content[0]!.text).toMatch(/Added 1 node.*leaf/);
    releaseRoot();
    const res = await startP;
    expect(launched).toEqual(['root', 'leaf']); // leaf ran only after root was released
    expect(res.content[0]!.text).toMatch(/status: done/);
    // An expansion runs under its OWN tool call ('a1'), but the DAG belongs to the origin's
    // WorkflowStart ('t6') — every snapshot must keep naming that row, or the extended workflow would
    // fork a second, phantom marker in the transcript.
    expect(snapshots.every((s) => s.toolCallId === 't6')).toBe(true);
  });

  it('lets a running node self-expand the workflow from its own subagent session', async () => {
    // A delegated node turn always runs as the anonymous `subagent:subagent` principal (no elowenUserId),
    // NOT the origin principal — so authorization for self-expansion must ride on childSessions membership,
    // not a principal match. This drives WorkflowAddNodes with exactly that node-child context.
    const tools = new Map<string, Tool>();
    const launched: string[] = [];
    const snapshots: { id: string }[] = [];
    let releaseRoot!: () => void;
    const rootGate = new Promise<void>((r) => { releaseRoot = r; });
    // Turn context the harness reports — flipped to the node-child identity for the add call.
    let sessionId = 'brain-parent';
    let identity: { elowenUserId?: number; platform: string; userId: string } = { elowenUserId: 1, platform: 'cli', userId: '1' };
    const run = async (_s: unknown, task: string, onEvent: (e: unknown) => void) => {
      launched.push(task);
      onEvent({ type: 'session', sessionId: `s-${task}` }); // registers the node's child session
      if (task === 'root') await rootGate;
      return `done:${task}`;
    };
    const ctx = {
      registerTool: (def: Tool) => { tools.set(def.name, def); },
      registerControl: () => {},
      logger: { info() {}, warn() {} },
      currentSessionId: () => sessionId,
      currentIdentity: () => identity,
      currentAccess: () => ({ toolPolicy: undefined }),
      currentModel: () => ({ provider: 'p', model: 'm' }),
      workflowEmitter: () => (u: { id: string }) => { snapshots.push(u); },
      listModels: async () => [],
      toolNames: () => ['Read'],
    };
    // Faithful principalOf (mirrors plugins/subagent/index.mjs): elowenUserId → elowen:N, else platform:userId.
    const principalOf = (id: { elowenUserId?: number; platform?: string; userId?: string } | null) =>
      id?.elowenUserId ? `elowen:${id.elowenUserId}` : (id?.platform && id?.userId ? `${id.platform}:${id.userId}` : null);
    registerWorkflow(ctx, () => run, {
      resolveDelegateTools: () => ({ allow: undefined }),
      principalOf,
      delegateContextChunks,
    });
    const startP = tools.get('WorkflowStart')!.execute('t7', { nodes: [{ id: 'root', task: 'root' }] });
    await new Promise((r) => setTimeout(r, 5));
    const wfId = snapshots[0]!.id;
    // Now the RUNNING node calls WorkflowAddNodes from its own subagent turn.
    sessionId = 's-root';
    identity = { platform: 'subagent', userId: 'subagent' };
    const added = await tools.get('WorkflowAddNodes')!.execute('a1', {
      workflowId: wfId,
      nodes: [{ id: 'leaf', task: 'leaf', deps: ['root'] }],
    });
    expect(added.content[0]!.text).toMatch(/Added 1 node.*leaf/);
    // A foreign subagent session (not part of this workflow) must still be refused.
    sessionId = 's-stranger';
    const denied = await tools.get('WorkflowAddNodes')!.execute('a2', { workflowId: wfId, nodes: [{ id: 'x', task: 'x' }] });
    expect(denied.content[0]!.text).toMatch(/no running workflow/);
    releaseRoot();
    const res = await startP;
    expect(launched).toEqual(['root', 'leaf']);
    expect(res.content[0]!.text).toMatch(/status: done/);
  });

  // The Esc-Esc bug: aborting the parent kills the RUNNING node children, but without a cancel the
  // engine relaunches every ready node the moment an aborted one settles — fresh children born after
  // the abort. The control is the host's seam to stop the DAG itself.
  it('cancelForSession halts the DAG: no post-abort launches, terminal status cancelled', async () => {
    const { tools, controls, snapshots, launched } = harness();
    let releaseRoot!: () => void;
    const rootGate = new Promise<void>((r) => { releaseRoot = r; });
    gate = { task: 'root', promise: rootGate };
    const startP = tools.get('WorkflowStart')!.execute('t-cancel', {
      nodes: [
        { id: 'root', task: 'root' },
        { id: 'leaf', task: 'leaf', deps: ['root'] },
      ],
    });
    await new Promise((r) => setTimeout(r, 5)); // root launches and parks on the gate
    // The host aborts: cancel the engine first (as abortLive does), then the running child errors out.
    expect(controls.get('workflow')!.cancelForSession({ sessionId: 'brain-parent' })).toEqual({ cancelled: 1 });
    releaseRoot();
    const res = await startP;
    await new Promise((r) => setTimeout(r, 5)); // let the aborted root settle its final snapshot
    expect(launched).toEqual(['root']); // leaf never launched after the cancel
    const text = res.content[0]!.text;
    expect(text).toMatch(/status: cancelled/);
    expect(text).toMatch(/workflow was cancelled/);
    expect(snapshots.at(-1)!.status).toBe('cancelled');
    // A different session's abort cancels nothing here.
    expect(controls.get('workflow')!.cancelForSession({ sessionId: 'someone-else' })).toEqual({ cancelled: 0 });
  });

  it('rejects an invalid DAG without launching anything', async () => {
    const { tools, launched } = harness();
    const res = await tools.get('WorkflowStart')!.execute('t5', {
      nodes: [{ id: 'a', task: 'a', deps: ['ghost'] }],
    });
    expect(res.content[0]!.text).toMatch(/Error:/);
    expect(launched).toEqual([]);
  });
});

// Regression: pruneWorkflows() only removed workflows finished more than an hour ago, while the start
// limit compared against the WHOLE map. Sixteen quickly-finished workflows locked the tool out for an
// hour with nothing actually in flight, and the error message falsely called them "running".
describe('workflow start limit', () => {
  const MAX_WORKFLOWS = 16;

  /** One node per workflow: `hold` parks on the shared gate until release(); anything else finishes
   *  immediately. `background: true` needs a completion sink to return without blocking on the parked
   *  node, exactly like the production host wiring. */
  function limitHarness() {
    const tools = new Map<string, Tool>();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const run = async (_s: unknown, task: string, onEvent: (e: unknown) => void) => {
      onEvent({ type: 'session', sessionId: `s-${task}` });
      if (task === 'hold') { await gate; return 'done:hold'; }
      return `done:${task}`;
    };
    const ctx = {
      registerTool: (def: Tool) => { tools.set(def.name, def); },
      registerControl: () => {},
      logger: { info() {}, warn() {} },
      currentSessionId: () => 'brain-parent',
      currentIdentity: () => ({ elowenUserId: 1, platform: 'cli', userId: '1' }),
      currentAccess: () => ({ toolPolicy: undefined }),
      currentModel: () => ({ provider: 'p', model: 'm' }),
      workflowEmitter: () => () => {},
      workflowCompletionEmitter: () => () => {},
      listModels: async () => [],
      toolNames: () => ['Read'],
    };
    registerWorkflow(ctx, () => run, {
      resolveDelegateTools: () => ({ allow: undefined }),
      principalOf: () => 'elowen:1',
      delegateContextChunks,
    });
    return { tools, release };
  }

  it('sixteen finished workflows do not block a seventeenth from starting', async () => {
    const { tools } = limitHarness();
    for (let i = 0; i < MAX_WORKFLOWS; i += 1) {
      const res = await tools.get('WorkflowStart')!.execute(`f${i}`, { nodes: [{ id: 'a', task: `quick${i}` }] });
      expect(res.content[0]!.text).toMatch(/status: done/);
    }
    const res17 = await tools.get('WorkflowStart')!.execute('f17', { nodes: [{ id: 'a', task: 'quick17' }] });
    expect(res17.content[0]!.text).toMatch(/status: done/);
    expect(res17.content[0]!.text).not.toMatch(/too many workflows/);
  });

  it('sixteen genuinely running workflows still block a seventeenth', async () => {
    const { tools, release } = limitHarness();
    const starts = [];
    for (let i = 0; i < MAX_WORKFLOWS; i += 1) {
      starts.push(tools.get('WorkflowStart')!.execute(`r${i}`, { background: true, nodes: [{ id: 'a', task: 'hold' }] }));
    }
    await Promise.all(starts); // background handle returns immediately; every node is parked, none finished
    const blocked = await tools.get('WorkflowStart')!.execute('r17', { nodes: [{ id: 'a', task: 'nope' }] });
    expect(blocked.content[0]!.text).toMatch(/too many workflows \(16\) are running; wait for one to finish\./);
    release();
    await new Promise((r) => setTimeout(r, 5)); // let the sixteen parked nodes settle before the test ends
  });
});

describe('workflow background + detach', () => {
  interface Completion { id: string; toolCallId: string; title?: string; status: string; result: string }
  interface Ctrl {
    cancelForSession(input: { sessionId: string }): { cancelled: number };
    detachForeground(input: { sessionId: string; principal: string }): { detached: number };
  }
  /** A harness whose single node parks until `release()` and then returns done — so a workflow can be
   *  observed while still running (to detach it) and after it finishes (to see delivery). Captures the
   *  durable completions the engine emits and the registered control. */
  function bgHarness() {
    const tools = new Map<string, Tool>();
    const controls = new Map<string, Ctrl>();
    const completions: Completion[] = [];
    const snapshots: { status: string; background?: boolean }[] = [];
    const launched: string[] = [];
    const finished: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const run = async (_s: unknown, task: string, onEvent: (e: unknown) => void) => {
      launched.push(task);
      onEvent({ type: 'session', sessionId: `s-${task}` });
      await gate;
      finished.push(task);
      return `done:${task}`;
    };
    const ctx = {
      registerTool: (def: Tool) => { tools.set(def.name, def); },
      registerControl: (name: string, control: Ctrl) => { controls.set(name, control); },
      logger: { info() {}, warn() {} },
      currentSessionId: () => 'brain-parent',
      currentIdentity: () => ({ elowenUserId: 1, platform: 'cli', userId: '1' }),
      currentAccess: () => ({ toolPolicy: undefined }),
      currentModel: () => ({ provider: 'p', model: 'm' }),
      workflowEmitter: () => (u: { status: string; background?: boolean }) => { snapshots.push(u); },
      workflowCompletionEmitter: () => (c: Completion) => { completions.push(c); },
      listModels: async () => [],
      toolNames: () => ['Read'],
    };
    registerWorkflow(ctx, () => run, {
      resolveDelegateTools: () => ({ allow: undefined }),
      principalOf: (id: { elowenUserId?: number } | null) => (id?.elowenUserId ? `elowen:${id.elowenUserId}` : null),
      delegateContextChunks,
    });
    return { tools, controls, completions, launched, finished, release, snapshots };
  }

  it('background=true returns a handle immediately and delivers the summary when the DAG finishes', async () => {
    const { tools, completions, finished, release } = bgHarness();
    const res = await tools.get('WorkflowStart')!.execute('bg1', { background: true, nodes: [{ id: 'a', task: 'a' }] });
    // Returned while the node is still parked — a handle, not a summary.
    expect(res.details).toMatchObject({ status: 'running' });
    expect(res.content[0]!.text).toMatch(/Started background workflow/);
    expect(completions).toEqual([]);
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(finished).toEqual(['a']);
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ toolCallId: 'bg1', status: 'done' });
    expect(completions[0]!.result).toContain('done:a');
  });

  it('Ctrl+B detach resolves the parent wait without aborting the running node, then delivers', async () => {
    const { tools, controls, completions, launched, finished, release } = bgHarness();
    const startP = tools.get('WorkflowStart')!.execute('fg1', { nodes: [{ id: 'a', task: 'a' }] });
    await new Promise((r) => setTimeout(r, 5)); // node launches and parks
    expect(launched).toEqual(['a']);
    // Exactly one workflow detaches; the node is NOT aborted — the run keeps going.
    expect(controls.get('workflow')!.detachForeground({ sessionId: 'brain-parent', principal: 'elowen:1' })).toEqual({ detached: 1 });
    expect(finished).toEqual([]);
    const res = await startP; // the parent's blocking wait was resolved by the detach
    expect(res.details).toMatchObject({ status: 'running', detached: true });
    expect(res.content[0]!.text).toMatch(/moved this workflow to the background/);
    expect(completions).toEqual([]); // still running
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(finished).toEqual(['a']); // the node ran to completion after the detach
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ toolCallId: 'fg1', status: 'done' });
    expect(completions[0]!.result).toContain('done:a');
  });

  // Ctrl+B tells the user the workflow keeps running, so a later abort in the SAME conversation must not
  // kill it — the host spares a detached delegate's children on this exact seam for the same reason. Any
  // unrelated Esc-Esc used to reach this loop and silently destroy the work.
  it('a parent abort spares a background workflow but still halts a foreground one', async () => {
    const { tools, controls, completions, finished, release } = bgHarness();
    const startP = tools.get('WorkflowStart')!.execute('bg-abort', { background: true, nodes: [{ id: 'a', task: 'a' }] });
    await startP;
    await new Promise((r) => setTimeout(r, 5));

    expect(controls.get('workflow')!.cancelForSession({ sessionId: 'brain-parent' })).toEqual({ cancelled: 0 });
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(finished).toEqual(['a']); // it ran to completion despite the abort
    expect(completions[0]).toMatchObject({ toolCallId: 'bg-abort', status: 'done' });
  });

  it('publishes `background` on the snapshot so the host can spare its nodes and the CLI can count', async () => {
    const { tools, controls, snapshots, release } = bgHarness();
    const startP = tools.get('WorkflowStart')!.execute('fg-flag', { nodes: [{ id: 'a', task: 'a' }] });
    await new Promise((r) => setTimeout(r, 5));
    expect(snapshots.at(-1)!.background).toBeUndefined(); // a blocking call is not background
    controls.get('workflow')!.detachForeground({ sessionId: 'brain-parent', principal: 'elowen:1' });
    await startP;
    expect(snapshots.at(-1)!.background).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 5));
  });

  it('does not re-detach an already-background workflow and ignores a foreign origin', async () => {
    const { tools, controls, release } = bgHarness();
    const startP = tools.get('WorkflowStart')!.execute('fg2', { nodes: [{ id: 'a', task: 'a' }] });
    await new Promise((r) => setTimeout(r, 5));
    // A different session or principal never detaches this workflow.
    expect(controls.get('workflow')!.detachForeground({ sessionId: 'someone-else', principal: 'elowen:1' })).toEqual({ detached: 0 });
    expect(controls.get('workflow')!.detachForeground({ sessionId: 'brain-parent', principal: 'elowen:2' })).toEqual({ detached: 0 });
    // The owner detaches it once…
    expect(controls.get('workflow')!.detachForeground({ sessionId: 'brain-parent', principal: 'elowen:1' })).toEqual({ detached: 1 });
    await startP;
    // …and a second Ctrl+B counts nothing, since it is already background.
    expect(controls.get('workflow')!.detachForeground({ sessionId: 'brain-parent', principal: 'elowen:1' })).toEqual({ detached: 0 });
    release();
    await new Promise((r) => setTimeout(r, 5));
  });
});

describe('WorkflowResume', () => {
  it('re-runs only the failed/pending nodes, leaves DONE nodes untouched, and frees their dependents', async () => {
    const { tools, launched, snapshots } = harness();
    const first = await tools.get('WorkflowStart')!.execute('r1', {
      nodes: [
        { id: 'a', task: 'a' },
        { id: 'b', task: 'b FAIL_ONCE', deps: ['a'] },
        { id: 'c', task: 'c', deps: ['b'] },
      ],
    });
    expect(first.content[0]!.text).toMatch(/status: error/);
    expect(launched).toEqual(['a', 'b FAIL_ONCE']); // c never ran — blocked by b's failure
    const wfId = snapshots[0]!.id;

    const resumed = await tools.get('WorkflowResume')!.execute('r1-resume', { workflowId: wfId });
    const text = resumed.content[0]!.text;
    expect(text).toMatch(/status: done/);
    expect(text).toContain('done:a'); // a's original result, carried forward unchanged
    expect(text).toContain('done:c'); // c finally ran, freed once b succeeded on retry
    // a must NOT be relaunched; b FAIL_ONCE runs exactly twice (its original failure + the retry); c once.
    expect(launched).toEqual(['a', 'b FAIL_ONCE', 'b FAIL_ONCE', 'c']);
  });

  it('puts a failed node back into its own session, and starts a never-launched one clean', async () => {
    const { tools, snapshots, runs } = harness();
    await tools.get('WorkflowStart')!.execute('r5', {
      nodes: [
        { id: 'a', task: 'a FAIL_ONCE' },
        { id: 'b', task: 'b', deps: ['a'] },
      ],
    });
    const wfId = snapshots[0]!.id;
    const firstA = runs.find((r) => r.task === 'a FAIL_ONCE')!;

    await tools.get('WorkflowResume')!.execute('r5-resume', { workflowId: wfId });

    // `a` ran and failed: it owns a session, so the retry reuses its channel — same conversation, its own
    // earlier work still visible — and is told to carry on rather than redo everything.
    const retryA = runs.filter((r) => r.task === 'a FAIL_ONCE')[1]!;
    expect(retryA.channelId).toBe(firstA.channelId);
    expect(retryA.fullTask).toContain('continue from where you stopped');

    // `b` never launched (blocked by a's failure), so it has no session to resume into: fresh channel, and
    // no resume note, which would be nonsense in an empty conversation.
    const runB = runs.find((r) => r.task === 'b')!;
    expect(runB.channelId).not.toBe(firstA.channelId);
    expect(runB.fullTask).toBe('b');
  });

  it('reports nothing to resume once every node has already finished', async () => {
    const { tools, snapshots } = harness();
    await tools.get('WorkflowStart')!.execute('r2', { nodes: [{ id: 'a', task: 'a' }] });
    const wfId = snapshots[0]!.id;

    const res = await tools.get('WorkflowResume')!.execute('r2-resume', { workflowId: wfId });
    expect(res.content[0]!.text).toMatch(/^Error: every node .* already finished/);
  });

  it('refuses to resume a workflow that is still running', async () => {
    const { tools, snapshots } = harness();
    let releaseA!: () => void;
    gate = { task: 'a', promise: new Promise<void>((r) => { releaseA = r; }) };
    const startP = tools.get('WorkflowStart')!.execute('r3', { nodes: [{ id: 'a', task: 'a' }] });
    await new Promise((r) => setTimeout(r, 5));
    const wfId = snapshots[0]!.id;

    const res = await tools.get('WorkflowResume')!.execute('r3-resume', { workflowId: wfId });
    expect(res.content[0]!.text).toMatch(/^Error: workflow .* still running/);
    releaseA();
    await startP;
  });

  // A node session is authorized for WorkflowAddNodes (self-expansion runs under the boundary the child
  // already holds), but resume relaunches nodes under the workflow's PARENT access — so a node given a
  // narrow toolset must not be able to resume siblings and reach work it cannot perform itself.
  it('refuses a resume from one of the workflow\'s own node sessions', async () => {
    const { tools, snapshots, sessionId } = harness();
    await tools.get('WorkflowStart')!.execute('sec1', {
      nodes: [{ id: 'a', task: 'a' }, { id: 'b', task: 'b FAIL', deps: ['a'] }],
    });
    const wfId = snapshots[0]!.id;

    sessionId.current = 's-a'; // the child session that ran node a
    const res = await tools.get('WorkflowResume')!.execute('sec1-resume', { workflowId: wfId });
    expect(res.content[0]!.text).toMatch(/^Error: no workflow/);
    expect(res.content[0]!.text).toMatch(/only be resumed from the conversation that started it/);
  });

  it('refuses an unknown workflow id, or one belonging to another conversation', async () => {
    const { tools } = harness();
    const res = await tools.get('WorkflowResume')!.execute('r4-resume', { workflowId: 'wf-does-not-exist' });
    expect(res.content[0]!.text).toMatch(/^Error: no workflow/);
  });
});
