#!/usr/bin/env bash
# Deploy this checkout to the Chetty VM: sync sources, rebuild the image, restart the stack.
#
# Usage:  ./deploy.sh [--no-build]
#
# The daemon drains running turns for up to 10 minutes, so `docker compose up` is given the same
# budget through stop_grace_period in compose.yml. Expect a redeploy to pause on that if an agent
# is mid-turn; that wait is deliberate, not a hang.
set -euo pipefail

VM_HOST="${VM_HOST:-40.113.139.208}"
VM_USER="${VM_USER:-azureuser}"
VM_PATH="${VM_PATH:-/opt/elowen}"
SSH_KEY="${SSH_KEY:-/var/www/.ssh/chetty-agent_ed25519}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SSH_CMD="ssh -i ${SSH_KEY} -o UserKnownHostsFile=/var/www/.ssh/known_hosts -o StrictHostKeyChecking=accept-new"

echo "==> syncing ${SRC} -> ${VM_USER}@${VM_HOST}:${VM_PATH}"
# .env holds the domain and bootstrap credentials and is created on the VM; never overwrite it.
rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' --exclude 'web/node_modules' \
  --exclude 'dist' --exclude 'web-dist' --exclude 'web/.next' \
  --exclude 'data' --exclude '*.db*' --exclude '.env' \
  --exclude '.worktrees' --exclude 'benchmark-env' --exclude '*.log' \
  -e "${SSH_CMD}" "${SRC}/" "${VM_USER}@${VM_HOST}:${VM_PATH}/"

if [ "${1:-}" != "--no-build" ]; then
  echo "==> building image"
  ${SSH_CMD} "${VM_USER}@${VM_HOST}" "cd ${VM_PATH} && docker compose build"
fi

echo "==> restarting stack"
${SSH_CMD} "${VM_USER}@${VM_HOST}" "cd ${VM_PATH} && docker compose up -d"

echo "==> waiting for the daemon to report healthy"
${SSH_CMD} "${VM_USER}@${VM_HOST}" '
  for i in $(seq 1 60); do
    if docker exec elowen-elowen-1 curl -fsS http://127.0.0.1:4400/health >/dev/null 2>&1; then
      echo "daemon healthy after ${i}0s"; exit 0
    fi
    sleep 10
  done
  echo "daemon did not become healthy in 10 minutes" >&2
  docker compose -f '"${VM_PATH}"'/compose.yml logs --tail 50 elowen >&2
  exit 1
'

echo "==> deployed"
