---
title: Deployment
slug: deployment
order: 24
eyebrow: Operations
group: Reference
---

# Deployment

The [Install](install) page gets Elowen running on your machine. This page
covers production operations: process supervision, reverse-proxy setup,
monitoring, updates, and database care.

## Prerequisites

Node.js >=22, tmux >=3.x, npm — see [Install](install).

## Production build

```bash
npm ci --omit=dev
npm run build
```

Compiles TypeScript and copies `schema.sql` + `prompts/` into `dist/`. Daemon
entry point: `dist/daemon/index.js`.

## systemd services

`/etc/systemd/system/elowen-daemon.service`:

```ini
[Unit]
Description=Elowen AI agent orchestrator
After=network.target

[Service]
Type=simple
User=elowen
WorkingDirectory=/opt/elowen
ExecStart=/usr/bin/node /opt/elowen/dist/daemon/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=ELOWEN_DB=/opt/elowen/data/elowen.db
Environment=ELOWEN_PROJECT_PATH=/opt/elowen

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/elowen-web.service`:

```ini
[Unit]
Description=Elowen web UI
After=elowen-daemon.service

[Service]
Type=simple
User=elowen
WorkingDirectory=/opt/elowen/web
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5
Environment=ELOWEN_DAEMON_URL=http://localhost:4400
Environment=NEXT_PRIVATE_STANDALONE=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now elowen-daemon elowen-web
```

## Reverse proxy (nginx)

```nginx
server {
    listen 443 ssl;
    server_name elowen.example.com;

    location / {
        proxy_pass http://127.0.0.1:4500;
        proxy_http_version 1.1;
    }

    # Daemon API + SSE (BFF proxy via Next.js)
    location /api/ {
        proxy_pass http://127.0.0.1:4500;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        proxy_set_header x-real-ip $remote_addr;
    }

    # Real-PTY WebSocket terminal (straight to daemon)
    location /ws/ {
        proxy_pass http://127.0.0.1:4400;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400s;
        proxy_set_header x-real-ip $remote_addr;
    }

    # Plugin webhooks (e.g. Teams bot endpoint)
    location /hooks/ {
        proxy_pass http://127.0.0.1:4400;
        proxy_http_version 1.1;
        proxy_set_header x-real-ip $remote_addr;
    }

    # Service worker — never cache
    location = /sw.js {
        proxy_pass http://127.0.0.1:4500;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
    }
}
```

Why each location matters:

| Location | Reason |
|----------|--------|
| `/api/` | `proxy_buffering off` + long timeout keep SSE streams flowing without nginx swallowing events. |
| `/ws/` | WebSocket upgrade for real-PTY terminal; without it, terminals fall back to snapshot mirror. |
| `/hooks/` | Plugin inbound webhooks (e.g. Teams Bot Framework). Auth handled by the plugin, not the daemon token. |
| `/sw.js` | Prevents a cached service worker from serving stale UI after deploys. |

> Set `x-real-ip` on every proxied location. The daemon uses it for login rate
> limiting; without it, all users share one bucket behind the proxy.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ELOWEN_PORT` | `4400` | Daemon listen port |
| `ELOWEN_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` to expose) |
| `ELOWEN_DB` | `~/.config/elowen/elowen.db` | SQLite database path |
| `ELOWEN_PROJECT_PATH` | `$PWD` | Default project root |
| `ELOWEN_ALLOW_OPEN` | *(empty)* | Set `1` for no-auth mode |
| `ELOWEN_BOOTSTRAP_USER` / `PASS` | *(empty)* | Initial admin credentials |
| `ELOWEN_LOG_LEVEL` | *(empty)* | `debug`, `info`, `warn`, `error` |
| `ELOWEN_LOG_DIR` | `~/.config/elowen/logs` | File-based log directory |
| `ELOWEN_WEB_PORT` | `4500` | Web UI port |
| `ELOWEN_DAEMON_URL` | `http://localhost:4400` | Web UI to daemon URL |
| `ELOWEN_RELAY_URL` / `KEY` / `MODEL` | *(empty)* | Autopilot relay config |

CLI-specific vars (`ELOWEN_URL`, `ELOWEN_TOKEN`, `ELOWEN_AUTOSTART`) are
covered in [Install](install).

## Monitoring

```bash
curl http://localhost:4400/health   # {"ok":true}

journalctl -u elowen-daemon -f                        # systemd journal
tail -f ~/.config/elowen/logs/daemon-$(date +%F).log  # daily file logs
```

Log files are daily (`daemon-2026-07-26.log`); there is no rolling file.
Settings > Data > Logs in the web UI reads the same directory.

## Updating

```bash
elowen update
```

Self-locating: computes the npm prefix from its own binary path, handles
root-owned installs via sudo. An auto-update timer (provisioned by
`elowen install`) checks hourly and respects running missions. Toggle in
Settings > System.

## Database

SQLite with WAL mode. Default: `~/.config/elowen/elowen.db`. Back up with
`sqlite3 /path/to/elowen.db ".backup /backup/elowen-$(date +%Y%m%d).db"`.
Schema changes are additive (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE`)
applied at boot. No migration framework — back up before updating.

## Troubleshooting (quick reference)

| Symptom | First check |
|---------|-------------|
| Daemon won't start | Node >=22? tmux? Port 4400 free? DB path writable? |
| Sessions stuck | `elowen sessions`, then `DELETE /sessions/:name` |
| CLI can't reach daemon | `curl http://localhost:4400/health` |
| Web shows "unreachable" | Daemon running? `ELOWEN_DAEMON_URL` correct? |
| Login returns 429 | Wait 5 min or restart. Check nginx `x-real-ip`. |

Full guide: [Troubleshooting](troubleshooting).

[Next: API Reference](api)
