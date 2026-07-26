---
title: API Reference
slug: api
order: 25
eyebrow: Operations
group: Reference
---

# API Reference

Elowen's daemon exposes a Hono REST API on port 4400. This page is the stable
route-family reference for developers and integrators. The executable contract
lives in the Zod schemas under `src/api/schemas/` and the route modules in
`src/api/routes/` — when in doubt, those files are authoritative.

**Base URL:** `http://localhost:4400`

## Authentication

Once at least one user exists, requests require a bearer token:

```http
Authorization: Bearer <token>
```

### Public probes (no token needed)

`GET /health`, `GET /setup`, `POST /auth/login`, `GET /push/vapid-public-key`.
During first-run setup the daemon stays open until the first user is created.

### Token scopes

| Scope | Use |
|-------|-----|
| `full` | Interactive users — unrestricted access to their permitted projects |
| `agent` | Spawned workers, pilots, overseers — restricted to a route and field allow-list |

Advisor credentials resolve to the owner's `full` scope but are stored
separately from login tokens; rotating an advisor does not invalidate an
interactive session.

### Browser access

The web UI never exposes a daemon token to JavaScript. It uses the same-origin
`/api` BFF proxy with an httpOnly session cookie. The CLI sends the bearer
header directly.

## Route families

All request bodies are JSON unless documented otherwise.

### Health, setup, configuration, events

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Daemon health and version |
| GET | `/setup` | Whether initial setup is required |
| GET, PUT | `/config` | Read or update configuration (admin) |
| GET | `/system` | Version, update posture, diagnostics |
| GET | `/system/readiness` | Admin readiness checks |
| GET | `/system/skills` | Installed skill status |
| POST | `/system/skills/install` | Install or repair skills |
| POST | `/system/update` | Start a guarded update |
| POST | `/system/restart` | Restart a service |
| GET | `/events` | Global SSE event stream |
| POST | `/mcp` | Stateless MCP request endpoint |
| GET | `/push/vapid-public-key` | Public push key |
| POST | `/push/subscribe`, `/push/unsubscribe` | Manage push devices |

`GET /events` emits state-change events (`task`, `mission`, `signal`, `plan`,
`review`, `decision`, `ask`) filtered by the subscriber's project access.

### Auth and users

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/auth/login`, `/auth/logout` | Start or revoke a session |
| GET, PATCH | `/auth/me` | Read or update current profile |
| POST | `/auth/me/password`, `/auth/me/avatar` | Change password, upload avatar |
| GET, PUT, DELETE | `/auth/me/prompts/:name` | Personal prompts CRUD |
| GET, PATCH | `/auth/me/cli-settings` | CLI prefs, advisor style, personality |
| GET, PATCH | `/auth/me/terminal-settings` | Terminal preferences |
| GET, PATCH | `/auth/me/permissions` | Current-user permissions |
| GET, POST | `/users` | List or create users (admin) |
| PATCH, DELETE | `/users/:id` | Update or remove a user |
| POST | `/users/:id/impersonate` | Admin impersonation |
| GET, POST | `/users/:id/projects` | Project assignments |
| DELETE | `/users/:id/projects/:pid` | Remove assignment |

### Tasks, plans, usage, asks

| Method | Path | Purpose |
|--------|------|---------|
| GET, POST | `/tasks` | List or create tasks |
| GET | `/tasks/ready`, `/tasks/deps` | Ready tasks, dependency edges |
| GET, PATCH, DELETE | `/tasks/:id` | Task CRUD |
| GET | `/tasks/:id/usage`, `/tasks/:id/conversation` | Usage and transcript |
| GET | `/tasks/:id/changed/diff`, `/tasks/:id/commits` | Changes and commits |
| POST | `/tasks/:id/approve-gate` | Approve a review gate |
| POST | `/tasks/:id/ask` | Park a question |
| POST | `/tasks/:id/ask/:askId/reply` | Answer a parked question |
| GET | `/asks/pending` | Pending human questions |
| POST | `/tasks/plan` | Start async mission planning |
| GET, POST | `/plan/:jobId`, `/plan/:jobId/submit` | Plan job read/submit |
| GET | `/usage/by-model`, `/usage/by-day` | Aggregated usage |
| POST | `/usage/reset` | Admin usage reset |

### Missions

| Method | Path | Purpose |
|--------|------|---------|
| GET, POST | `/missions` | List or engage missions |
| GET, PATCH, DELETE | `/missions/:id` | Read, pause/resume, disengage |
| GET | `/missions/:id/changed-files` | Phase change summary |
| POST | `/missions/:id/pr`, `/missions/:id/merge-pr` | Open or merge a PR |
| GET, POST | `/missions/:id/overseer/next`, `/missions/:id/overseer/decide` | Overseer protocol |

### Sessions and terminal

| Method | Path | Purpose |
|--------|------|---------|
| GET, POST | `/sessions` | List or create sessions |
| GET, DELETE | `/sessions/:name` | State or termination |
| POST | `/sessions/:name/keys`, `/sessions/:name/input`, `/sessions/:name/resize` | Terminal input |
| GET | `/sessions/:name/pane`, `/sessions/:name/stream` | Snapshot or SSE stream |
| POST | `/sessions/:name/ws-ticket` | Mint a WebSocket ticket |

The ticket is consumed by `GET /ws/terminal?ticket=...` — a single-use PTY
WebSocket transport.

### Projects and files

| Method | Path | Purpose |
|--------|------|---------|
| GET, POST | `/projects` | List or register projects |
| PATCH, DELETE | `/projects/:id` | Edit or remove |
| GET | `/fs/dirs` | Discover permitted directories |
| GET | `/projects/:id/git`, `/projects/:id/files`, `/projects/:id/file` | Git, tree, file content |
| PUT | `/projects/:id/file` | Save a file |
| POST | `/projects/:id/new-file`, `/projects/:id/dir`, `/projects/:id/rename`, `/projects/:id/copy` | FS operations |
| DELETE | `/projects/:id/entry` | Remove an entry |
| GET | `/projects/:id/diff`, `/projects/:id/commits`, `/projects/:id/commit/:hash/diff` | Change info |

### Brain and advisor

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/advisor/status` | Advisor state |
| POST | `/advisor/start`, `/advisor/stop` | Start or stop advisor |
| GET | `/brain/status`, `/brain/models`, `/brain/rate-limits` | Chat capability metadata |
| POST | `/brain/start`, `/brain/send`, `/brain/abort`, `/brain/session/stop` | Chat lifecycle |
| PATCH, DELETE | `/brain/sessions/:id` | Update or remove conversation |
| GET | `/brain/sessions`, `/brain/messages`, `/brain/search` | Listings and search |
| GET | `/brain/stream` | SSE chat stream |
| POST | `/brain/model`, `/brain/think`, `/brain/fast`, `/brain/yolo`, `/brain/compact` | Turn controls |
| GET, POST, DELETE | `/brain/processes`, `/brain/processes/:id` | Background processes |
| POST | `/brain/providers/probe`, `/brain/test` | Provider discovery and test |

### Plugins, memory, integrations

| Family | Prefix | Purpose |
|--------|--------|---------|
| Plugins | `/plugins` | Discovery, install, config, hooks, cron, skills, channel controls |
| Memory | `/memory` | Entries, categories, merge, retrieval, embeddings |
| Activity | `/activity`, `/notes` | Event history, project notes |
| Integrations | `/integrations` | CLI and GitHub readiness |
| OAuth | `/brain/oauth` | Provider OAuth flow and disconnect |

For exact method/path pairs in these families, see the route modules in
`src/api/routes/`.

## Error responses

All failures return `{ "error": "..." }` with an appropriate status code:

| Code | Meaning |
|------|---------|
| 400 | Invalid input (validation failure) |
| 401 | Missing or invalid token |
| 403 | Policy or project access denied |
| 404 | Unknown resource |
| 409 | Conflicting runtime state |
| 422 | External workflow could not complete |

Treat the error text as human-readable diagnostics, not a stable enum. Branch
on the HTTP status code.

> The Zod schemas in `src/api/schemas/` are the executable contract. If this
> page and the schemas disagree, the schemas win.

[Back to start](getting-started)
