---
title: Channels
slug: channels
order: 18
eyebrow: Channels
group: Channels
---

# Channels

Channels let you talk to the same Elowen agent from Discord, Telegram, Microsoft Teams, or WhatsApp. They are platform plugins that adapt inbound messages into the same brain-turn pipeline the Web UI and CLI use — one runtime, one memory, one policy behind every surface.

A sender must be mapped to an Elowen role policy before the bot answers. Unmapped senders are silently ignored. This is deny-by-default: nobody gets agent access until you grant it.

## Pick your channel

- **[Discord](channels-discord)** — a bot in your server, role-mapped per Discord role.
- **[Telegram](channels-telegram)** — a long-polling bot you message directly or in groups.
- **[Microsoft Teams](channels-teams)** — a webhook bot for your org, identity-mapped via Entra.
- **[WhatsApp](channels-whatsapp)** — a paired account for direct and group chats.

## Shared behavior

All channels share these traits:

- **Reactions** — 👀 while thinking; ✅/❌ when done on Discord and WhatsApp, 👍/👎 on Telegram (its reaction emoji set is limited). Toggle with `reactions`.
- **Runtime footer** — a small "model · context %" line under the final reply (toggle with `runtimeFooter`)
- **Reasoning** — stream extended-thinking output into the progress bubble (toggle with `showReasoning`, off by default)
- **AskUserQuestion** — when the agent needs a decision, it posts a prompt and waits for a reply (button click on Discord, inline-keyboard tap on Telegram, Adaptive Card tap on Teams, numbered reply on WhatsApp). `askTimeoutMs` controls how long it stays open.
- **Language** — service messages (`/new`, `/model`, placeholders) in `en`, `cs` or `sk`, selectable from a dropdown in the plugin settings.
- **`/context`** — bind the current channel/chat to one of your existing conversations from any surface (CLI, Web UI, another channel). The command opens a paginated picker of your own conversations (Discord and Teams use native select menus with prev/next buttons; Telegram uses inline-keyboard pages; WhatsApp uses a numbered text menu you reply to). Picking one moves the channel's session onto that conversation's history, so you can continue a CLI or Web chat right from your phone. Operator-gated (admin role policies only); ownership is re-verified server-side.

## How conversations work in channels

Channels are shared spaces, so the agent handles them differently from a private CLI or Web UI session. These rules apply on every platform.

### Who is talking

Every message in a shared channel arrives prefixed with the sender's display name, so the agent always knows who said what. It follows multi-user etiquette: it addresses you by name, keeps each sender's requests separate, and never mixes one person's context into another person's answer.

### Linked identity

When a platform account is linked to an Elowen account, that person is treated as themselves: their own project policy, tool permissions, and personal memory apply, bypassing the channel's role policy. Unlinked senders get no memory recall at all — in a shared space the agent never leaks one person's remembered facts into replies visible to everyone.

### /context moves, not copies

Binding a conversation into a channel with `/context` **replaces** the channel's session: the channel adopts that conversation's full history and the old channel session is archived. Nothing is duplicated — the conversation itself moves. This works across surfaces, so a conversation started in the CLI can continue in Discord or on your phone. See [Slash Commands](slash-commands) for the full command reference.

### Steering mid-turn

If you send another message while the agent is still working on yours, it folds into the running turn as additional input — you can steer, correct, or add detail without waiting. A message from a different sender does not interrupt; it queues and gets its own turn.

### Idle rollover

When a channel stays quiet past the idle cutoff (30 minutes by default), the next message starts a fresh session. The previous conversation is not lost — it stays browsable in your conversation list and can be pulled back with `/context`.

### Delivery details

- The platform shows a typing indicator while the agent works, so the channel can see it is busy.
- Long answers are split at the platform's message-length limit without breaking fenced code blocks or tables mid-block.
- When you reply to or quote a message, the quoted content arrives with yours as context, so the agent sees what you are referring to.
- Generated images are uploaded as real platform attachments, not links.

### Questions in channels

When the agent needs a decision, its question renders as numbered options in the channel. An **Other** option (or free-text reply where the platform supports it) captures a custom answer. Only the person the question was addressed to — or an admin — can answer; replies from anyone else are ignored for that question.

## Security model

- Sender identity is resolved before any turn runs. No mapping = no access.
- Each policy can restrict tools, models, and project scope independently.
- Provider credentials stay on the daemon; they are never exposed to the chat platform.
- The same RBAC, approval gates, and autonomy levels apply regardless of which surface the message arrives on.

[Next: Discord](channels-discord)
