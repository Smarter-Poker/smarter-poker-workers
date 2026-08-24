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

echo
echo "--- Checking Production Pipeline ---"
# Dan/estate 2026-08-24: this URL is CLUB ARENA's published bundle, and the sha
# it carries is keyed `ca_sha`. This script is supposed to be byte-identical in
# all seven repos, so hardcoding it meant that in any OTHER repo the section
# below fetched club-arena's build-info, compared club-arena's sha against THAT
# repo's origin/main, found a mismatch every single time, and reported a false
# "ORPHANED PUBLISH" while incrementing AT_RISK. A guard that cries wolf in six
# of seven repos is a guard people learn to ignore.
#
# Derive it from the remote instead. Repos with no published bundle skip the
# section entirely rather than being told their publish is broken.
BUILD_INFO_URL=""
case "$(git -C "$ROOT" config --get remote.origin.url 2>/dev/null || echo "")" in
  *Smarter-Poker-Club-Arena*) BUILD_INFO_URL="https://smarter.poker/hub/club-arena/build-info.json" ;;
esac
if [ -z "$BUILD_INFO_URL" ]; then
  echo "SKIP: this repo publishes no bundle of its own - nothing to compare."
else
NOW=$(date -u +%s)
SERVED_JSON=$(curl -fsSL -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' "${BUILD_INFO_URL}?cb=${NOW}" 2>/dev/null || true)
if [ -n "$SERVED_JSON" ]; then
  SERVED_SHA=$(printf '%s' "$SERVED_JSON" | sed -n 's/.*"ca_sha"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' || true)
  HEAD_SHA=$(git -C "$ROOT" rev-parse origin/main 2>/dev/null || true)
  if [ -n "$SERVED_SHA" ] && [ -n "$HEAD_SHA" ]; then
    if [ "$SERVED_SHA" = "$HEAD_SHA" ]; then
      echo "OK: Production is serving origin/main ($HEAD_SHA)."
    else
      echo "WARNING: Production ($SERVED_SHA) is NOT serving origin/main ($HEAD_SHA)."
      if git -C "$ROOT" merge-base --is-ancestor "$SERVED_SHA" "$HEAD_SHA" 2>/dev/null; then
        echo "State: Lagging (Publish in flight or failed)."
      else
        echo "State: ORPHANED PUBLISH. Production is not an ancestor of main."
        AT_RISK=$((AT_RISK + 1))
      fi
    fi
  else
    echo "WARNING: Could not parse SHAs."
  fi
else
    echo "WARNING: Could not read $BUILD_INFO_URL"
  fi
fi


if [ "$AT_RISK" -gt 0 ]; then
  echo
  echo "FAIL: $AT_RISK issue(s) detected. Production is orphaned or local trees hold unpushed work."
  exit 1
fi
echo "SUCCESS: Everything is pushed, committed, and safely deployed."
