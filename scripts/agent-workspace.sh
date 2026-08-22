#!/usr/bin/env bash
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

echo "# worktree: $DIR" >&2
echo "# branch:   $BRANCH  (from origin/main)" >&2
if [ "$MODE" = "--print-path" ]; then
  echo "$DIR"
else
  echo "cd '$DIR'"
fi
