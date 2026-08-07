// MCP bridge plugin: connect external Model Context Protocol servers (stdio / HTTP / SSE) and expose
// their tools as native brain tools. stdio servers are spawned in their OWN process group so cleanup
// can kill the entire group — reaping npx grandchildren that a plain child.kill() would orphan.
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { spawn } from 'node:child_process';

const ok = (text, details = {}) => ({ content: [{ type: 'text', text }], details: { ok: true, ...details } });
const fail = (e) => ok(`Error: ${e instanceof Error ? e.message : String(e)}`, {
  ok: false,
  error: { message: e instanceof Error ? e.message : String(e) },
});

const CONNECT_TIMEOUT_MS = 15_000; // default; overridable via config.connectTimeoutMs (global, all servers)
const CALL_TIMEOUT_MS = 120_000; // default; overridable via config.callTimeoutMs (global, all servers)

/** Read a numeric config override, clamped to [min, max]; falls back to `def` when unset/invalid. */
function configNumber(value, def, min, max) {
  return Math.min(Math.max(Number(value) || def, min), max);
}

const state = {
  ctx: null,
  specs: [],
  live: [],
  reconnecting: new Set(),
  servers: new Map(),
  /** serverName → the in-flight LAZY connect for it. Single-flight: two bridged tools of the same server
   *  called in the same turn must share ONE connect, or a first parallel call would launch two server
   *  process trees and leave one of them orphaned in `live`. Only ever populated in a sub-agent runner. */
  connecting: new Map(),
};

/** Whether an MCP error means the server simply doesn't implement the method (no `resources` capability),
 *  as opposed to a real failure (timeout, transport error) we must not swallow. JSON-RPC code -32601. */
function isMethodNotFound(e) {
  const code = e && typeof e === 'object' ? e.code : undefined;
  if (code === -32601 || code === -32602) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /method not found|not supported|not implemented|-32601/i.test(msg);
}

/** Sanitize a name fragment into a tool-name-safe token. */
const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'x';

/** Reject `promise` if it doesn't settle within `ms` (so one wedged server can't hang the whole reload). */
function withTimeout(promise, ms, label) {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); timer.unref?.(); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

/** SIGKILL a detached child's WHOLE process group (pgid === pid, because we spawned it detached), so an
 *  npx wrapper's real server grandchild dies with it. Falls back to a plain kill if the group is gone. */
function killTree(child) {
  if (!child || child.pid == null) return;
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

/** A minimal MCP stdio transport over a process WE spawned (detached, own group). Framing is the MCP
 *  stdio spec — one JSON-RPC message per line — reusing the SDK's ReadBuffer/serializeMessage so it stays
 *  byte-compatible with any server. We spawn ourselves (instead of StdioClientTransport) purely to own the
 *  process group for group-kill cleanup. */
class DetachedStdioTransport {
  constructor(child) { this.child = child; this._read = new ReadBuffer(); this._closed = false; }
  async start() {
    this.child.stdout.on('data', (chunk) => {
      this._read.append(chunk);
      try { let m; while ((m = this._read.readMessage()) !== null) this.onmessage?.(m); }
      catch (e) { this.onerror?.(e); }
    });
    this.child.stdout.on('error', (e) => this.onerror?.(e));
    this.child.on('error', (e) => this.onerror?.(e));
    this.child.on('exit', () => { if (!this._closed) { this._closed = true; this.onclose?.(); } });
  }
  async send(message) { this.child.stdin.write(serializeMessage(message)); }
  async close() { this._closed = true; killTree(this.child); this.onclose?.(); }
}

/** Build the client transport for a server spec. stdio spawns a detached child (own process group);
 *  http/sse connect to a remote URL. Returns `{ transport, child }` (child null for remote transports). */
function makeTransport(spec) {
  const kind = spec.transport ?? (spec.url ? 'http' : 'stdio');
  if (kind === 'http') return { transport: new StreamableHTTPClientTransport(new URL(spec.url)), child: null };
  if (kind === 'sse') return { transport: new SSEClientTransport(new URL(spec.url)), child: null };
  const env = { ...process.env, ...(spec.env ?? {}) };
  // detached:true → the child leads a new process group (pgid === child.pid); stderr inherited so a
  // server's own logs surface in the daemon journal.
  const child = spawn(spec.command, Array.isArray(spec.args) ? spec.args : [], { detached: true, env, stdio: ['pipe', 'pipe', 'inherit'] });
  return { transport: new DetachedStdioTransport(child), child };
}

function transportKind(spec) {
  return spec.transport ?? (spec.url ? 'http' : 'stdio');
}

function publicServerState(spec) {
  const entry = state.servers.get(spec.name) ?? {};
  return {
    name: spec.name,
    transport: transportKind(spec),
    status: entry.status ?? (spec.enabled ? 'disconnected' : 'disabled'),
    tools: entry.tools ?? [],
    toolCount: entry.toolCount ?? 0,
    lastError: entry.lastError ?? null,
    reconnecting: state.reconnecting.has(spec.name),
  };
}

function setServerState(name, patch) {
  const prev = state.servers.get(name) ?? {};
  state.servers.set(name, { ...prev, ...patch, updatedAt: new Date().toISOString() });
}

/** Image mime types the brain can embed inline as real image blocks (same set as the files plugin). */
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Map an MCP tool-call result into the brain tool-result shape. Image parts become REAL image blocks
 *  (so a vision model actually sees a screenshot, and history stripping can placeholder them later);
 *  anything else non-text collapses to a short placeholder — never a stringified base64 payload. */
function mapResult(res) {
  const parts = Array.isArray(res?.content) ? res.content : [];
  const content = parts.map((p) => {
    if (p?.type === 'text') return { type: 'text', text: String(p.text ?? '') };
    if (p?.type === 'image' && typeof p.data === 'string' && INLINE_IMAGE_TYPES.has(p.mimeType)) {
      return { type: 'image', data: p.data, mimeType: p.mimeType };
    }
    return { type: 'text', text: `[${typeof p?.type === 'string' ? p.type : 'unknown'} content omitted]` };
  });
  if (!content.length) content.push({ type: 'text', text: res?.isError ? 'MCP tool returned an error.' : '(no output)' });
  return { content, details: { ok: !res?.isError, isError: !!res?.isError } };
}

/** Register one remote MCP tool as a native brain tool (namespaced `mcp__<server>__<tool>`).
 *  Double separators on purpose: a sanitized server or tool name may itself contain `_`, so the old
 *  single-underscore form could not be split back apart unambiguously.
 *  NOTE: the `mcp__` prefix is the deferred-tool-loading contract — src/brain/toolSearch/deferralPolicy.ts
 *  (`MCP_TOOL_PREFIX`) keys deferral off exactly this literal. Keep the two in sync; a drift would silently
 *  stop ToolSearch from ever deferring MCP tools. A test guards the prefix (deferralPolicy.test.ts). */
/** `getClient` is resolved INSIDE execute, never at registration: a tool must be DECLARED to the model,
 *  but the server behind it only has to exist when the tool is CALLED. That asymmetry is what lets a
 *  forked sub-agent runner register the daemon's whole bridged tool set from a snapshot and connect
 *  nothing (see the `snapshot` branch in register()). */
function registerBridgedTool(ctx, getClient, serverName, tool) {
  const name = `mcp__${sanitize(serverName)}__${sanitize(tool.name)}`;
  const params = tool.inputSchema && typeof tool.inputSchema === 'object' ? Type.Unsafe(tool.inputSchema) : Type.Object({});
  ctx.registerTool(defineTool({
    name,
    label: tool.title || tool.name,
    description: `[${serverName}] ${tool.description ?? tool.name}`.slice(0, 1024),
    parameters: params,
    execute: async (_id, args) => {
      try {
        const callTimeoutMs = configNumber(ctx.config?.callTimeoutMs, CALL_TIMEOUT_MS, 30000, 300000);
        // A connect that fails here surfaces through the same `fail(e)` a call against a dead client
        // does — an error result the model can read, never a crash and never a silent empty answer.
        const client = await getClient();
        const res = await withTimeout(client.callTool({ name: tool.name, arguments: args ?? {} }), callTimeoutMs, `mcp call ${tool.name}`);
        return mapResult(res);
      } catch (e) { return fail(e); }
    },
  }));
}

/** Register bridged tools for several servers in ONE deterministic order. Tool order is part of the
 *  cached prompt prefix, so it must not depend on which server's listTools() answered first — collect
 *  from every server, sort by the final namespaced tool name (locale-independent), then register.
 *
 *  `resolveClient(serverName)` returns how THAT server's client is obtained at call time, or undefined to
 *  skip the server entirely. It is the ONE thing that differs between a connected load and a snapshot
 *  load — everything below (naming, sorting, registration) is shared, so the two cannot produce different
 *  tool lists. */
function registerBridgedTools(ctx, resolveClient, perServer) {
  const pairs = [];
  for (const { serverName, tools } of perServer) {
    const getClient = resolveClient(serverName);
    if (!getClient) continue;
    for (const tool of tools) pairs.push({ getClient, serverName, tool });
  }
  pairs.sort((a, b) => {
    const an = `mcp__${sanitize(a.serverName)}__${sanitize(a.tool.name)}`;
    const bn = `mcp__${sanitize(b.serverName)}__${sanitize(b.tool.name)}`;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  for (const p of pairs) registerBridgedTool(ctx, p.getClient, p.serverName, p.tool);
}

/** The ALREADY-CONNECTED resolver: bind the live client at registration, exactly as this plugin always
 *  did. A server that is not live is skipped, and a client that later dies stays bound and dead until the
 *  operator reconnects it — deliberately, because that is the daemon's existing behaviour and this change
 *  must not alter it. */
const connectedClient = (live) => (serverName) => {
  const client = live.find((e) => e.name === serverName)?.client;
  return client ? () => Promise.resolve(client) : undefined;
};

/** The LAZY resolver, used only when a snapshot was handed down: connect on the first call to one of this
 *  server's tools, and let every concurrent first call share that one connect. */
const lazyClient = (ctx, live) => (serverName) => () => connectLazily(ctx, serverName, live);

/** Connect `serverName` on demand, SINGLE-FLIGHT: concurrent callers share one promise, so two bridged
 *  tools of the same server called in parallel produce one connect and one server process, and every
 *  caller settles on that connect's own outcome.
 *
 *  It is what makes "one connect" true BY CONSTRUCTION rather than by an accident of timing. Today the
 *  `live.push` inside connectServer happens before its first await, so a second caller would find the
 *  entry anyway — but that is a property of where the awaits currently sit, not of the design, and the day
 *  connectServer gains an await before that push (a config read, a resolver, a lock) the accident stops
 *  holding and two servers get launched with nothing to notice it. */
function connectLazily(ctx, serverName, live) {
  // The IN-FLIGHT connect is consulted BEFORE `live`, because connectServer pushes its entry into `live`
  // synchronously and only then connects: between those two moments the entry exists but the connection
  // does not, and connectServer splices it back out if the connect fails. A caller reading `live` first
  // would therefore be handed a client that is mid-handshake — or one about to be abandoned, whose call
  // then waits out the full 120 s call timeout instead of failing with the connect's own error.
  const inflight = state.connecting.get(serverName);
  if (inflight) return inflight;
  const entry = live.find((e) => e.name === serverName);
  if (entry) return Promise.resolve(entry.client);
  const spec = state.specs.find((s) => s.name === serverName);
  if (!spec) return Promise.reject(new Error(`unknown MCP server "${serverName}"`));
  if (!spec.enabled) return Promise.reject(new Error(`MCP server "${serverName}" is disabled`));
  const pending = connectServer(ctx, spec, live).then(() => {
    const connected = live.find((e) => e.name === serverName);
    // connectServer pushes its entry into `live` before connecting and splices it out on failure, so a
    // fulfilled connect with nothing live means the transport closed between the two — treat it as the
    // failure it is rather than handing the caller an undefined client.
    if (!connected) throw new Error(`MCP server "${serverName}" closed immediately after connecting`);
    return connected.client;
  });
  state.connecting.set(serverName, pending);
  // Clear the slot once it settles, so a FAILED connect is retried on the next call instead of caching the
  // rejection forever. Guarded on identity: a later attempt may already own the slot by then.
  void pending.catch(() => {}).finally(() => {
    if (state.connecting.get(serverName) === pending) state.connecting.delete(serverName);
  });
  return pending;
}

/** Connect one server, list its tools, and bridge them. Errors propagate to the caller (per-server
 *  fail-open) — but a half-open connection is torn down first so a failed connect can't orphan a child. */
async function connectServer(ctx, spec, live) {
  setServerState(spec.name, { status: 'connecting', transport: transportKind(spec), lastError: null, tools: [], toolCount: 0 });
  const { transport, child } = makeTransport(spec);
  const client = new Client({ name: 'elowen-mcp-bridge', version: '0.1.1' }, { capabilities: {} });
  // `closing` suppresses the onclose transition below during OUR OWN deliberate teardown (reload/cleanup)
  // so a normal shutdown is never reported as a crash.
  const entry = { name: spec.name, client, transport, child, closing: false, lastTransportError: undefined };
  live.push(entry);
  const connectTimeoutMs = configNumber(ctx.config?.connectTimeoutMs, CONNECT_TIMEOUT_MS, 5000, 60000);
  try {
    await withTimeout(client.connect(transport), connectTimeoutMs, `mcp connect ${spec.name}`);
    // Page through the whole tool list — same pattern as the resource listing below. A server that
    // paginates would otherwise expose only its first page, and the status would report a wrong count.
    const tools = [];
    let cursor;
    do {
      const res = await withTimeout(client.listTools(cursor ? { cursor } : undefined), connectTimeoutMs, `mcp listTools ${spec.name}`);
      for (const tool of res?.tools ?? []) tools.push(tool);
      cursor = res?.nextCursor;
    } while (cursor);
    // Registration is deferred to connectAll/reconnect (see registerBridgedTools): registering here, as
    // each server answers, would make tool order follow connect latency — nondeterministic across restarts.
    setServerState(spec.name, {
      status: 'connected',
      transport: transportKind(spec),
      lastError: null,
      toolCount: tools.length,
      tools: tools.map((tool) => ({
        name: tool.name,
        title: tool.title ?? tool.name,
        description: tool.description ?? '',
        schema: tool.inputSchema ?? null,
      })),
      // The descriptors VERBATIM, beside the flattened `tools` above. The flattening is lossy for exactly
      // the fields registration reads (a tool with no description becomes '' there, which would bridge a
      // DIFFERENT description than this process did), so bridgeSnapshot() must not be built from it.
      bridged: tools,
    });
    ctx.logger?.info?.(`mcp: connected "${spec.name}" (${tools.length} tools)`);
    // Capture the last transport error (if any) so an unexpected close can report WHY, not just THAT.
    client.onerror = (err) => { entry.lastTransportError = err instanceof Error ? err.message : String(err); };
    // The dead-client bug: without this, a crashed stdio process or a dropped HTTP/SSE connection left
    // the state lying "connected" forever, tools kept failing against a dead client, and a manual
    // reconnect no-opped because the state still said "connected". `closing` is set by our own cleanup
    // right before it calls transport/client close, so that expected teardown never triggers this path.
    client.onclose = () => {
      if (entry.closing) return;
      const i = live.indexOf(entry);
      if (i >= 0) live.splice(i, 1);
      setServerState(spec.name, {
        status: 'disconnected',
        lastError: entry.lastTransportError ?? 'connection closed unexpectedly',
        toolCount: 0,
        tools: [],
        bridged: [],
      });
      ctx.logger?.warn?.(`mcp: "${spec.name}" disconnected unexpectedly`);
    };
    return tools;
  } catch (e) {
    const i = live.indexOf(entry);
    if (i >= 0) live.splice(i, 1);
    try { await transport.close?.(); } catch { /* ignore */ }
    killTree(child);
    setServerState(spec.name, { status: 'error', lastError: e instanceof Error ? e.message : String(e), toolCount: 0, tools: [], bridged: [] });
    throw e;
  }
}

/** Connect every enabled server in parallel, each bounded and fail-open. Tool registration is deferred
 *  until every server has answered (registerBridgedTools) so the resulting order is sorted by tool name
 *  rather than by response latency — tool order is part of the cached prompt prefix and must be stable
 *  across restarts. */
async function connectAll(ctx, specs, live) {
  const enabled = specs.filter((s) => s && s.enabled && s.name);
  const results = await Promise.allSettled(
    enabled.map((s) => connectServer(ctx, s, live).catch((e) => ctx.logger?.warn?.(`mcp: server "${s.name}" failed: ${e?.message ?? e}`))),
  );
  const perServer = [];
  enabled.forEach((s, i) => {
    const r = results[i];
    if (r.status === 'fulfilled' && Array.isArray(r.value)) perServer.push({ serverName: s.name, tools: r.value });
  });
  registerBridgedTools(ctx, connectedClient(live), perServer);
}

export async function register(ctx) {
  const specs = Array.isArray(ctx.config?.servers) ? ctx.config.servers : [];
  const live = []; // { name, client, transport, child }
  // Handed down by a process that has ALREADY connected these servers (the daemon → its sub-agent
  // runners). Its presence is the whole switch: with it we declare the same bridged tools and connect
  // nothing; without it — every daemon — we connect at boot exactly as before.
  const snapshot = Array.isArray(ctx.mcpBridgeSnapshot) ? ctx.mcpBridgeSnapshot : null;
  state.ctx = ctx;
  state.specs = specs.filter((s) => s && s.name);
  state.live = live;
  state.servers.clear();
  state.connecting.clear();
  for (const spec of state.specs) {
    setServerState(spec.name, { status: spec.enabled ? 'disconnected' : 'disabled', transport: transportKind(spec), lastError: null, tools: [], toolCount: 0 });
  }

  // Kill every spawned child (process group) on daemon exit — a last-resort net for non-systemd runs
  // (dev). Registered per load; removed by cleanup so reloads don't stack listeners.
  const onExit = () => { for (const c of live) killTree(c.child); };
  process.once('exit', onExit);

  // close() is async for HTTP/SSE transports (sync for stdio): capture the promises and await them all so
  // a rejected close becomes a caught, logged result — never an unhandled rejection — and a reload can't
  // overlap the previous remote transports still tearing down.
  const cleanup = async () => {
    // A lazy connect still in flight belongs to the load being torn down: forget it so the next load's
    // first call starts a fresh one instead of sharing a promise whose transport this cleanup is killing.
    state.connecting.clear();
    const closing = [];
    for (const c of live.splice(0)) {
      // Deliberate teardown, not a crash: suppress the onclose transition before triggering it.
      c.closing = true;
      try { const p = c.transport?.close?.(); if (p?.then) closing.push(p); } catch { /* ignore */ }
      killTree(c.child);
      try { const p = c.client?.close?.(); if (p?.then) closing.push(p); } catch { /* ignore */ }
    }
    await Promise.allSettled(closing);
    try { process.removeListener('exit', onExit); } catch { /* ignore */ }
  };

  // On plugin reload/disable/config-change the registry is rebuilt — tear down THIS load's servers first
  // so a config edit never orphans the previous process tree. Fires on the OLD registry before the swap.
  ctx.registerHook({ name: 'plugin.reload.before', run: async () => { await cleanup(); } });
  ctx.registerControl('mcp', {
    listServers: listMcpServers,
    bridgeSnapshot: mcpBridgeSnapshot,
    reconnectServer: reconnectMcpServer,
    reconnectDisconnected: reconnectMcpDisconnected,
  });

  if (snapshot) {
    // Same registration and same ordering as the connected path — only the client resolution differs.
    // Registering here rather than after the two resource tools below is deliberate: bridged tools come
    // FIRST in this plugin's registration order in the daemon, and that order is part of the cached
    // prompt prefix.
    registerBridgedTools(ctx, lazyClient(ctx, live), snapshot);
    const bridged = snapshot.reduce((n, s) => n + s.tools.length, 0);
    ctx.logger?.info?.(`mcp: declared ${bridged} bridged tool(s) from an inherited snapshot — servers connect on first use`);
  } else {
    // Connecting blocks register() (the loader awaits it) — bounded + fail-open per server above.
    await connectAll(ctx, specs, live);
  }

  /** Make sure the servers a RESOURCE call is about are live. Resources have no declaration to ride on —
   *  unlike a bridged tool, whose schema the snapshot carries, a resource list can only come from a
   *  connected server — so under a snapshot the naming of one (or the absence of a name, meaning "every
   *  connected server") is itself the request to connect. Fail-open and single-flight, like a tool call.
   *  A no-op without a snapshot: the daemon connected at boot, and a server that DIED there stays dead
   *  until an operator reconnects it, which is this plugin's existing behaviour. */
  const ensureResourceServers = async (serverName) => {
    if (!snapshot) return;
    const names = serverName
      ? [serverName]
      : state.specs.filter((s) => s.enabled).map((s) => s.name);
    await Promise.allSettled(names.map((n) => connectLazily(ctx, n, live)));
  };

  // ── MCP resource browsing tools ──────────────────────────────────────────────────────────────────
  // Let the model discover and read resources exposed by connected MCP servers (prompts, docs, data).
  ctx.registerTool(defineTool({
    name: 'ListMcpResources', label: 'List MCP resources',
    description: 'List available resources from connected MCP servers (optionally one server via `server`). Each resource has a server name, URI, name and description. Use ReadMcpResource to read a specific resource by its server and URI.',
    parameters: Type.Object({
      server: Type.Optional(Type.String({ description: 'Only list resources from this MCP server (by name).' })),
    }),
    execute: async (_id, p) => {
      await ensureResourceServers(p?.server);
      const targets = p?.server ? live.filter((e) => e.name === p.server) : live;
      if (p?.server && targets.length === 0) return fail(new Error(`MCP server "${p.server}" is not connected. Use ListMcpResources with no server to see connected servers.`));
      const results = [];
      const errors = [];
      for (const entry of targets) {
        try {
          // Page through the whole resource list — the SDK returns a `nextCursor` when there is more.
          let cursor;
          do {
            const res = await withTimeout(entry.client.listResources(cursor ? { cursor } : undefined), 10_000, `mcp listResources ${entry.name}`);
            for (const r of res?.resources ?? []) {
              results.push({ server: entry.name, uri: r.uri, name: r.name, description: r.description ?? '', mimeType: r.mimeType ?? '' });
            }
            cursor = res?.nextCursor;
          } while (cursor);
        } catch (e) {
          // A "method not found" just means the server exposes no resources — skip it quietly. A real
          // failure (timeout, transport error) is surfaced instead of being silently swallowed.
          if (isMethodNotFound(e)) continue;
          errors.push(`${entry.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (results.length === 0 && errors.length === 0) return ok('No MCP resources available. Either no servers are connected or they expose no resources.');
      const parts = [];
      if (results.length) parts.push(results.map((r) => `[${r.server}] ${r.name} (${r.uri})${r.description ? ` — ${r.description}` : ''}`).join('\n'));
      if (errors.length) parts.push(`Errors:\n${errors.map((e) => `- ${e}`).join('\n')}`);
      return ok(parts.join('\n\n'), { count: results.length, errors: errors.length });
    },
  }));

  ctx.registerTool(defineTool({
    name: 'ReadMcpResource', label: 'Read MCP resource',
    description: 'Read a specific resource from a connected MCP server by its server name and URI. Returns the resource content as text. Use ListMcpResources first to discover available resources.',
    parameters: Type.Object({
      server: Type.String({ description: 'Name of the MCP server to read from' }),
      uri: Type.String({ description: 'URI of the resource to read' }),
    }),
    execute: async (_id, p) => {
      await ensureResourceServers(p.server);
      const entry = live.find((e) => e.name === p.server);
      if (!entry) return fail(new Error(`MCP server "${p.server}" is not connected. Use ListMcpResources to see available servers.`));
      try {
        const result = await withTimeout(entry.client.readResource({ uri: p.uri }), 30_000, `mcp readResource ${p.uri}`);
        const parts = Array.isArray(result?.contents) ? result.contents : [];
        const text = parts.map((c) => {
          if (c?.text != null) return String(c.text);
          // `blob` is base64; its string length is ~4/3 the real size. Report the DECODED byte count.
          if (c?.blob != null) return `[binary content: ${c.mimeType ?? 'unknown'}, ${Buffer.from(String(c.blob), 'base64').length} bytes]`;
          return '[empty content]';
        }).join('\n\n');
        return ok(text || '(no content)', { server: p.server, uri: p.uri });
      } catch (e) { return fail(e); }
    },
  }));
}

// Exported for the process-cleanup test scenario (see tests/plugins/mcpPlugin.test.ts).
export function listMcpServers() {
  return state.specs.map(publicServerState);
}

/** The bridged tool DEFINITIONS this process currently holds — everything a forked sub-agent runner needs
 *  to declare the identical tools without connecting anything (see src/plugins/mcpSnapshot.ts for the
 *  field contract, which is exactly what registerBridgedTool reads).
 *
 *  Only CONNECTED servers contribute: the snapshot has to describe the tool set this process actually
 *  registered, and a server that failed to connect contributed none. Under a snapshot itself (a runner
 *  asked) the answer is empty — a runner forks nothing, so nobody asks. */
export function mcpBridgeSnapshot() {
  const out = [];
  for (const spec of state.specs) {
    const entry = state.servers.get(spec.name);
    if (entry?.status !== 'connected' || !Array.isArray(entry.bridged) || entry.bridged.length === 0) continue;
    out.push({
      serverName: spec.name,
      tools: entry.bridged.map((tool) => ({
        name: tool.name,
        ...(typeof tool.title === 'string' ? { title: tool.title } : {}),
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        ...(tool.inputSchema && typeof tool.inputSchema === 'object' ? { inputSchema: tool.inputSchema } : {}),
      })),
    });
  }
  return out;
}

export async function reconnectMcpServer(name) {
  const spec = state.specs.find((s) => s.name === name);
  if (!spec) throw new Error(`unknown MCP server "${name}"`);
  if (!spec.enabled) throw new Error(`MCP server "${name}" is disabled`);
  const current = state.servers.get(name);
  if (current?.status === 'connected') return publicServerState(spec);
  if (state.reconnecting.has(name)) return publicServerState(spec);
  if (!state.ctx) throw new Error('MCP plugin is not loaded');
  state.reconnecting.add(name);
  try {
    const tools = await connectServer(state.ctx, spec, state.live);
    // connectServer no longer registers (ordering lives in registerBridgedTools) — register here with the
    // same deterministic, name-sorted order as the initial load.
    if (tools.length) registerBridgedTools(state.ctx, connectedClient(state.live), [{ serverName: spec.name, tools }]);
    return publicServerState(spec);
  } finally {
    state.reconnecting.delete(name);
  }
}

export async function reconnectMcpDisconnected() {
  const targets = state.specs.filter((spec) => spec.enabled && ['disconnected', 'error'].includes(state.servers.get(spec.name)?.status ?? 'disconnected'));
  return Promise.allSettled(targets.map((spec) => reconnectMcpServer(spec.name))).then(() => listMcpServers());
}

export { killTree, DetachedStdioTransport, sanitize, mapResult, configNumber };
