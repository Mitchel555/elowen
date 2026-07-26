---
title: Plugin Development
slug: plugin-dev
order: 20
eyebrow: Extend Elowen
group: Extending
---

# Plugin Development

This page is for writing a plugin from scratch. For enabling, configuring, and managing existing plugins, see [Plugins](plugins). A plugin is a self-contained ESM folder that contributes tools, skills, hooks, webhooks, prompt fragments, or platform adapters through a scoped context object. The loader discovers manifests, validates them, imports only enabled plugins, and merges each registration only after it completes successfully — a broken plugin is skipped without affecting the rest.

## Minimal structure

```text
plugins/my-plugin/
├── elowen-plugin.json   # manifest (required)
├── index.mjs            # entry point (required)
├── icon.svg             # optional icon
└── i18n/
    └── cs.json          # optional translations
```

The folder name must match the manifest `name` field. The entry file must stay inside the folder.

## Manifest

`elowen-plugin.json` is declarative metadata the loader reads before importing anything:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "apiVersion": "1",
  "description": "Adds a small example tool.",
  "entry": "index.mjs",
  "provides": { "tools": ["MyTool"] },
  "icons": { "MyTool": "sparkles" },
  "configSchema": [
    { "key": "greeting", "label": "Greeting", "type": "string", "default": "Hello" }
  ]
}
```

| Field | Purpose |
|---|---|
| `name` | Unique id, must equal the folder name. |
| `version` | Semver string for display and update checks. |
| `apiVersion` | Plugin API version; currently `"1"`. |
| `description` | One-line summary shown in Settings. |
| `entry` | Relative path to the ESM entry point. |
| `provides` | Declares contributions: `tools`, `skills`, `httpRoutes`, `platforms`. |
| `icons` | Maps tool names to lucide icon identifiers. |
| `showOutput` | Tool names whose results render inline in chat. |
| `planSafe` | Tool names safe for plan-mode (read-only) execution. |
| `configSchema` | Array of config field definitions (see below). |
| `capabilities` | Opt-in capabilities beyond the default sandbox. |

## Config schema fields

Each entry in `configSchema` renders as a form control in Settings. Supported `type` values:

| Type | Renders as |
|---|---|
| `string` | Text input |
| `secret` | Masked input (stored encrypted) |
| `boolean` | Toggle switch |
| `number` | Numeric input |
| `textarea` | Multi-line text area |
| `enum` | Dropdown from `options` array |
| `multiSelect` | Multi-checkbox from `options` |
| `code` | Code editor with syntax highlighting |
| `prompt` | Prompt template editor |
| `json` | JSON editor with validation |
| `model` | Model picker (from configured providers) |
| `provider` | Provider picker |
| `embeddingModel` | Embedding model picker |
| `mcpServers` | MCP server list editor |
| `rolePolicies` | Role-policy matrix editor |
| `section` | Visual section header (no value) |

Common optional keys: `default`, `hint`, `placeholder`, `required`, `options` (for enum/multiSelect).

## Entry point

The entry module exports a single `register(ctx)` function. The context object is your only interface to the runtime:

```js
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const text = (v) => ({ content: [{ type: 'text', text: v }], details: {} });

export function register(ctx) {
  ctx.registerTool(defineTool({
    name: 'MyTool',
    label: 'Example tool',
    description: 'Returns the supplied text.',
    parameters: Type.Object({
      value: Type.String({ description: 'Text to return.' }),
    }),
    execute: async (_callId, params) => text(params.value),
  }));
}
```

Parameters use TypeBox schemas, giving you runtime validation and automatic JSON Schema generation for the model.

### Tool naming

Use TitleCase with a family prefix that groups related tools: `GithubListIssues`, `GithubCreatePr`, `SarahHairBooking`. Names are durable — they appear in permission rules and conversation history, so choose them carefully and do not rename casually.

### planSafe tools

A tool listed in `planSafe` may run during read-only planning. To qualify:

- Use the exact tool name from the manifest — no wildcards.
- The tool must not change anything outside the current conversation (no writes, no side effects, no network mutations).

## Context API

The `ctx` object passed to `register` exposes these registration methods and utilities:

| Method / property | Purpose |
|---|---|
| `registerTool(tool)` | Register a tool the brain can call. |
| `registerSkill(skill)` | Register a reusable skill (markdown instructions). |
| `registerPlatform(adapter)` | Register a chat platform adapter. |
| `registerHttpRoute(route)` | Register an inbound HTTP route (webhook). |
| `registerCommand(cmd)` | Register a `/slash` command. |
| `registerSystemPromptFragment(fn)` | Inject dynamic text into the system prompt. |
| `registerTurnContext(fn)` | Inject per-turn context (e.g. current date). |
| `registerHook(hook)` | Register a lifecycle hook (see Capabilities). |
| `registerControl(ctrl)` | Register a Settings UI control. |
| `dataDir` | Absolute path to the plugin's persistent data directory. |
| `assertPathAllowed(path)` | Validate a path is within accessible repositories. |
| `embeddings` | Shared embedding client (see below). |
| `config` | Resolved config values from `configSchema`. |

## Capabilities

Plugins run in a deny-by-default sandbox. To use privileged features, declare them in the manifest `capabilities` array:

| Capability | Grants |
|---|---|
| `hooks` | Lifecycle hooks (message received, tool called, turn ended). |
| `mutates` | Permission to write files or change state outside the conversation. |
| `reads` | Permission to read files from accessible repositories. |
| `network` | Permission to make outbound HTTP requests. |

Without the corresponding capability, the runtime blocks the operation and logs a warning.

## Shared embeddings

`ctx.embeddings` gives access to the instance's configured embedding model. Use it for semantic search or similarity within your plugin without requiring users to configure a second model. It returns `null` when no embedding model is configured — handle that gracefully.

## HTTP routes (webhooks)

Declare routes in `provides.httpRoutes` and register handlers with `ctx.registerHttpRoute`. Routes mount at `/hooks/<plugin-name>/<path>`. Your handler owns authentication entirely — the daemon does not add auth middleware to plugin routes.

```json
"provides": { "httpRoutes": [{ "path": "callback", "method": "POST" }] }
```

```js
ctx.registerHttpRoute({
  path: 'callback',
  method: 'POST',
  handler: async (req, res) => {
    // validate req.headers['x-signature'] yourself
    res.json({ ok: true });
  },
});
```

## Platform adapters

A plugin can register a full chat platform (Discord, Telegram, Teams, WhatsApp) via `ctx.registerPlatform`. Adapters reuse shared modules from `plugins/_shared/` for message formatting, threading, and media handling. For details on configuring existing platform plugins, see [Channels](channels) and the individual platform pages: [Discord](channels-discord), [Telegram](channels-telegram), [Teams](channels-teams), [WhatsApp](channels-whatsapp).

## Loading and testing

The loader imports your entry point only when the plugin is enabled in Settings. A registration that throws is caught and skipped — check the daemon log for the error. During development, toggle the plugin off and on in Settings to reload it without restarting the daemon. There is no separate test harness; exercise your tools through a brain conversation or by calling the daemon API directly.

> Keep the entry point fast. Registration runs synchronously during startup — defer heavy work (network calls, database connections) to first use, not to `register`.

[Next: MCP Integration](mcp)
