---
title: Configuration
slug: configuration
order: 26
eyebrow: Administration
group: Administration
---

# Configuration

Elowen keeps startup configuration separate from runtime settings. Environment variables establish the local process boundary; the Settings workspace persists operational choices and saves normal changes as you make them. Secrets are never returned to the browser after storage.

![Settings workspace](images/settings-overview.png)

## Startup environment

Set environment variables before starting the relevant process; the defaults are intentionally local-first. The full variable table — daemon port and bind address, database path, bootstrap credentials, logging, and the CLI client variables — lives in [Production & Updates](production-updates).

`elowen setup` is the preferred way to configure a local installation. Use `elowen doctor` to check the resulting daemon, provider, memory, and task readiness.

## Settings sections

The Settings surface follows one stable order. It is administrator-controlled; user-level preferences and access live under Account and Users.

| Section | What it controls |
| --- | --- |
| **System** | Version/readiness, service controls, automatic updates, and login-token lifetime. |
| **Elowen AI** | Agent name, provider accounts, model context windows, max steps, runtime limits, and stale-conversation auto-cleanup. |
| **Models** | Enabled executor presets, custom entries, and model notes for planning. |
| **CLI Agents** | External coding CLI binary, arguments, permission behavior, and resume behavior. |
| **Data** | Explicit administrative maintenance and destructive cleanup. |
| **GitHub** | Write-only credentials and PR-workflow defaults. |
| **Autopilot** | Mission defaults, planning/review roles, TDD mode, and PR defaults. |
| **Plugins** | Installed capabilities, marketplace, and plugin-owned configuration. |
| **Memory** | Embedding and categorization models. |

## Elowen AI and limits

Elowen AI providers can be OpenAI-compatible or Anthropic API-key entries, or supported OAuth accounts. The Web UI shows provider/model metadata and whether a secret exists; it never reads a stored API key back into the client.

The same section contains guarded runtime limits for tool-output display, elicitation waits, memory recall, autonomous goals, and live channel sessions. Values are validated and clamped by the daemon, so a stale or malformed client cannot persist an unsafe bound.

### OAuth subscription usage

Each connected OAuth provider — Anthropic, GitHub Copilot, OpenAI Codex, and Kimi — gets a slim usage rail next to its account entry. The rail shows the fill of every usage window the provider exposes (typically the 5-hour and weekly windows) and shifts color as pressure builds: normal, warning at 70%, and danger at 90%. Hover a rail for a tooltip with the window's reset time.

Watch these rails before launching a long autonomous run. A provider at warning pressure can rate-limit the brain mid-task; pick a different model or wait for the reset.

### Brain limits

The limits modal in Elowen AI exposes the eight runtime knobs that bound a single brain turn. Every value is clamped to a safe range, both in the form and again by the daemon.

| Limit | What it bounds |
| --- | --- |
| Tool output max lines | How many lines of a tool result the brain sees before truncation. |
| Tool output max chars | Character cap on the same tool output, applied alongside the line cap. |
| Elicitation timeout | How long the brain waits for an answer to a question it asks you. |
| Memory recall count | How many memories are recalled into a turn's context. |
| Memory recall chars | Character budget for the recalled memory block. |
| Goal turn budget | Total turns an autonomous goal may spend before stopping. |
| Goal max turns | Hard ceiling on turns for a single goal step. |
| Channel session cap | How many live agent sessions one channel may hold at once. |

## Models and CLI agents

**Models** is the workspace catalog for task executors. It controls which known presets are visible, custom model entries, and notes that help planning select a suitable executor. Per-user allowed executors only narrow this workspace-wide ceiling.

![Model catalog](images/settings-models.png)

**CLI Agents** configures the external programs Elowen can spawn. For each configured program, adjust the executable, arguments, permission behavior, and whether a restarted task should resume the prior external session. The embedded Elowen brain is configured in **Elowen AI**, not as an external binary.

## Autopilot and GitHub

Autopilot holds mission-wide defaults: worker executor, autonomy, maximum concurrent sessions, planner/overseer choices, optional completion review, TDD mode, and PR behavior. A new mission can override its pilot and overseer without changing the global setting.

GitHub settings keep credentials write-only and define the PR workflow defaults: enabled state, base branch, auto-open behavior, and an optional verification command. Project and mission settings can override the PR enabled state. See [Projects & Workflow](projects-workflow).

## Plugins and Memory

Plugins render their own config from `elowen-plugin.json`; use their documentation and help affordances for specialized fields. The Memory section chooses the embedding and categorization models. API-key and OpenAI-compatible providers can supply those credentials without duplication; OAuth-only accounts cannot, because they do not expose an embedding endpoint.

Leaving embeddings unconfigured keeps memory usable with keyword retrieval. Reindexing or recategorizing performs a deliberate background operation; it is not a hidden side effect of changing the visual UI.

## Plugin editors: subagents and skills

Under **Plugins**, the subagent and skills plugins each ship a full editor so you can create, edit, and delete entries without touching the filesystem.

The **subagents editor** manages custom sub-agents. Each entry is a Markdown file: frontmatter declares the name, description, and tools mode — read-only, all, inherit, or an explicit custom tool list — and the body is the prompt the sub-agent runs with. The built-in explore and plan agents are read-only; you can inspect them but not modify them. Changes hot-reload, so a saved sub-agent is available to the next delegation immediately.

The **skills editor** follows the same pattern for skills: a Markdown body with frontmatter, listed and editable in place. See [Skills](skills) for how skills are discovered and applied.

## LSP diagnostics

Elowen can run language-server diagnostics after file edits, surfacing live type and lint errors in the session. It is on by default. The `/lsp` command in the CLI toggles it, and the choice persists across restarts. See [Slash Commands](slash-commands) for the command syntax.

## Accounts and permissions

Account preferences are personal. Users and their project/model/tool access are managed separately. A setting being visible does not override the daemon's authorization checks; permissions and destructive actions retain confirmation boundaries.

[Next: Users & Access](users-access)
