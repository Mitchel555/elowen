---
title: MCP Integration
slug: mcp
order: 21
eyebrow: Extend Elowen
group: Extending
---

# MCP Integration

MCP (Model Context Protocol) is an open standard for connecting AI agents to external tool servers. Elowen participates on both sides: it exposes its own tools as an MCP server, and it can consume tools from external MCP servers you connect.

## Elowen as an MCP server

The Elowen daemon exposes a stateless MCP endpoint at `POST /mcp`. Any MCP-compatible client can connect and call Elowen's tools — file operations, search, shell commands, and more — using standard MCP transport.

This lets you wire Elowen into other AI tooling or automation pipelines that speak MCP, without building custom integrations.

## Connecting external MCP servers

To give the agent access to tools from an external MCP server, declare it in a plugin's config using the `mcpServers` field type. Each entry specifies the server name, transport (stdio command or URL), and any required environment variables.

Once configured, the external server's tools become available to the agent as **deferred tools** — advertised by name only, without loading their full schemas into context on every turn.

## The deferred-tool pattern

External MCP tools follow a lazy-loading pattern to keep the system prompt lean:

1. Tool names and short descriptions appear in an `available_tools_deferred` block.
2. When the agent needs one, it calls `ToolSearch` with a query (by name, keyword, or `select:tool_name`).
3. The matching tool's full parameter schema is fetched and activated.
4. The tool becomes callable on the agent's next turn.

This means dozens of external tools can be available without bloating context — only the ones actually needed get loaded.

```
ToolSearch({ query: "select:mcp__github__create_issue" })
// Next turn: mcp__github__create_issue is callable
```

## Resource access

Beyond tools, MCP servers can expose **resources** — structured data the agent can read. Two built-in tools handle this:

| Tool | Purpose |
|------|---------|
| `ListMcpResources` | Discover resources from connected servers (optionally filtered by server name) |
| `ReadMcpResource` | Read a specific resource by server name and URI |

Use `ListMcpResources` first to see what is available, then `ReadMcpResource` to fetch content.

## Practical example: GitHub MCP server

Connect a GitHub MCP server to give the agent issue management, PR review, and repository tools:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    }
  }
}
```

After restarting the plugin, tools like `mcp__github__create_issue`, `mcp__github__list_issues`, and `mcp__github__get_pull_request` appear as deferred tools. The agent fetches and calls them on demand.

## Practical example: Chrome DevTools

A Chrome DevTools MCP server gives the agent browser automation — navigation, screenshots, network inspection, performance tracing:

```json
{
  "mcpServers": {
    "chrome_devtools": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-chrome-devtools"]
    }
  }
}
```

The agent can then take screenshots, evaluate scripts in-page, inspect network requests, and run Lighthouse audits — all through the deferred-tool pattern.

MCP servers are configured within the plugin system. See [Plugins](plugins) for how plugin config works, and [Plugin Development](plugin-dev) for building your own.

[Next: Scheduling](scheduling)
