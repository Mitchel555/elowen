---
title: "Slash Commands"
slug: slash-commands
order: 7
eyebrow: Everyday use
group: Everyday use
---

# Slash Commands

Slash commands are the fastest way to steer Elowen mid-conversation. They work the same on every surface — the [CLI](cli), the [web chat](web-ui), Discord, Telegram, WhatsApp, and Teams — because the menu is served by the daemon, not by each client. Add a command once and it shows up everywhere, always in sync.

Type `/` in any chat to browse the menu. It filters as you keep typing, so `/mod` narrows to `/model` before you finish the word.

## Chat control

| Command | Arguments | What it does | Surfaces |
| --- | --- | --- | --- |
| `/new` | — | Starts a fresh conversation in the current chat. | All |
| `/stop` | — | Aborts the running turn, including any delegated sub-agents and workflows it spawned. | All |
| `/status` | — | Shows the active model, context usage as a percentage, and token usage for the session. | All |
| `/help` | — | Lists the available commands. | All |
| `/compact` | `[steer text]` | Summarizes the conversation history to free up context. Optional steer text tells the summary what to keep. A friendly no-op when there is nothing to compact. | All |
| `/yolo` | `[on\|off]` | Toggles session-scoped auto-approve for tool calls. Deny rules still apply — yolo never overrides them. | CLI |

## Model and reasoning

| Command | Arguments | What it does | Surfaces |
| --- | --- | --- | --- |
| `/model` | `[name]` | Opens the model picker, or switches directly when you give a name — fuzzy matching accepted. | All |
| `/reasoning` | `[level\|show]` | Opens the reasoning-effort picker, or sets a level directly. `show` toggles Thought rows in the transcript. | CLI + channels |
| `/fast` | `[on\|off\|status]` | Toggles OpenAI OAuth priority processing for faster responses. | All |

## Sessions (CLI)

These manage saved conversations. They exist only in the CLI, where session switching lives.

| Command | Arguments | What it does |
| --- | --- | --- |
| `/sessions` | — | Opens the session picker. |
| `/resume` | `[N\|id]` | Resumes a session by list number or id. |
| `/rename` | `[title]` | Renames the current session. Without an argument, opens an inline modal. |
| `/delete` | `[N\|id]` | Deletes a session, with a two-step confirmation. |
| `/export` | `[html\|jsonl]` | Downloads the conversation to the directory the CLI was launched from. |
| `/quit` | — | Exits the CLI. |

## Modes and goals

| Command | Arguments | What it does | Surfaces |
| --- | --- | --- | --- |
| `/plan` | — | Switches to plan mode: read-only, with mutating tools hidden. | All |
| `/build` | — | Switches back to build mode. | All |
| `/workflow` | — | Switches to workflow mode, where work runs as a DAG of sub-agents. | All |
| `/goal` | `[text\|status\|pause\|resume\|clear\|draft]` | Manages a persistent multi-turn objective. `draft` previews the goal without activating it. | All |
| `/subgoal` | `<text>\|remove N\|clear` | Adds, removes, or clears sub-goals under the active goal. | All |
| `/tdd` | `[on\|off]` | Toggles the daemon-wide test-driven-development mission mode. | All (admin) |

## CLI environment

These tune the terminal client itself, so they exist only in the CLI. See [CLI Keybinds](cli-keybinds) for the keyboard side of the same surface.

| Command | Arguments | What it does |
| --- | --- | --- |
| `/cd` | `[path]` | Changes the working directory the agent operates in. |
| `/theme` | `[name]` | Switches the color theme. |
| `/keybinds` | — | Opens the keybinding reference. |
| `/statusline` | — | Configures the status line. |
| `/editor` | — | Composes the current message in `$VISUAL` or `$EDITOR`. |
| `/paste` | — | Attaches the clipboard image to the message. |
| `/stats` | — | Shows session statistics. |
| `/mcp` | — | Shows MCP server and tool health. |
| `/skills` | — | Lists loaded skills. |
| `/tools` | — | Lists tools contributed by plugins. |

## Admin

| Command | Arguments | What it does | Surfaces |
| --- | --- | --- | --- |
| `/lsp` | — | Shows language-server status. | CLI (admin) |
| `/restart` | — | Restarts the daemon. | All (admin) |

## Channel-only commands

A few commands are adapter-local: they configure how one channel behaves rather than the conversation itself.

| Command | Arguments | What it does | Surfaces |
| --- | --- | --- | --- |
| `/context` | — | Binds the channel to an existing conversation. This **moves** the conversation to the channel — it does not copy it. Operator-gated. | Channels |
| `/voice` | — | Toggles spoken replies via text-to-speech. | Discord, Telegram |
| `/display` | — | Sets per-channel display overrides. | Discord, Telegram, Teams |

## Plugin commands

[Plugins](plugins) can register their own slash commands. Each one is a prompt template: when you run it, the template expands and is sent as your message, with any arguments substituted into `$1`, `$2`, `$@`, or `$ARGUMENTS` placeholders.

Plugin commands appear in the `/` menu on every surface automatically — there is nothing extra to configure per channel.

> Exact command availability per channel — including channel-only commands and operator gates — is documented on each channel's own page. Start at [Channels](channels).

[Next: CLI Keybinds](cli-keybinds)
