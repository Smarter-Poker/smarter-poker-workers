#!/usr/bin/env bash
# A COMMIT VERCEL CANNOT ATTRIBUTE NEVER BUILDS.
#
# Vercel refuses to build a commit whose GitHub author it cannot resolve to a
# user account. The deployment enters state BLOCKED: the build never starts, so
# there are NO logs, and nothing in CI can see it. The only symptom is a red row
# in the Vercel dashboard.
#
# On 2026-08-23 five deployments across hub-vanguard, pepnationlab and
# smarter-poker-commander sat BLOCKED. Every one was a commit authored
#
#     Agent <agent@smarter.poker>
#
# — an address belonging to no GitHub account. World Hub's CLAUDE.md 2.2 already
# carried CHECK 15 for exactly this, added after five production deployments
# were blocked in one afternoon. But CHECK 15 runs in CI, which means it speaks
# only AFTER the commit is on main and the deploy has already been refused.
#
# This runs at commit time, on the machine, before anything leaves it. It is the
# difference between "your production deploy is blocked" and "that commit was
# never made".
#
# It is also why scripts/agent-workspace.sh now SETS this identity in every
# worktree it hands out: a guard that only refuses is a guard people fight.
#
# Bypass, for a human committing under their own resolvable GitHub account:
#     AGENT_IDENTITY_OK=1 git commit ...
set -euo pipefail

[ "${AGENT_IDENTITY_OK:-}" = "1" ] && exit 0
[ -n "${CI:-}${GITHUB_ACTIONS:-}" ] && exit 0

APPROVED_NAME="Smarter-Poker"
APPROVED_EMAIL="254329056+Smarter-Poker@users.noreply.github.com"
# github-actions[bot] is resolvable and is what the sync and the bots commit as.
BOT_EMAIL="github-actions[bot]@users.noreply.github.com"

NAME=$(git config user.name  || echo "")
EMAIL=$(git config user.email || echo "")

case "$EMAIL" in
  "$APPROVED_EMAIL"|"$BOT_EMAIL") exit 0 ;;
esac

cat >&2 <<MSG

  ─────────────────────────────────────────────────────────────────────────
  COMMIT REFUSED - Vercel would never build this.

    author: ${NAME:-<unset>} <${EMAIL:-<unset>}>

  Vercel refuses to build a commit whose GitHub author it cannot resolve to a
  user account. The deployment goes to BLOCKED: no build, no logs, nothing in
  CI can see it, and the only sign is a red row in the dashboard. Five
  deployments sat that way on 2026-08-23, all of them authored
  'Agent <agent@smarter.poker>'.

  Set the one identity this estate deploys under:

      git config user.name  "$APPROVED_NAME"
      git config user.email "$APPROVED_EMAIL"

  Then commit again. To fix commits you have already made on this branch:

      git rebase -r --exec 'git commit --amend --no-edit --reset-author' origin/main

  scripts/agent-workspace.sh sets this for you. If you are here, you are
  probably in a tree it did not create - which is worth checking on its own.

  If you are a human committing under your own GitHub account:

      AGENT_IDENTITY_OK=1 git commit ...
  ─────────────────────────────────────────────────────────────────────────

MSG
exit 1
