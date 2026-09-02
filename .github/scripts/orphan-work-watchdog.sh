#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  ORPHAN WORK WATCHDOG — no commit gets left behind
#
#  Dan, 2026-09-01: "HOW DO WE INSURE THAT NO WORK EVER GETS LOST, ORPHANED OR
#  NOT PUBLISHED? ... NO CODE, IMPROVEMENT, FIXES, OPTIMIZATIONS OR ANYTHING
#  ELSE IS LOST, ORPHANED OR UNPUBLISHED ANY WHERE EVER!"
#
#  The delivery pipeline already watches everything DOWNSTREAM of a merge:
#  publish-watchdog asks production which client bundle it serves,
#  engine-watchdog asks the engine which commit it runs, agent-autopilot
#  auto-merges any green pull request every ten minutes. What nothing watched
#  was the step BEFORE all of that: work that never became a merge at all.
#
#  Three ways work has actually been orphaned here:
#
#    1. A branch pushed with no pull request. The playbook says open the PR
#       and end the session; an agent that dies between the push and the PR
#       leaves commits on origin that nothing will ever merge. Silent forever.
#    2. A pull request that autopilot cannot merge - a merge conflict with a
#       branch that landed first ("dirty"), or a red check the author never
#       saw. Autopilot retries the mergeable ones; the dirty ones sit.
#    3. A draft PR forgotten after the work was finished.
#
#  This walks every branch and open PR and files ONE self-updating issue
#  naming each piece of stranded work and what would unstrand it. It never
#  merges, deletes, or rebases anything itself: judging whether a conflicted
#  branch is still wanted takes a human or the agent that wrote it. Loud and
#  precise beats silent and helpful here - an automated fixer that guesses
#  wrong about a conflict destroys exactly the work it was guarding.
#
#  Stale-but-pushed worktree branches (prune-stale-worktrees.sh) lose nothing:
#  the commits live on origin, which is where this watchdog looks.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
ISSUE_TITLE="Orphan work watchdog: commits exist that nothing will ever publish"
# A branch is not orphaned while its author might still be mid-session.
MIN_AGE_HOURS="${MIN_AGE_HOURS:-3}"
# Branches that are allowed to trail main forever.
EXEMPT_RE='^(main|master|gh-pages|backup/|_rescue|dependabot/)'

say() { printf '%s\n' "$*"; }

NOW=$(date -u +%s)
CUTOFF=$(( NOW - MIN_AGE_HOURS * 3600 ))
ORPHANS=""
COUNT=0

# ── 1. Branches ahead of main with no open pull request ─────────────────────
# Paginated: this repo runs hundreds of agent branches.
BRANCHES=$(gh api --paginate "repos/$REPO/branches?per_page=100" \
  --jq '.[].name' 2>/dev/null || true)
OPEN_PR_HEADS=$(gh pr list --repo "$REPO" --state open --limit 200 \
  --json headRefName --jq '.[].headRefName' 2>/dev/null || true)

for BR in $BRANCHES; do
  case "$BR" in main|master) continue ;; esac
  printf '%s' "$BR" | grep -qE "$EXEMPT_RE" && continue
  # Already has an open PR? Autopilot's problem, checked in pass 2.
  printf '%s\n' "$OPEN_PR_HEADS" | grep -qxF "$BR" && continue

  CMP=$(gh api "repos/$REPO/compare/main...$BR" \
    --jq '{ahead: .ahead_by, at: .commits[-1].commit.committer.date}' 2>/dev/null || echo "")
  [ -z "$CMP" ] && continue
  AHEAD=$(printf '%s' "$CMP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("ahead") or 0)' 2>/dev/null || echo 0)
  [ "$AHEAD" -eq 0 ] && continue
  LAST=$(printf '%s' "$CMP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("at") or "")' 2>/dev/null || echo "")
  LAST_EPOCH=$(date -d "$LAST" +%s 2>/dev/null || date -jf '%Y-%m-%dT%H:%M:%SZ' "$LAST" +%s 2>/dev/null || echo 0)
  [ "$LAST_EPOCH" -eq 0 ] && continue
  [ "$LAST_EPOCH" -gt "$CUTOFF" ] && continue   # author may still be working

  COUNT=$((COUNT+1))
  ORPHANS="$ORPHANS
- **Branch \`$BR\`** is $AHEAD commit(s) ahead of main with **no pull request**, last touched $LAST. Nothing will ever merge it. Open a PR (\`gh pr create --head $BR\`) or state that it is abandoned."
done

# ── 2. Open pull requests that autopilot cannot land ────────────────────────
PRS=$(gh pr list --repo "$REPO" --state open --limit 200 \
  --json number,title,mergeable,isDraft,updatedAt \
  --jq '.[] | [.number, .mergeable, .isDraft, .updatedAt, .title] | @tsv' 2>/dev/null || true)

while IFS=$'\t' read -r NUM MERGEABLE DRAFT UPDATED TITLE; do
  [ -z "${NUM:-}" ] && continue
  UP_EPOCH=$(date -d "$UPDATED" +%s 2>/dev/null || date -jf '%Y-%m-%dT%H:%M:%SZ' "$UPDATED" +%s 2>/dev/null || echo 0)
  [ "$UP_EPOCH" -gt "$CUTOFF" ] && continue
  if [ "$MERGEABLE" = "CONFLICTING" ]; then
    COUNT=$((COUNT+1))
    ORPHANS="$ORPHANS
- **PR #$NUM** (\"$TITLE\") has a **merge conflict** and has sat for over ${MIN_AGE_HOURS}h. Autopilot cannot land it; it needs \`git merge origin/main\` and a conflict resolution by its author."
  elif [ "$DRAFT" = "true" ]; then
    COUNT=$((COUNT+1))
    ORPHANS="$ORPHANS
- **PR #$NUM** (\"$TITLE\") is a **draft** untouched for over ${MIN_AGE_HOURS}h. Autopilot ignores drafts; mark it ready or close it."
  fi
done <<EOF_PRS
$PRS
EOF_PRS

# ── 3. File or resolve the issue ────────────────────────────────────────────
EXISTING=$(gh issue list --repo "$REPO" --state open --limit 100 --json number,title \
  --jq "[.[] | select(.title == \"$ISSUE_TITLE\")] | .[0].number // empty" 2>/dev/null || true)

if [ "$COUNT" -eq 0 ]; then
  if [ -n "${EXISTING:-}" ]; then
    gh issue comment "$EXISTING" --repo "$REPO" --body "Every branch and open PR is either merged, in flight, or younger than ${MIN_AGE_HOURS}h. Nothing is stranded. Closing." >/dev/null 2>&1 || true
    gh issue close "$EXISTING" --repo "$REPO" >/dev/null 2>&1 || true
    say "recovered - closed #$EXISTING"
  else
    say "nothing stranded"
  fi
  exit 0
fi

BODY="The hourly restart pipeline publishes whatever is ON main - it cannot publish work that never reaches main. The following work is currently stranded upstream of every watchdog:
$ORPHANS

**What each needs** is listed beside it. This issue updates itself: it closes on the first sweep that finds nothing stranded.

*Filed by orphan-work-watchdog.sh (runs with publish-watchdog). It never merges or deletes anything itself - judging whether a conflicted branch is still wanted takes its author.*"

if [ -n "${EXISTING:-}" ]; then
  gh issue comment "$EXISTING" --repo "$REPO" --body "$BODY" >/dev/null 2>&1 \
    && say "updated #$EXISTING ($COUNT stranded)" \
    || say "::error::could not update the orphan-work issue - $COUNT piece(s) of work are stranded and nobody was told."
else
  gh issue create --repo "$REPO" --title "$ISSUE_TITLE" --body "$BODY" >/dev/null 2>&1 \
    && say "filed issue ($COUNT stranded)" \
    || say "::error::could not file the orphan-work issue - $COUNT piece(s) of work are stranded and nobody was told."
fi
