// A minimal (low-level) MCP stdio server that paginates `tools/list` across two pages, used by
// tests/plugins/mcpPlugin.test.ts to prove the bridge follows the cursor instead of stopping at the
// first page. Three tools total: two on page one, one on page two.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const TOOLS = [
  { name: 'tool_a', description: 'First tool', inputSchema: { type: 'object', properties: {} } },
  { name: 'tool_b', description: 'Second tool', inputSchema: { type: 'object', properties: {} } },
  { name: 'tool_c', description: 'Third tool', inputSchema: { type: 'object', properties: {} } },
];

const server = new Server({ name: 'mock-paginated-mcp', version: '0.0.1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  const cursor = request.params?.cursor;
  if (!cursor) return { tools: [TOOLS[0], TOOLS[1]], nextCursor: 'page2' };
  if (cursor === 'page2') return { tools: [TOOLS[2]] };
  return { tools: [] };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: 'text', text: `called ${request.params.name}` }],
}));

await server.connect(new StdioServerTransport());
