#!/usr/bin/env bash
# MAKE UNCOMMITTED WORK UNDESTROYABLE.
#
# Antigravity periodically runs `git reset --hard origin/main` on this Mac.
# Every rule in .agents/rules/ tries to make agents commit before that happens.
# Rules are the wrong layer for this: the loss occurs between two commits, at a
# moment nobody chose, and the agent that loses the work is usually mid-edit.
#
# So stop asking. This takes a snapshot of every working tree's uncommitted
# state and stores it as a real git ref, which `git reset --hard` cannot touch.
#
# WHY IT IS SAFE TO RUN AT ANY MOMENT, including mid-edit:
#   `git stash create` builds the commit objects and PRINTS the sha. It does
#   not write to the index, the working tree, or the stash stack. There is no
#   `stash pop` half of this, nothing to conflict with, and an agent working in
#   that tree cannot tell it ran. That is the entire reason this is a stash
#   CREATE and not a stash PUSH.
#
# WHAT IT COVERS, and what it deliberately does not:
#   covered  - tracked modifications and staged changes (`git stash create`)
#   covered  - local-only commits, snapshotted as their own ref so they survive
#              a reset that discards them from the branch
#   NOT      - untracked files. `git reset --hard` does not delete them either,
#              so they are not at risk from the loop this exists to survive.
#              `git clean -fd` would, and nothing here can help with that.
#
# Snapshots are LOCAL refs and are never pushed. They routinely contain .env
# files and half-finished credentials, and pushing them would put that history
# in the remote permanently.
#
#   bash scripts/agent-trees-snapshot.sh            # snapshot this repo's trees
#   bash scripts/agent-trees-snapshot.sh --list     # what has been captured
#   bash scripts/agent-trees-snapshot.sh --prune    # drop snapshots over 30d
set -uo pipefail

MODE="${1:-snapshot}"
KEEP_DAYS="${WIP_KEEP_DAYS:-30}"

ROOT=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || {
  echo "not a git repository" >&2; exit 2; }
ROOT=${ROOT%/.git}

# ── --list ─────────────────────────────────────────────────────────────────
if [ "$MODE" = "--list" ]; then
  echo "snapshots in $(basename "$ROOT"):"
  git -C "$ROOT" for-each-ref --sort=-committerdate \
    --format='  %(refname:short)  %(committerdate:relative)  %(contents:subject)' \
    refs/wip/ | head -60
  echo
  echo "restore one WITHOUT disturbing anything:"
  echo "  git -C <a-fresh-worktree> checkout -b rescue <refname>"
  echo "or just look:  git show <refname>   /   git diff <refname>^ <refname>"
  exit 0
fi

# ── --prune ────────────────────────────────────────────────────────────────
if [ "$MODE" = "--prune" ]; then
  CUTOFF=$(( $(date -u +%s) - KEEP_DAYS * 86400 ))
  N=0
  while read -r ts ref; do
    [ -n "$ref" ] || continue
    [ "$ts" -lt "$CUTOFF" ] || continue
    git -C "$ROOT" update-ref -d "$ref" && N=$((N+1))
  done < <(git -C "$ROOT" for-each-ref --format='%(committerdate:unix) %(refname)' refs/wip/)
  echo "pruned $N snapshot(s) older than ${KEEP_DAYS}d."
  exit 0
fi

# ── snapshot ───────────────────────────────────────────────────────────────
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TOTAL=0

while IFS= read -r line; do
  case "$line" in
    worktree\ *) DIR=${line#worktree } ;;
    branch\ *)   BR=${line#branch refs/heads/} ;;
    "")
      [ -n "${DIR:-}" ] || continue
      # printf, not echo: `basename x | tr -c ...` turns the trailing newline
      # into a dash and every ref came out as `cowork-snap-/...`.
      NAME=$(printf '%s' "$(basename "$DIR")" | tr -c 'A-Za-z0-9._-' '-')

      # 1. uncommitted tracked state
      if [ -n "$(git -C "$DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
        SNAP=$(git -C "$DIR" stash create "wip snapshot ${STAMP} (${BR:-detached})" 2>/dev/null || true)
        if [ -n "$SNAP" ]; then
          git -C "$ROOT" update-ref "refs/wip/${NAME}/${STAMP}" "$SNAP"
          FILES=$(git -C "$DIR" status --porcelain --untracked-files=no | wc -l | tr -d ' ')
          echo "captured  refs/wip/${NAME}/${STAMP}  (${FILES} file(s), branch ${BR:-detached})"
          TOTAL=$((TOTAL+1))
        fi
      fi

      # 2. commits that exist only here. A reset to origin/main drops them from
      #    the branch and leaves them reachable only from the reflog, which
      #    expires. A ref does not.
      if [ -n "${BR:-}" ]; then
        if git -C "$DIR" rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
          AHEAD=$(git -C "$DIR" rev-list --count '@{upstream}..HEAD' 2>/dev/null || echo 0)
        else
          AHEAD=$(git -C "$DIR" rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
        fi
        if [ "${AHEAD:-0}" -gt 0 ]; then
          HEADSHA=$(git -C "$DIR" rev-parse HEAD)
          SAFE_BR=$(printf '%s' "$BR" | tr -c 'A-Za-z0-9._-' '-')
          REF="refs/wip/${NAME}/branch-${SAFE_BR}"
          CUR=$(git -C "$ROOT" rev-parse -q --verify "$REF" 2>/dev/null || true)
          if [ "$CUR" != "$HEADSHA" ]; then
            git -C "$ROOT" update-ref "$REF" "$HEADSHA"
            echo "captured  ${REF}  (${AHEAD} unpushed commit(s) on ${BR})"
            TOTAL=$((TOTAL+1))
          fi
        fi
      fi
      DIR=""; BR=""
      ;;
  esac
done < <(git -C "$ROOT" worktree list --porcelain; echo)

if [ "$TOTAL" -eq 0 ]; then
  echo "nothing uncommitted or unpushed in $(basename "$ROOT") — nothing to capture."
else
  echo
  echo "$TOTAL snapshot(s) taken. They are LOCAL refs and are never pushed."
  echo "See them with:  bash scripts/agent-trees-snapshot.sh --list"
fi
