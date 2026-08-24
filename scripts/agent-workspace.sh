#!/usr/bin/env bash

# .husky/reference-transaction refuses a ref update that would orphan local
# commits. This script moves refs backwards as part of its job, so it
# announces the intent rather than the guard learning to ignore a command
# shape. See that hook for what it saves before it refuses.
export AGENT_REF_GUARD_OK=1
# ONE WORKING TREE PER AGENT. Never share a checkout.
#
# THE PROBLEM THIS SOLVES
# Several agents were operating in the same clone at once. A working tree has
# exactly one HEAD, one index and one set of uncommitted files, so when agent B
# runs `git checkout -b`, agent A's in-progress edits either travel onto B's
# branch or get stashed out from under it. Neither agent is told. The evidence
# was sitting in this repo: eight abandoned stashes and six `backup/*` branches
# from `git-unstick.sh` rescues, each one somebody's work being saved from
# somebody else's checkout.
#
# Branch protection cannot help here. This damage happens before anything is
# pushed, and the Antigravity `git reset --hard origin/main` loop then destroys
# whatever is still uncommitted at that moment.
#
# A git worktree gives each agent its own directory, HEAD, index and branch,
# sharing one object store. Agents become physically unable to disturb one
# another.
#
# USAGE
#   eval "$(bash scripts/agent-workspace.sh claude fix/leaderboard-rpc)"
#   # -> creates/reuses a worktree and cd's you into it
#
# Or just read the path it prints:
#   bash scripts/agent-workspace.sh claude fix/leaderboard-rpc --print-path
set -euo pipefail

AGENT="${1:-}"
SLUG="${2:-}"
MODE="${3:-}"

if [ -z "$AGENT" ] || [ -z "$SLUG" ]; then
  echo "usage: agent-workspace.sh <agent-name> <branch-slug> [--print-path]" >&2
  echo "   eg: agent-workspace.sh claude fix/leaderboard-rpc" >&2
  exit 2
fi

# Resolve the main clone regardless of which worktree we were invoked from.
ROOT=$(git rev-parse --path-format=absolute --git-common-dir)
ROOT=${ROOT%/.git}
REPO=$(basename "$ROOT")
TREES="${AGENT_WORKTREE_ROOT:-$HOME/Documents/.agent-trees/$REPO}"

SAFE_AGENT=$(printf '%s' "$AGENT" | tr -c 'A-Za-z0-9._-' '-')
BRANCH="agent/${SAFE_AGENT}/$(printf '%s' "$SLUG" | sed 's#^agent/[^/]*/##')"
DIR="$TREES/$SAFE_AGENT"

git -C "$ROOT" fetch origin main --quiet

# ── SNAPSHOT EVERY OTHER TREE BEFORE TOUCHING ANYTHING ──────────────────────
#
# The ten-minute launchd snapshot is the intended safety net, and on a Mac that
# has not granted Full Disk Access it captures NOTHING: ~/Documents is
# TCC-protected, so an unprivileged launchd agent may stat a path inside it but
# not open one. Measured 2026-08-22 — 73 runs, zero snapshots, while nine trees
# held uncommitted work.
#
# THIS script runs in an agent's own shell, which does have that access. And it
# runs at exactly the right moment: an agent arriving is precisely when another
# agent's uncommitted work is most likely to be disturbed. So take the snapshot
# here too.
#
# Deliberately unfailable and silent: `|| true` and output discarded, because a
# safety net must never be the reason a workspace claim fails. It costs about a
# second. If you want to see what it captured:
#   bash scripts/agent-trees-snapshot.sh --list
SNAP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent-trees-snapshot.sh"
[ -f "$SNAP" ] && (cd "$ROOT" && bash "$SNAP" >/dev/null 2>&1) || true

if [ -d "$DIR" ] && git -C "$DIR" rev-parse --git-dir >/dev/null 2>&1; then
  # Reuse. Refuse to move an agent off work it has not committed - that is the
  # exact destruction this script exists to prevent.
  if [ -n "$(git -C "$DIR" status --porcelain)" ]; then
    CUR=$(git -C "$DIR" branch --show-current)
    echo "# NOTE: $DIR has uncommitted changes on '$CUR'." >&2
    echo "# Leaving it exactly as it is. Commit or push that work first." >&2
    [ "$MODE" = "--print-path" ] && echo "$DIR" || echo "cd '$DIR'"
    exit 0
  fi
  git -C "$DIR" checkout -q -B "$BRANCH" origin/main
else
  mkdir -p "$TREES"
  # -B moves the branch to origin/main if it already exists, and creates it
  # otherwise. --force lets one agent re-take a branch name it owns.
  git -C "$ROOT" worktree add --force -B "$BRANCH" "$DIR" origin/main >/dev/null
fi

# The one identity this estate can deploy under. Vercel refuses to build a
# commit whose author it cannot resolve to a GitHub user; the deployment goes
# to BLOCKED with no logs. Setting it here means an agent cannot get it wrong,
# and scripts/guard-commit-identity.sh catches anyone working outside this tree.
git -C "$DIR" config user.name  "Smarter-Poker"
git -C "$DIR" config user.email "254329056+Smarter-Poker@users.noreply.github.com"

# HOOKS AND DEPENDENCIES BEFORE THE FIRST COMMIT, NOT AFTER.
# 2026-08-23: a fresh worktree had neither, and both failures were silent.
# core.hooksPath pointed at the gitignored .husky/_, so git ran no hooks here at
# all; and with no node_modules the hooks that did run went to the network.
bash "$ROOT/scripts/ensure-hooks.sh" 2>&1 | sed "s/^/# /" >&2 || true

# The link above is shared, and npm run inside ANY worktree writes through it.
# Twice on 2026-08-23 that left ~285 package directories empty and broke the
# hooks in every tree at once, with only an ERR_MODULE_NOT_FOUND to go on.
# Probe it here - the one moment an agent is guaranteed to be looking - and
# repair rather than report.
bash "$ROOT/scripts/check-node-modules.sh" 2>&1 | sed "s/^/# /" >&2 || true

# Every other guard in this estate queries GitHub, so all of them are blind to
# work that never reached it. Ten commits sat in worktrees for nineteen hours on
# 2026-08-23 and nothing noticed. An agent claiming a workspace is the most
# frequent moment anybody looks at this machine, so the scan happens here.
bash "$ROOT/scripts/check-unpushed-work.sh" --quiet 2>&1 | sed "s/^/# /" >&2 || true

# Share the main clone's dependencies. The alternative is an npm install per
# tree - minutes each, gigabytes across 47 trees - or a test gate that silently
# skips, which is how a red test reaches main and blocks the bundle for all.
# node_modules: a COPY-ON-WRITE CLONE, never a symlink.
#
# 2026-08-23. This used to be `ln -s`, and a symlink is not a safe thing to hand
# an agent, because npm WRITES THROUGH IT. `npm ci` deletes node_modules before
# reinstalling, so one `npm ci` in one worktree deleted the MAIN CLONE's install
# that all 79 trees share. tsc and vitest vanished everywhere at once, agents
# reasonably concluded their own tree was broken, and ran npm ci again - which
# is a loop that sustains itself. It gutted the shared tree three times in one
# afternoon, and two separate agents reported it independently.
#
# `cp -Rc` is an APFS clone: about five seconds, and copy-on-write, so it costs
# no real disk until something modifies it. Each tree now owns its node_modules
# outright, which means `npm ci` in a worktree is simply SAFE - the thing agents
# were doing all along.
if [ ! -e "$DIR/node_modules" ] && [ -d "$ROOT/node_modules" ]; then
  if cp -Rc "$ROOT/node_modules" "$DIR/node_modules" 2>/dev/null; then
    echo "# node_modules: cloned from the main clone (copy-on-write, ~5s, no extra disk)" >&2
  elif cp -R "$ROOT/node_modules" "$DIR/node_modules" 2>/dev/null; then
    # Not APFS. Slower and it really does use the disk, but still ISOLATED,
    # which is the property that matters.
    echo "# node_modules: copied from the main clone (no copy-on-write here)" >&2
  else
    echo "# node_modules: could not be provisioned - run npm ci in this tree" >&2
  fi
fi

echo "# worktree: $DIR" >&2
echo "# branch:   $BRANCH  (from origin/main)" >&2
if [ "$MODE" = "--print-path" ]; then
  echo "$DIR"
else
  echo "cd '$DIR'"
fi
