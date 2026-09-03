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
#       (This case was WRITTEN but never fired until 2026-09-03 - see the
#       pass itself for why, and for what thirty-one stranded pull requests
#       were sitting unreported behind it.)
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
# `ci-marker/` joins the list 2026-09-03: that namespace is not work. It is
# where agent-open-pr.yml force-pushes its own result log as an ORPHAN commit
# (`git checkout --orphan`, one text file). It is ahead of main by
# construction, forever, and reporting it as stranded work is noise that
# crowds out the findings a human would act on.
EXEMPT_RE='^(main|master|gh-pages|backup/|_rescue|dependabot/|ci-marker/)'

say() { printf '%s\n' "$*"; }

NOW=$(date -u +%s)
CUTOFF=$(( NOW - MIN_AGE_HOURS * 3600 ))
# TWO STREAMS, AND THE ACTIONABLE ONE IS NOT THE ONE THAT GETS TRUNCATED
# (2026-09-03). There is one detail cap (MAX_DETAIL, for GitHub's 65536-char
# issue body) and the branch pass runs first, so on this repo - 428 stranded
# branches, most of them April `sentry-autofix/*` and August `rescue/*` - the
# branch findings filled all forty slots and anything the pull-request pass
# found was appended after the cutoff and silently dropped.
#
# A conflicted pull request is FINISHED work one rebase from shipping. A
# branch with no PR may be an abandoned attempt. They are not the same
# urgency, so they no longer share a queue: PR findings are listed first and
# in full, branches take what detail room is left.
PR_ORPHANS=""
PR_COUNT=0
ORPHANS=""
COUNT=0

# ── 1. Branches ahead of main with no open pull request ─────────────────────
# Paginated: this repo runs hundreds of agent branches.
# THE BRANCH WALK IS LOCAL (2026-09-03). This used to call
# `gh api compare/main...$BR` once per branch, plus two python processes per
# branch, for every branch in the repository. With ~400 branches (July and
# August `patch/*` and `rescue/*` included) that is over six minutes, which is
# the job's timeout: every scheduled watchdog run since 2026-09-02 19:17 died
# of SIGTERM in this loop, was recorded as "cancelled", and never reached the
# stuck-PR pass below. The workflow checks main out with full history, so
# every question here is answerable by git in a few seconds with no API at all.
git fetch -q origin '+refs/heads/*:refs/remotes/origin/*' 2>/dev/null || true

# THE PULL-REQUEST LIST IS NOT OPTIONAL (2026-09-03). It is the difference
# between "stranded" and "proposed". When it cannot be read, nothing below can
# be trusted: every proposed branch reads as unproposed, and the conflicted-PR
# pass finds nothing. That is what every run of this sweep had done in the two
# repos whose workflow granted the token no `pull-requests: read`: the last
# one filed 416 "branches with no pull request", 148 of which had one, and 0
# stuck pull requests, while 16 sat conflicted. A list that fails is an error,
# spoken, and the sweep stops rather than filing fiction with a green step.
if ! OPEN_PR_HEADS=$(gh pr list --repo "$REPO" --state open --limit 200 \
  --json headRefName --jq '.[].headRefName' 2>&1); then
  say "::error::could not list open pull requests: $OPEN_PR_HEADS"
  say "::error::the token needs pull-requests: read. Without the list this sweep cannot tell stranded from proposed, so it reports nothing rather than everything."
  exit 1
fi
MAIN_TREES=$(git log -200 --format=%T origin/main 2>/dev/null || true)
while read -r BR LAST_EPOCH LAST; do
  [ -z "${BR:-}" ] && continue
  case "$BR" in main|master|HEAD) continue ;; esac
  printf '%s' "$BR" | grep -qE "$EXEMPT_RE" && continue
  printf '%s\n' "$OPEN_PR_HEADS" | grep -qxF "$BR" && continue
  AHEAD=$(git rev-list --count "origin/main..origin/$BR" 2>/dev/null || echo 0)
  [ "$AHEAD" -eq 0 ] && continue
  TREE=$(git rev-parse "origin/$BR^{tree}" 2>/dev/null || echo "")
  if [ -n "$TREE" ] && printf '%s\n' "$MAIN_TREES" | grep -qxF "$TREE"; then
    continue  # this exact tree is on main: the content shipped under another sha
  fi
  [ "${LAST_EPOCH:-0}" -eq 0 ] && continue
  [ "$LAST_EPOCH" -gt "$CUTOFF" ] && continue   # author may still be working
  COUNT=$((COUNT+1))
  say "stranded: branch $BR ($AHEAD ahead, last touched $LAST, no PR)"
  ORPHANS="$ORPHANS
- **Branch \`$BR\`** is $AHEAD commit(s) ahead of main with **no pull request**, last touched $LAST. Nothing will ever merge it. Open a PR (\`gh pr create --head $BR\`) or state that it is abandoned."
done <<EOF_BRANCHES
$(git for-each-ref refs/remotes/origin --format='%(refname:lstrip=3) %(committerdate:unix) %(committerdate:iso-strict)' 2>/dev/null)
EOF_BRANCHES

# Everything counted so far is a branch; the pull-request pass adds to COUNT
# after this line.
COUNT_BRANCHES=$COUNT

# ── 2. Open pull requests that cannot land ──────────────────────────────────
#
# THIS PASS HAD NEVER ONCE FIRED (found 2026-09-03). It asked `gh pr list` for
# `mergeable` and compared it to "CONFLICTING". GitHub does not compute
# mergeability for a LIST query - it computes it lazily, when a single pull
# request is fetched - so the field comes back UNKNOWN (REST: `null`) for
# every row, every time. Measured on this repo the same day: all 100 open
# pull requests reported `mergeable_state: null` from the list, and the very
# same PRs fetched one at a time reported `dirty` - #2548 had been conflicted
# and stranded since 2026-09-02, #2842 and #2838 since that morning.
#
# So the watchdog reported 428 branches and ZERO pull requests, while the
# conflicted pull requests - finished work, one rebase from shipping, exactly
# what case 2 in this file's header promises to catch - sat unreported.
#
# Fetching each pull request individually is what forces the computation. It
# costs one API call per open PR past the cutoff, and GitHub answers `null`
# while it is still thinking, so a `null` is retried once after a short pause
# rather than being read as "fine".
if ! PRS=$(gh pr list --repo "$REPO" --state open --limit 200 \
  --json number,title,isDraft,updatedAt \
  --jq '.[] | [.number, .isDraft, .updatedAt, .title] | @tsv' 2>&1); then
  say "::error::could not list open pull requests for the stuck-PR pass: $PRS"
  exit 1
fi

# A bound on the API work, so this pass can never be the reason the job is
# killed the way the branch walk was on 2026-09-02. Oldest first - the ones
# that have been stranded longest are the ones worth the call.
MAX_PR_PROBES="${MAX_PR_PROBES:-80}"
PROBED=0

while IFS=$'\t' read -r NUM DRAFT UPDATED TITLE; do
  [ -z "${NUM:-}" ] && continue
  UP_EPOCH=$(date -d "$UPDATED" +%s 2>/dev/null || date -jf '%Y-%m-%dT%H:%M:%SZ' "$UPDATED" +%s 2>/dev/null || echo 0)
  [ "$UP_EPOCH" -gt "$CUTOFF" ] && continue

  # A draft needs no probe: autopilot ignores drafts whatever their mergeability.
  if [ "$DRAFT" = "true" ]; then
    PR_COUNT=$((PR_COUNT+1))
    say "stranded: PR #$NUM stale draft ($TITLE)"
    PR_ORPHANS="$PR_ORPHANS
- **PR #$NUM** (\"$TITLE\") is a **draft** untouched for over ${MIN_AGE_HOURS}h. Autopilot ignores drafts; mark it ready or close it."
    continue
  fi

  [ "$PROBED" -ge "$MAX_PR_PROBES" ] && continue
  PROBED=$((PROBED+1))
  STATE=$(gh api "repos/$REPO/pulls/$NUM" --jq '.mergeable_state // "unknown"' 2>/dev/null || echo unknown)
  if [ "$STATE" = "unknown" ]; then
    sleep 2
    STATE=$(gh api "repos/$REPO/pulls/$NUM" --jq '.mergeable_state // "unknown"' 2>/dev/null || echo unknown)
  fi

  # `dirty` is the REST spelling of CONFLICTING. Every other state - blocked
  # (waiting on checks), behind, unstable, clean - is autopilot's job, not a
  # stranding, and `unknown` after two asks is GitHub being slow rather than
  # evidence of anything.
  if [ "$STATE" = "dirty" ]; then
    PR_COUNT=$((PR_COUNT+1))
    say "stranded: PR #$NUM conflicting ($TITLE)"
    PR_ORPHANS="$PR_ORPHANS
- **PR #$NUM** (\"$TITLE\") has a **merge conflict** and has sat for over ${MIN_AGE_HOURS}h. Autopilot cannot land it; it needs \`git merge origin/main\` and a conflict resolution by its author."
  fi
done <<EOF_PRS
$PRS
EOF_PRS

COUNT=$((COUNT + PR_COUNT))

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

# GitHub caps an issue body at 65536 characters; the first World Hub sweep
# built one past the cap from 249 findings and the create was refused - the
# one failure mode this watchdog exists to prevent (stranded work nobody was
# told about). Cap the detail list and summarize the overflow: a reader acts
# on the first forty items the same way they would act on all of them.
# The pull-request findings are listed FIRST and never truncated: they are
# finished work one rebase from shipping, and there are only ever a handful.
# The branch findings take whatever detail room is left. Before 2026-09-03 the
# two shared one queue and the branches - 428 of them, most from April and
# August - filled it entirely.
MAX_DETAIL=40
BRANCH_ROOM=$(( MAX_DETAIL - PR_COUNT ))
[ "$BRANCH_ROOM" -lt 5 ] && BRANCH_ROOM=5
if [ "$COUNT_BRANCHES" -gt "$BRANCH_ROOM" ]; then
  ORPHANS=$(printf '%s\n' "$ORPHANS" | awk -v n="$BRANCH_ROOM" '/^- /{c++} c<=n')
  ORPHANS="$ORPHANS

...and $(( COUNT_BRANCHES - BRANCH_ROOM )) more branches not listed - the run log of this sweep names every one."
fi

BODY="The hourly restart pipeline publishes whatever is ON main - it cannot publish work that never reaches main. The following work is currently stranded upstream of every watchdog ($COUNT piece(s) total: $PR_COUNT pull request(s), $COUNT_BRANCHES branch(es)).

### Pull requests that cannot land
A conflicted pull request is finished work that only needs \`git merge origin/main\` and a conflict resolution. These are listed in full.
${PR_ORPHANS:-
- none}

### Branches with no pull request
$ORPHANS

**What each needs** is listed beside it. This issue updates itself: it closes on the first sweep that finds nothing stranded.

*Filed by orphan-work-watchdog.sh (runs with publish-watchdog). It never merges or deletes anything itself - judging whether a conflicted branch is still wanted takes its author.*"

# Failures speak: swallowing stderr here is how 249 stranded pieces went
# unreported with a green step beside them.
if [ -n "${EXISTING:-}" ]; then
  ERR=$(gh issue comment "$EXISTING" --repo "$REPO" --body "$BODY" 2>&1 >/dev/null) \
    && say "updated #$EXISTING ($COUNT stranded: $PR_COUNT PR(s), $COUNT_BRANCHES branch(es))" \
    || say "::error::could not update the orphan-work issue ($ERR) - $COUNT piece(s) of work are stranded and nobody was told."
else
  ERR=$(gh issue create --repo "$REPO" --title "$ISSUE_TITLE" --body "$BODY" 2>&1 >/dev/null) \
    && say "filed issue ($COUNT stranded: $PR_COUNT PR(s), $COUNT_BRANCHES branch(es))" \
    || say "::error::could not file the orphan-work issue ($ERR) - $COUNT piece(s) of work are stranded and nobody was told."
fi
