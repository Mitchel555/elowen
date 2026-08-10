#!/usr/bin/env bash
# Move this checkout onto a fresh repository and make it the new origin.
#
# Needed because the current origin is a FORK of the public dragocz95/elowen: GitHub ties a fork's
# visibility to its upstream network ("You cannot change the visibility of a fork by itself"), so the
# company repo can never be made private while it stays in that network. The target must therefore be
# a brand-new EMPTY repository — created with the "New repository" button, never with "Fork".
#
#   ./bin/migrate-remote.sh git@github.com:<owner>/elowen-chetty.git
#
# The old fork is left untouched, so this is reversible until someone deletes it.
set -euo pipefail

NEW_URL=${1:?usage: migrate-remote.sh <git-url-of-new-empty-repo>}

# Branches worth carrying. The dependabot branch is deliberately dropped — it is noise that the new
# repo will raise again by itself if it still applies.
BRANCHES=(main archive/michal-main-20260810 agent/azure-app-service)

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> refreshing local copies of every branch being carried"
git fetch origin --prune --tags
for b in "${BRANCHES[@]}"; do
  git rev-parse --verify --quiet "refs/remotes/origin/$b" >/dev/null \
    || { echo "migrate-remote: origin has no branch '$b'" >&2; exit 1; }
  git branch --force "$b" "origin/$b"
done

echo "==> pushing to $NEW_URL"
# Pushed by name rather than with --mirror: a mirror clone of a GitHub repo also carries refs/pull/*,
# which the receiving side rejects.
git push "$NEW_URL" "${BRANCHES[@]}"
git push "$NEW_URL" --tags

echo "==> repointing origin (the old fork stays as 'fork' so nothing is lost)"
git remote set-url origin "$NEW_URL"
git remote get-url fork >/dev/null 2>&1 || git remote add fork https://github.com/Mitchel555/elowen.git
git fetch origin --prune

echo "==> done; remotes are now:"
git remote -v
echo
echo "Next: flip the new repository to private in its settings — it is standalone, so the option is there."
