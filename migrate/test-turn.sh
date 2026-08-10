#!/bin/sh
# End-to-end check: run one real brain turn against the configured provider.
#
# Mints a short-lived 'full' token straight into auth_tokens, runs `elowen run`, and always deletes
# the token again on exit. Meant to be executed INSIDE the app container, where /app and the database
# are both present. Usage: test-turn.sh "prompt"
set -e

export DB="${DB:-/data/db/elowen.db}"
export USERNAME="${USERNAME:-filip}"

TOKEN=$(node -e '
const D = require("better-sqlite3");
const { randomBytes } = require("node:crypto");
const d = new D(process.env.DB);
const u = d.prepare("SELECT id FROM users WHERE username = ?").get(process.env.USERNAME);
if (!u) throw new Error(`no user ${process.env.USERNAME}`);
const t = randomBytes(32).toString("hex");
d.prepare("INSERT INTO auth_tokens (token,user_id,scope,task_id) VALUES (?,?,?,?)").run(t, u.id, "full", null);
console.log(t);
')

cleanup() {
  TOKEN="$TOKEN" node -e '
const D = require("better-sqlite3");
const d = new D(process.env.DB);
const n = d.prepare("DELETE FROM auth_tokens WHERE token = ?").run(process.env.TOKEN).changes;
console.error(`[test-turn] docasny token smazan (${n})`);
'
}
trap cleanup EXIT INT TERM

ELOWEN_TOKEN="$TOKEN" ELOWEN_URL="${ELOWEN_URL:-http://127.0.0.1:4400}" \
  node dist/cli/bin.js run "$1"
