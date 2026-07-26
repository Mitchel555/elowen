---
title: Glossary
slug: glossary
order: 29
eyebrow: Help
group: Help
---

# Glossary

The words Elowen uses across the CLI, the Web UI, and these docs, in plain language. Each entry links to the page that covers the topic in depth.

## Core concepts

| Term | Meaning |
| --- | --- |
| **brain** | The conversational agent you chat with — the part that reads your messages, reasons, decides which tools to call, and writes answers. See [Brain & Chat](brain-chat). |
| **worker / executor** | A non-conversational agent process that runs an assigned task in the background and reports an outcome, instead of chatting with you. See [Agents & Providers](agents-providers). |
| **session** | One running instance of the brain, bound to a conversation and a set of permissions. The CLI, the web chat, and channels each hold their own sessions. See [Brain & Chat](brain-chat). |
| **conversation** | The durable message history a session works through. Conversations survive restarts and can be resumed from any surface. See [Brain & Chat](brain-chat). |
| **project** | A directory tree the agent is allowed to work in. Projects scope file access, shell commands, and search to known roots. See [Projects & Workflow](projects-workflow). |
| **channel** | A chat platform connected to Elowen — Discord, Telegram, Teams, or WhatsApp — where other people can talk to the agent. See [Channels](channels). |

## Automation

| Term | Meaning |
| --- | --- |
| **task** | A unit of tracked work on the control plane, with a state, an assignee, and an outcome. Tasks are what workers and missions pick up. See [Tasks & Missions](tasks-missions). |
| **mission** | A standing objective the autopilot works toward by creating and supervising tasks over time, rather than answering a single request. See [Tasks & Missions](tasks-missions). |
| **autopilot** | The mode in which Elowen pursues missions on its own: planning work, assigning it to workers, and checking results without you prompting each step. See [Tasks & Missions](tasks-missions). |
| **workflow** | A directed graph of sub-agents the brain assembles for one request — independent nodes run in parallel, dependents wait for their inputs. See [CLI](cli). |
| **sub-agent** | A fresh agent with its own clean context, delegated one self-contained task by the brain. It cannot see the parent conversation and can only ever narrow the caller's permissions. See [Agents & Providers](agents-providers). |
| **cron job** | A prompt Elowen runs on a recurring schedule — daily summaries, periodic checks. See [Scheduling](scheduling). |
| **wake-up** | A one-shot scheduled prompt that fires once at a set time or after a delay, then removes itself — used to check back on something that changes over time. See [Scheduling](scheduling). |
| **autonomy level** | How much the agent may do without asking first — from read-only up to acting on your behalf — set per account. See [Autonomy & Safety](autonomy-safety). |
| **overseer** | The supervisory role that reviews missions and workers: approving plans, checking outcomes, and stepping in when a run goes off track. See [Autonomy & Safety](autonomy-safety). |

## Extending

| Term | Meaning |
| --- | --- |
| **plugin** | A bundle that adds capabilities to Elowen — tools, channels, scheduled jobs — loaded by the daemon. See [Plugins](plugins). |
| **skill** | A markdown instruction file that teaches the agent a repeatable procedure, loaded when a matching task appears. See [Skills](skills). |
| **tool** | A single callable action the agent can invoke — read a file, run a command, call an API — each with a declared input schema. See [Plugins](plugins). |
| **MCP** | The Model Context Protocol, an open standard for connecting external tool servers. Elowen can consume MCP servers and expose its own tools over MCP. See [MCP](mcp). |

## Memory and access

| Term | Meaning |
| --- | --- |
| **memory** | Durable facts Elowen stores about you and your projects between conversations — preferences, decisions, environment details — recalled when relevant. See [Memory](memory). |
| **embedding** | A numeric fingerprint of a piece of text that makes meaning-based search possible — over memories and over your code. See [Memory](memory). |
| **role policy** | The set of permissions attached to a role — what its holders may read, run, and approve. See [Users & Access](users-access). |
| **RBAC** | Role-based access control: permissions granted through roles assigned to accounts, rather than per-person rules. See [Users & Access](users-access). |
| **token scope** | The slice of access a single API token carries, so an automation or integration gets exactly the permissions it needs and no more. See [Users & Access](users-access). |

[Back to start](getting-started)
