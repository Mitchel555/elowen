---
title: WhatsApp
slug: channels-whatsapp
order: 22
eyebrow: Channels
group: Channels
---

# WhatsApp

A paired WhatsApp account answers in direct and group chats, with each sender mapped to an Elowen project scope and policy.

For what every channel shares — reactions, reasoning, service language, and the security model — see [Channels](channels).

## Setup

1. In Elowen: **Settings → Plugins → WhatsApp** → enable the plugin.
2. Pair the bot to a WhatsApp account — either from the daemon log or from the **Web UI pairing modal** (Settings → Plugins → WhatsApp → Pair), which shows both the QR code and the pairing code:
   - **QR code** — scan it from WhatsApp → Linked devices.
   - **Pairing code** — set `phoneNumber` (international format without +, e.g. `420777123456`) to get an 8-character code. Enter it in WhatsApp → Linked devices → Link with phone number.
3. Map at least one sender policy (see below).

## Sender policies

Each sender (phone number, JID, or whole group JID) maps to an Elowen project scope and role prompt. First match wins; unmatched senders are ignored.

- **Sender ID** — phone number (`420777123456`), JID (`…@s.whatsapp.net`), or group JID (`…@g.us`)
- **Elowen projects** — which projects this sender can act in
- **Role prompt** — scoped instructions
- **Admin** — grants model switching and group tools
- **Allowed tools** — optional allow-list

A group JID grants access to everyone in that group.

## Text commands

| Command | What it does |
|---------|-------------|
| `/model` | Show a numbered model menu; reply with a number to switch |
| `/context` | Show a numbered menu of your conversations; reply with a number to bind one here |
| `/reasoning` | Toggle extended-thinking output |
| `/fast` | Toggle OpenAI OAuth priority processing |
| `/stop` | Abort the current turn, including any child work it spawned |
| `/status` | Show the live session's model, context usage %, and usage |
| `/compact` | Summarize the conversation to free context |
| `/new` | Start a fresh conversation |
| `/help` | Show available commands |

**AskUserQuestion** works in plain text: reply with a number to pick an option, or any non-numeric text to answer a single question free-form.

## No voice

> WhatsApp has no voice features — no transcription, no spoken replies. A voice message arrives as an untranscribed audio attachment. Voice is [Discord](channels-discord) and [Telegram](channels-telegram) only.

## Groups

- `respondWithoutMention` (default on) — in groups, answer every message from a mapped sender. Off = only answer when @mentioned or replied to. Direct chats always get an answer.
- `groupIds` — comma-separated group JIDs to restrict where the bot responds. Empty = respond in every group where a mapped sender writes.

## Streaming

WhatsApp uses a simpler streaming model than Discord or Telegram: a single `streaming` boolean instead of the `/display` axes. With `streaming` enabled (default), the bot edits its reply in place as it streams — tool calls and text appear progressively. Off = one message at the end.

## Conversation behavior

Steering mid-turn, idle rollover, quoted replies, and message splitting work the same on every platform — see [How conversations work in channels](channels). Long answers split at WhatsApp's message limit without breaking code fences.

## Proactive pushes

Set `notifyChat` to a phone number or JID and the bot posts cron/tick results, escalations, and restart notices there. Empty = no proactive pushes.

[Next: Plugins](plugins)
