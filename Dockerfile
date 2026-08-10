# Production image for the Chetty VM deployment.
#
# Derived from Dockerfile.azure (Michal Stoklasa) with the App Service specifics removed:
# state lives on a Docker volume under /data instead of the network-mounted /home, so SQLite
# keeps its default WAL journal and ELOWEN_SQLITE_JOURNAL_MODE is not needed here.
FROM node:22-bookworm-slim AS build

# node-pty and better-sqlite3 compile from source; the toolchain stays in the build stage only.
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci

COPY . .
RUN npm run build && npm run build:web && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

# tmux: agents run inside tmux sessions. git: agents clone and inspect repositories.
# curl: container healthcheck against the daemon's /health probe.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git tmux \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    ELOWEN_HOST=0.0.0.0 \
    ELOWEN_PORT=4400 \
    ELOWEN_WEB_PORT=4500 \
    ELOWEN_DAEMON_URL=http://127.0.0.1:4400 \
    ELOWEN_DB=/data/db/elowen.db \
    ELOWEN_LOG_DIR=/data/logs \
    ELOWEN_PROJECT_PATH=/data/project \
    ELOWEN_AUTOSTART=0

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/plugins ./plugins
COPY --from=build /app/prompts ./prompts
COPY --from=build /app/web-dist ./web-dist
COPY scripts/container-start.mjs ./scripts/container-start.mjs

# 4400 is the daemon, 4500 the web UI. Neither is published to the host by compose:
# a daemon token can spawn agents, so only the proxy container may reach 4400.
EXPOSE 4400 4500

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=5 \
    CMD curl -fsS http://127.0.0.1:4400/health || exit 1

CMD ["node", "scripts/container-start.mjs"]
