// A minimal (low-level) MCP stdio server whose tools/list response is delayed by $LIST_TOOLS_DELAY_MS and
// whose tool set comes from $MOCK_TOOLS — used by tests/plugins/mcpPlugin.test.ts to prove the bridge's
// registration order is sorted by tool name, not by which server answers listTools first.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const delayMs = Math.max(0, Number(process.env.LIST_TOOLS_DELAY_MS) || 0);
const tools = (process.env.MOCK_TOOLS ?? 'alpha,beta').split(',').filter(Boolean);

const server = new Server({ name: 'mock-latency-mcp', version: '0.0.1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return { tools: tools.map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })) };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: 'text', text: `called ${request.params.name}` }],
}));

await server.connect(new StdioServerTransport());
