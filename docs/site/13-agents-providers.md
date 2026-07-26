---
title: Agents & Providers
slug: agents-providers
order: 13
eyebrow: Automation
group: Automation
---

# Agents & Providers

Elowen is a personal AI agent you talk to — it reasons, calls tools, edits files
and runs commands on your behalf. When a job is big enough to warrant its own
coding agent, Elowen spawns one for you: a real CLI coding assistant working
inside a live session you can watch. This page explains what those agents are,
which providers Elowen can drive, and how you configure them — so picking an
agent for a task is a choice you make, not a mystery.

## What an executor is

An **executor** (also called a worker or agent) is the program that actually
carries out a task. When you hand Elowen a job — from a task, a mission, or a
scheduled run — the daemon spawns an executor inside a tmux session, feeds it
the brief, and watches its terminal until the work is done. Every executor runs
at an [autonomy level](autonomy-safety) you control, and everything it does is
visible in the [Web UI](web-ui).

There are two kinds of executor:

- **External CLI agents** — coding assistants like Claude Code or Codex that
  Elowen spawns as real processes. Each one needs its own CLI installed and
  authenticated on the machine.
- **The embedded Elowen AI brain** — the agent you chat with directly. It runs
  in-process, spawns nothing external, and can also act as a worker for tasks.
  See [Brain & Chat](brain-chat).

You pick the executor per task; the model picker in chat and task creation
offers whatever you are allowed to run.

## Providers

Elowen can drive four external coding-agent CLIs, plus the embedded brain.

| Provider | Exec prefix | Program | Notes |
|----------|-------------|---------|-------|
| Claude Code | `claude:` | `claude-code` | Default; bare specs like `sonnet` route here |
| OpenCode | `opencode:` | `opencode` | Also the target for bare `provider/model` specs |
| Codex | `codex:` | `codex` | OpenAI's agentic coder |
| Kilo Code | `kilo:` | `kilo` | Auto-approval lives in Kilo's own config (see below) |
| Elowen AI (brain) | `elowen:` | `elowen` | Embedded — runs in-process, no external CLI spawned |

The brain uses `elowen:<provider>/<model>` specs (for example
`elowen:relay/ollama/kimi-k2.7-code`) and is bounded by your configured brain
providers rather than the CLI allow-list. An enabled Elowen AI model can also be
your per-user **Default worker** (see [Account & Preferences](account-preferences)),
so tasks with no explicit executor run in the embedded brain.

### Adding a provider

To make an external provider available, install its CLI on the machine, sign it
in (API key or OAuth, whichever the CLI itself uses), and allow its exec specs
in Elowen's configuration. Brain providers are configured in **Settings →
Models & CLI agents** — this is where you add API keys, connect OAuth accounts,
and set custom base URLs for the models the brain and the overseer use. Once a
provider is enabled, its models appear in the pickers automatically. See
[Configuration](configuration) for the full setup.

### Picking a model

Wherever you create work — the chat composer, the task form, a mission — a
model picker lists every executor you may run. Pick one explicitly, or leave
the default and Elowen routes the task to the configured fallback. Per-user
restrictions still apply, so two users can see different pickers on the same
instance.

## Executor resolution

Every task carries an `exec:<spec>` label that tells Elowen which agent to
spawn. The daemon resolves the spec to a program like this:

- `exec:sonnet` → Claude Code with model `sonnet`
- `exec:opus` → Claude Code with model `opus`
- `exec:opencode:deepseek-v4-flash` → OpenCode with model `deepseek-v4-flash`
- `exec:codex:gpt-5.5` → Codex with model `gpt-5.5`
- `exec:kilo:<model>` → Kilo Code with that model
- `exec:ollama/deepseek-v4-flash` → a bare spec containing `/` routes to OpenCode
- **No label** → the configured fallback (default: Claude Code / `sonnet`)

A bare plain string (no prefix, no `/`) is only valid when it is explicitly
allow-listed — otherwise Elowen would silently treat it as a Claude Code model
name, so it is rejected.

Every exec must be in the daemon's allow-list or the API rejects the task. On
top of that, non-admin users can be scoped to a **personal subset** of execs —
an admin can let one user run Opus and Codex while another is limited to a cheap
OpenCode model. See [Users & Access](users-access) for per-user exec
permissions.

## Provider configuration

Configure each external provider in **Settings → Models & CLI agents**:

- **Binary path** — override where the CLI binary lives
- **Extra args** — additional flags passed on every spawn
- **Skip permissions** — bypass the CLI's own approval prompts (for example
  `--dangerously-skip-permissions` for Claude Code)
- **Resume sessions** — when enabled, a respawned agent reattaches to its prior
  CLI conversation instead of cold-starting (see
  [Session resume](autonomy-safety))

> **Kilo Code gotcha:** Kilo's skip-permissions toggle in Providers is a no-op.
> Kilo's auto-approval is controlled inside Kilo's own configuration, not by an
> Elowen flag — set it there.

For how Elowen supervises these agents once they are running — autonomy levels,
the overseer, and the safety nets — continue to the next page.

[Next: Autonomy & Safety](autonomy-safety)
