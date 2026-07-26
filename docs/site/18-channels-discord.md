---
title: Discord
slug: channels-discord
order: 19
eyebrow: Channels
group: Channels
---

# Discord

A Discord bot answers in your server, with each Discord role mapped to an Elowen project scope and policy.

For what every channel shares — reactions, reasoning, service language, and the security model — see [Channels](channels).

## Setup

1. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications) → Bot → **Reset Token**. Copy the token.
2. Under **Privileged Gateway Intents**, enable **Message Content Intent** (required for the bot to read messages).
3. Invite the bot to your server with the `bot` and `applications.commands` scopes.
4. In Elowen: **Settings → Plugins → Discord** → paste the bot token.
5. Map at least one Discord role to an Elowen policy (see below).

## Role policies

Each Discord role maps to an Elowen project scope and an optional role prompt. First matching role wins; users with no mapped role are ignored. A policy can also restrict which tools the bot may use for that role.

Configure in **Settings → Plugins → Discord → Role policies**:

- **Discord role ID** — the role to match
- **Elowen projects** — which projects this role can act in
- **Role prompt** — system-level instructions scoped to this role
- **Admin** — grants access to server tools (channel management, member search, etc.)
- **Allowed tools** — optional allow-list narrowing the bot's toolset for this role

## Slash commands

| Command | What it does |
|---------|-------------|
| `/model` | Switch the model for this channel (paged picker) |
| `/context` | Bind this channel to one of your existing conversations (paged picker) |
| `/reasoning` | Toggle extended-thinking output |
| `/fast` | Toggle OpenAI OAuth priority processing |
| `/stop` | Abort the current turn, including any child work it spawned |
| `/status` | Show the live session's model, context usage %, and usage |
| `/compact` | Summarize the conversation to free context |
| `/display` | Override display axes per channel (see below) |
| `/new` | Start a fresh conversation |
| `/voice` | Toggle spoken-audio replies (TTS) |
| `/restart` | Restart the daemon (admin only) |
| `/help` | Show available commands |

## Per-channel display

Each channel can override how the bot presents its work along four axes:

- **Tool activity** — Off (hide trace), Live status (tool start/completion), Live output (also streams bounded Bash progress)
- **Answer mode** — Final (one complete answer below the trace) or Live (edits the answer as it's written)
- **Tool message mode** — one compact live message, or one bubble per tool call
- **Tool output** — how much bounded tool output appears under each status line: hidden, summary, or tail

Per-channel overrides layer on top of the global config; axes you leave unset inherit the global default. Override with `/display` or set defaults in the plugin config.

## Voice

With an OpenAI-compatible provider configured (Settings → Brain), the bot can:

- **STT** — transcribe incoming voice messages so the agent understands them
- **TTS** — attach a spoken-audio version of replies (toggle per channel with `/voice`)

Configure the voice provider, STT model (default `whisper-1`), TTS model (default `gpt-4o-mini-tts`), and voice (alloy, echo, fable, onyx, nova, shimmer) in the plugin settings.

## Vision

Attach images to a message and the bot sends them to a vision-capable model. Configure `visionModel`, `maxImageBytes`, and `maxImages` in the plugin settings.

## Conversation behavior

Steering mid-turn, idle rollover, quoted replies, and message splitting work the same on every platform — see [How conversations work in channels](channels). Long answers split at Discord's message limit without breaking code fences.

## Server and thread scope

- `guildId` — restrict the bot to one server. Empty = any server it's invited to.
- `threadIds` — restrict the bot to specific threads (comma-separated IDs). Empty = respond anywhere allowed.
- `historyLimit` (0–100, default 0) — backfill that many recent channel messages as untrusted background context when a brand-new conversation starts here.

## Proactive pushes

Set `notifyChannelId` to a channel ID and the bot posts cron/tick results, escalations, and restart notices there. Empty = no proactive pushes.

[Next: Telegram](channels-telegram)
