#!/usr/bin/env bash
# REFUSE A COMMIT OR A PUSH MADE IN THE SHARED CLONE.
#
# Rule 1a (.agents/rules/00-anti-regression-workflow.md) says one working tree
# per agent. It has been advisory, and advisory did not hold: the clone was
# carrying EIGHT abandoned stashes and SIX backup/* branches from
# git-unstick.sh rescues, and the World Hub clone had twelve ad-hoc worktrees
# under /private/tmp - agents inventing isolation by hand because nothing gave
# it to them.
#
# WHY A SHARED CHECKOUT DESTROYS WORK, precisely: a working tree has exactly
# one HEAD, one index and one set of uncommitted files. When agent B runs
# `git checkout -b`, agent A's in-progress edits either ride onto B's branch or
# are stashed out from under it, and NEITHER AGENT IS TOLD. Then the
# Antigravity `git reset --hard origin/main` loop deletes whatever is still
# uncommitted at that moment. Branch protection cannot help: all of this
# happens before anything is pushed.
#
# 2026-08-23: this now runs on pre-push as well. Commit-only left a hole big
# enough to lose a session in. An agent that edits here but never COMMITS here
# is never spoken to - and that is the common shape, because the work is
# destroyed by somebody else's checkout or a bare `git reset --hard` long
# before it reaches a commit. Refusing the push too means the agent hears about
# it the first time it tries to do anything durable.
#
# WHAT THIS DOES NOT DO: it never stashes, never checks anything out, never
# moves you. Moving an agent off its own uncommitted work is the exact
# destruction being prevented - so this refuses, explains, and stops.

set -euo pipefail

# WHAT is being refused. pre-commit passes nothing (the default); pre-push
# passes "push". Only the wording changes - the rule is identical, because the
# danger is the shared TREE, not which command you reached for.
ACTION=${1:-commit}
case "$ACTION" in
  push) ACTION_UC="PUSH"; ACTION_EG="git push" ;;
  *)    ACTION_UC="COMMIT"; ACTION_EG="git commit" ;;
esac

# ── Legitimate commits in the main clone ────────────────────────────────────
# scripts/git-safe-push.sh, the World Hub sync and any CI checkout all commit
# in the one-and-only tree on purpose. They set this explicitly rather than
# being pattern-matched, so the exemption is always visible at the call site.
if [ "${AGENT_SHARED_CLONE_OK:-}" = "1" ]; then
  exit 0
fi

# A runner's checkout is a fresh throwaway clone with exactly one consumer, so
# the failure mode this guards does not exist there.
if [ -n "${CI:-}" ] || [ -n "${GITHUB_ACTIONS:-}" ]; then
  exit 0
fi

GIT_DIR=$(git rev-parse --path-format=absolute --git-dir 2>/dev/null || echo "")
COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "")

# Unknown shape (older git, odd setup) - never block on a check that cannot
# tell where it is.
if [ -z "$GIT_DIR" ] || [ -z "$COMMON_DIR" ]; then
  exit 0
fi

# A linked worktree has its own git dir under <common>/worktrees/<name>.
# They are equal only in the shared clone itself.
if [ "$GIT_DIR" != "$COMMON_DIR" ]; then
  exit 0
fi

REPO_ROOT=${COMMON_DIR%/.git}
REPO=$(basename "$REPO_ROOT")
BRANCH=$(git branch --show-current 2>/dev/null || echo "HEAD")
AGENT=${AGENT_NAME:-$(whoami)}
# The slug the agent is most likely to want: whatever branch they are on.
SLUG=$(printf '%s' "${BRANCH:-fix/your-change}" | sed 's#^agent/[^/]*/##')
[ -n "$SLUG" ] && [ "$SLUG" != "main" ] || SLUG="fix/describe-your-change"

cat >&2 <<MSG

  ─────────────────────────────────────────────────────────────────────────
  $ACTION_UC REFUSED - this is the shared clone, not your working tree.

    $REPO_ROOT   (branch: ${BRANCH:-detached})

  Three to five agents work in this repo at once and a working tree has one
  HEAD, one index and one set of uncommitted files. Working here puts your
  work in the path of the next agent's checkout and of the Antigravity
  \`git reset --hard origin/main\` loop. Nothing warns either of you.

  Your work is untouched. Claim your own tree and it comes with you:

      eval "\$(bash scripts/agent-workspace.sh $AGENT $SLUG)"

  That script REFUSES to move a tree that has uncommitted changes, so run it,
  then copy your edited files across and commit there.

  If you are a human working in your own clone, or a script that legitimately
  commits here (git-safe-push.sh, the World Hub sync, CI):

      AGENT_SHARED_CLONE_OK=1 $ACTION_EG ...

  Do not reach for --no-verify. It skips the other hooks too, and every one of
  them is here because something was lost.
  ─────────────────────────────────────────────────────────────────────────

MSG
exit 1
