---
title: MCP Integration
slug: mcp
order: 25
eyebrow: Extending
group: Extending
---

# MCP Integration

MCP (Model Context Protocol) is an open standard for connecting AI agents to external tool servers. You can point Elowen at any MCP server — a GitHub server, a browser-automation server, a database server — and the agent gains that server's tools without any custom integration code.

## Connecting an external MCP server

This is the main task: you declare the server in a plugin's config using the `mcpServers` field. Open **Settings → Plugins**, find the plugin whose agent should get the tools, and add an entry with the server name, transport (a stdio command or a URL), and any environment variables it needs.

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

Save the config and the plugin reloads. From the next turn on, the server's tools are available to the agent. See [Plugins](plugins) for how plugin config works.

## The deferred-tool pattern

External MCP tools do not load their full definitions into every conversation. They appear **by name only** in a deferred-tools block. When the agent needs one, it calls `ToolSearch` with the tool's name or a keyword, the full parameter schema is fetched, and the tool becomes callable on its next turn.

This is normal — seeing the agent "search" for a tool before using it is the lazy-loading pattern working as designed. It keeps dozens of external tools available without bloating the context; only the tools actually needed get loaded.

```
ToolSearch({ query: "select:mcp__github__create_issue" })
// Next turn: mcp__github__create_issue is callable
```

## Example: GitHub MCP server

The GitHub config above gives the agent issue management, pull-request review, and repository tools. After saving, tools like `mcp__github__create_issue`, `mcp__github__list_issues`, and `mcp__github__get_pull_request` appear as deferred tools, and you can simply ask: "open an issue for the login bug" or "summarize the open PRs".

> The token in `env` is stored as plugin config. Use a fine-grained token scoped to the repositories the agent should touch.

## Elowen as an MCP server

The direction works the other way too: the daemon exposes a stateless MCP endpoint at `POST /mcp`, so external MCP-compatible clients can call Elowen's own tools. The details are developer material — see the API documentation shipped in the Elowen repository.

[Next: Configuration](configuration)
