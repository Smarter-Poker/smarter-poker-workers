#!/usr/bin/env bash
# WHAT IS ONE `git reset --hard` AWAY FROM BEING GONE.
#
# Antigravity periodically runs `git reset --hard origin/main` on this Mac.
# Anything uncommitted at that instant is destroyed, and a local-only commit is
# recoverable only from the reflog and only briefly. Per-agent worktrees stop
# agents from overwriting EACH OTHER, but they do not stop an agent from
# leaving hours of work sitting in a tree nobody looks at.
#
# This is the look. Read-only: it never commits, stashes, pushes or deletes.
#
#   bash scripts/agent-trees-audit.sh          # every tree of this repo
#   bash scripts/agent-trees-audit.sh --quiet  # print only trees at risk
#
# Exit code is 1 when anything is at risk, so it can drive a scheduled task.

set -uo pipefail

QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

ROOT=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || {
  echo "not a git repository" >&2; exit 2; }
ROOT=${ROOT%/.git}

AT_RISK=0

while IFS= read -r line; do
  case "$line" in
    worktree\ *) DIR=${line#worktree } ;;
    branch\ *)   BR=${line#branch refs/heads/} ;;
    "")
      [ -n "${DIR:-}" ] || continue
      DIRTY=$(git -C "$DIR" status --porcelain 2>/dev/null | wc -l | tr -d ' ')

      # Unpushed: commits on this branch with no upstream copy. A branch with
      # no upstream at all counts every commit it does not share with main.
      if git -C "$DIR" rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
        AHEAD=$(git -C "$DIR" rev-list --count '@{upstream}..HEAD' 2>/dev/null || echo 0)
      else
        AHEAD=$(git -C "$DIR" rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
      fi

      # Age of the newest uncommitted edit, which is the number that matters:
      # a tree dirty for six hours is six hours of work with no copy anywhere.
      AGE="-"
      if [ "$DIRTY" -gt 0 ]; then
        NEWEST=$(git -C "$DIR" status --porcelain 2>/dev/null | sed 's/^...//' \
          | while IFS= read -r f; do [ -f "$DIR/$f" ] && stat -f %m "$DIR/$f" 2>/dev/null; done \
          | sort -rn | head -1)
        [ -n "$NEWEST" ] && AGE="$(( ( $(date +%s) - NEWEST ) / 60 ))m ago"
      fi

      RISK=0
      [ "$DIRTY" -gt 0 ] && RISK=1
      [ "${AHEAD:-0}" -gt 0 ] && RISK=1
      [ "$RISK" = 1 ] && AT_RISK=$((AT_RISK + 1))

      if [ "$RISK" = 1 ] || [ "$QUIET" = 0 ]; then
        printf '%s  %s\n' "$([ "$RISK" = 1 ] && echo 'AT RISK ' || echo 'clean   ')" "$DIR"
        printf '            branch %s | %s uncommitted (last edit %s) | %s unpushed commit(s)\n' \
          "${BR:-detached}" "$DIRTY" "$AGE" "${AHEAD:-0}"
      fi
      DIR=""; BR=""
      ;;
  esac
done < <(git -C "$ROOT" worktree list --porcelain; echo)

echo
if [ "$AT_RISK" -gt 0 ]; then
  echo "$AT_RISK tree(s) hold work that exists in exactly one place."
  echo "Commit and push them - open the PR and stop, Autopilot merges it."
  exit 1
fi
echo "Every tree is committed and pushed. Nothing would be lost by a reset."
