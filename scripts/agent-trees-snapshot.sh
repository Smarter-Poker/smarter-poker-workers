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
#   bash scripts/agent-trees-snapshot.sh --dedupe   # drop snapshots identical to a newer one
#
# Retention: a snapshot is only written when the tree actually changed, so an
# idle worktree costs nothing and --prune's 30d window is about age, not volume.
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

# ── --dedupe ───────────────────────────────────────────────────────────────
# Collapses snapshots that are byte-identical to a newer one. Keeps the newest
# ref for every distinct (worktree, tree) pair and every branch-* ref, so no
# distinct content is ever dropped. Safe to run at any time; use it once after
# adopting the dedupe above to clear a namespace that already exploded.
#
# ONE PASS, added 2026-08-26 the same day the first version shipped. That
# version ran `git rev-parse` once per ref inside a while-read loop. At the
# 9,661 refs one clone was carrying, that is 9,661 process spawns and it does
# not finish in any useful time - the tool meant to clean up an exploded
# namespace could not be used on one. Everything below is four processes total,
# whatever the ref count: for-each-ref, cat-file --batch-check, sort, awk.
if [ "$MODE" = "--dedupe" ]; then
  BEFORE=$(git -C "$ROOT" for-each-ref --format='%(refname)' refs/wip/ | wc -l | tr -d ' ')
  TMP=$(mktemp -d) || { echo "could not create a temp dir" >&2; exit 1; }
  trap 'rm -rf "$TMP"' EXIT

  # branch-* refs point at HEAD commits, not stash commits, and are never dropped.
  git -C "$ROOT" for-each-ref --format='%(refname) %(objectname)' refs/wip/ \
    | grep -v '/branch-' > "$TMP/refs" || true

  if [ ! -s "$TMP/refs" ]; then
    echo "nothing to dedupe. refs/wip holds ${BEFORE} ref(s)."
    exit 0
  fi

  # Resolve every commit to its tree in a single batch process.
  cut -d' ' -f2 "$TMP/refs" | sed 's/$/^{tree}/' \
    | git -C "$ROOT" cat-file --batch-check='%(objectname)' > "$TMP/trees"

  # A mismatch means cat-file skipped or added a line (a missing object prints
  # "<input> missing"). Deleting refs against misaligned trees would drop
  # distinct snapshots, so refuse rather than guess.
  if [ "$(wc -l < "$TMP/refs")" -ne "$(wc -l < "$TMP/trees")" ] \
     || grep -q ' missing$' "$TMP/trees"; then
    echo "refusing to dedupe: could not resolve every snapshot to a tree" >&2
    exit 1
  fi

  # key = <worktree>/<tree>. Sorting descending puts the newest refname first
  # in each group (refnames end in an ISO-8601 stamp), and awk deletes the rest.
  paste -d' ' "$TMP/refs" "$TMP/trees" \
    | awk '{ split($1, p, "/"); print p[3] "/" $3 "\t" $1 }' \
    | sort -r \
    | awk -F'\t' 'seen[$1]++ { print "delete " $2 }' \
    | git -C "$ROOT" update-ref --stdin

  AFTER=$(git -C "$ROOT" for-each-ref --format='%(refname)' refs/wip/ | wc -l | tr -d ' ')
  echo "deduped ${BEFORE} -> ${AFTER} ref(s); every distinct snapshot kept."
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
          # DEDUPE, added 2026-08-26. This block wrote a new timestamped ref on
          # EVERY run whether or not the tree had changed, while the local-commit
          # block below has always compared against the existing ref first. Run
          # from launchd every 10 minutes across ~250 worktrees, that reached
          # 63,322 refs in club-arena and 31,011 in the World Hub within days --
          # 94,333 refs holding 1,282 distinct snapshots. packed-refs passed 5MB
          # and produced a transient "unterminated line in .git/packed-refs" that
          # broke ordinary git commands.
          #
          # An identical snapshot is not a second copy of the work, it is the
          # same object with another name. Compare the TREE against the newest
          # snapshot already held for this worktree and skip when it matches.
          # branch-* refs are excluded from the comparison: they point at HEAD
          # commits, not stash commits, and have their own dedupe below.
          NEWTREE=$(git -C "$ROOT" rev-parse -q --verify "${SNAP}^{tree}" 2>/dev/null || true)
          LASTREF=$(git -C "$ROOT" for-each-ref --sort=-refname \
                      --format='%(refname)' "refs/wip/${NAME}/" 2>/dev/null \
                    | grep -v "/branch-" | head -1)
          LASTTREE=""
          [ -n "$LASTREF" ] && LASTTREE=$(git -C "$ROOT" rev-parse -q --verify "${LASTREF}^{tree}" 2>/dev/null || true)

          if [ -n "$NEWTREE" ] && [ "$NEWTREE" = "$LASTTREE" ]; then
            : # unchanged since the last snapshot - the existing ref already holds it
          else
            git -C "$ROOT" update-ref "refs/wip/${NAME}/${STAMP}" "$SNAP"
            FILES=$(git -C "$DIR" status --porcelain --untracked-files=no | wc -l | tr -d ' ')
            echo "captured  refs/wip/${NAME}/${STAMP}  (${FILES} file(s), branch ${BR:-detached})"
            TOTAL=$((TOTAL+1))
          fi
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
