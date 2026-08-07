/** THE BRIDGED-MCP-TOOL SNAPSHOT: what a forked sub-agent runner needs in order to DECLARE the daemon's
 *  bridged MCP tools without connecting a single MCP server at boot.
 *
 *  The asymmetry this rests on: a tool must be declared to the model, but the server behind it only has to
 *  exist when the tool is CALLED. `registerBridgedTool` (plugins/mcp/index.mjs) reads exactly the four
 *  fields below at registration time and touches the client only inside `execute`, so the daemon — which
 *  connected at boot and therefore already holds them — can hand them to a runner over IPC and let the
 *  runner connect lazily, on the first call, or never.
 *
 *  THE FIELD SET IS A CONTRACT with `registerBridgedTool`: it is the whole of what registration reads
 *  (name → the namespaced tool name, title → the label, description → the prefixed description,
 *  inputSchema → the parameters). A field added there and not carried here would make a runner-composed
 *  tool list differ from the daemon's — which is drift in the prompt-cache key, and silent. The MCP parity
 *  harness (scripts/tests/subagent-parity, `--check` against baseline-mcp*.json) is what catches that: its
 *  fixture tools carry all four. */

/** One bridged MCP tool, as its server reported it in `tools/list`. */
interface McpBridgedTool {
  name: string;
  title?: string;
  description?: string;
  /** The tool's JSON Schema, carried VERBATIM — it is handed to the model as the parameter schema, so any
   *  normalisation here would be drift. */
  inputSchema?: Record<string, unknown>;
}

/** The tools of ONE connected server, under the name the bridged tool names are derived from. */
interface McpBridgedServer {
  serverName: string;
  tools: McpBridgedTool[];
}

/** Every connected server's bridged tools, as the daemon currently holds them. An EMPTY array is a real
 *  answer ("the daemon bridges nothing"); `undefined` means the daemon could not say, and a runner that
 *  gets no snapshot connects at boot exactly as it always did. */
export type McpBridgeSnapshot = McpBridgedServer[];

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const record = (v: unknown): Record<string, unknown> | undefined =>
  (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

function parseTool(raw: unknown): McpBridgedTool | undefined {
  const v = record(raw);
  const name = str(v?.name);
  if (!v || !name) return undefined;
  const title = str(v.title);
  const description = str(v.description);
  const inputSchema = record(v.inputSchema);
  return {
    name,
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(inputSchema ? { inputSchema } : {}),
  };
}

/** Parse a snapshot off the wire. Same rule as the rest of the runner protocol: a malformed frame is
 *  REFUSED rather than coerced — a half-parsed snapshot would register a half tool set, which is exactly
 *  the silent prompt drift this whole path is built to avoid. A single bad entry rejects the lot. */
export function parseMcpBridgeSnapshot(raw: unknown): McpBridgeSnapshot | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: McpBridgeSnapshot = [];
  for (const entry of raw) {
    const v = record(entry);
    const serverName = str(v?.serverName);
    if (!v || !serverName || !Array.isArray(v.tools)) return undefined;
    const tools: McpBridgedTool[] = [];
    for (const t of v.tools) {
      const tool = parseTool(t);
      if (!tool) return undefined;
      tools.push(tool);
    }
    out.push({ serverName, tools });
  }
  return out;
}
