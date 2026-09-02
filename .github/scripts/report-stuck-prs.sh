#!/usr/bin/env bash
# A PULL REQUEST NOBODY IS COMING BACK FOR.
#
# Autopilot merges anything that CAN merge. What it does with the rest is print
# a line into a run log and move on:
#
#   #33 (fix/x): conflicts with main — an agent must resolve this.
#
# No agent is watching that log. The PR stays open, the work never ships, and
# from the outside that is identical to the feature having regressed — which is
# the complaint this whole system exists to answer. PepNationLab was carrying
# six DIRTY pull requests when this was written, the oldest long cold, and
# nothing anywhere said so.
#
# So the sweep now names them. One issue per repo, updated in place, closed the
# moment the list empties, so it reads as a live indicator and not a backlog.
#
# Three ways a PR gets stuck, and they need different answers:
#
#   DIRTY          real conflict. Autopilot must not touch it: refreshing a
#                  conflicted branch churns CI, and resolving it by taking one
#                  whole side is how the leaderboard RPC call disappeared while
#                  its signature survived. A human or an agent resolves it hunk
#                  by hunk.
#   CHECKS RED     a required check failed. Waiting does nothing. Read the
#                  check and fix the code - never reach for a flag that makes
#                  the check stop applying.
#   NO CHECKS      nothing ever reported. Usually a branch cut before the
#                  workflow existed, or a required context that no job produces.
#                  This one is the quiet killer: the PR waits forever for a
#                  check that will never arrive, and the UI just says "pending".
#
# AND A FOURTH, which has no pull request to be stuck on: a branch that was
# pushed and then never asked to merge. Autopilot cannot queue what does not
# exist, so these are invisible to every other guard here. Club Arena was
# carrying 28 of them behind 204 remote branches, including
# `sweep-4-engine-fixes` (13 commits) and `fix/members-loop-and-union-wallet`
# (9 commits: ban buttons wired, leaderboard period navigation, a DB view
# change). Real work, pushed, and never once proposed.
#
# For an `agent/*` branch younger than a day this is unambiguous - that
# namespace is created by scripts/agent-workspace.sh for the express purpose of
# becoming a pull request - so one is opened automatically. Anything older or
# outside that namespace is reported, never auto-opened: a months-old branch
# auto-merged onto main is a regression, not a rescue.
#
# Env: GH_TOKEN, REPO. Optional STUCK_AFTER_H (default 3).
set -uo pipefail

REPO="${REPO:?}"
STUCK_AFTER_H="${STUCK_AFTER_H:-3}"
TITLE="Agent Autopilot: pull requests that cannot merge on their own"
NOW=$(date -u +%s)

echo "report-stuck-prs: scanning $REPO (stuck after ${STUCK_AFTER_H}h)"

# EVERY WRITE GOES THROUGH HERE, and this function exists because of what it
# replaces. The first version ended each write with
#
#     gh issue create ... >/dev/null 2>&1 && echo "opened an issue"
#
# so a failed write produced NOTHING - no error, no message, and a step that
# still reported success. The very first live run in PepNationLab found six
# stuck pull requests, could not create the issue, and printed 53 seconds of
# silence. A guard that fails quietly is worse than no guard: it occupies the
# place where a working one would go.
#
# That is the same anti-pattern this whole file is here to expose, written into
# the file itself. So: capture, and say so.
# ISSUE WRITES USE A DIFFERENT TOKEN ON PURPOSE. The App installation token is
# required for MERGES, because a merge made with GITHUB_TOKEN does not trigger
# downstream workflows and the commit would land without publishing. Raising an
# issue has no downstream effect at all, so it does not need the App - and
# GITHUB_TOKEN, with `issues: write` declared in the workflow, is guaranteed to
# have the permission, where an App's installation scopes can be narrowed
# without anyone here noticing. Use the narrow token for the narrow job.
# FIND THE EXISTING ISSUE WITHOUT USING SEARCH.
#
# `gh issue list --search "<title> in:title"` reads GitHub's SEARCH INDEX, which
# is eventually consistent - a freshly created issue is not findable for a
# minute or two. Two sweeps 87 seconds apart both looked, both saw nothing, and
# both created one: PepNationLab #79 and #80, same title, same content. A
# de-duplicating guard that duplicates is worse than none, because the noise
# teaches people to ignore it.
#
# The plain list endpoint is not an index. It is current.
find_issue() {
  # SAME TOKEN AS THE WRITE, and that is not a tidiness point. This read used
  # plain $GH_TOKEN - the App installation token - while the write used
  # GH_TOKEN_ISSUES. The App has no issues scope here, so the read returned
  # nothing every time, the guard concluded there was no existing issue, and
  # filed another one. World Hub #633, #637, #638 and PepNationLab #79, #81,
  # #83 are that bug: a read and a write that disagreed about who they were.
  GH_TOKEN="${GH_TOKEN_ISSUES:-${GH_TOKEN:-}}" \
  gh issue list --repo "${REPO:-$GITHUB_REPOSITORY}" --state open --limit 100 --json number,title \
    --jq "[.[] | select(.title == \"$1\")] | .[0].number // empty" 2>/dev/null
}

gh_write() {
  local what="$1"; shift
  local out
  if out=$(GH_TOKEN="${GH_TOKEN_ISSUES:-${GH_TOKEN:-}}" gh "$@" 2>&1); then
    echo "  $what"
    return 0
  fi
  echo "::error::report-stuck-prs could not $what -- the finding is real but nobody was told."
  printf '%s\n' "$out" | sed 's/^/    /'
  return 1
}

PRS=$(gh pr list --repo "$REPO" --state open --limit 100 \
        --json number,title,headRefName,mergeStateStatus,isDraft,labels,createdAt,updatedAt,author \
      2>/dev/null || echo '[]')

ROWS=""
COUNT=0
while read -r pr; do
  [ -n "$pr" ] || continue
  N=$(jq -r '.number'            <<<"$pr")
  T=$(jq -r '.title'             <<<"$pr")
  BR=$(jq -r '.headRefName'      <<<"$pr")
  ST=$(jq -r '.mergeStateStatus' <<<"$pr")
  DR=$(jq -r '.isDraft'          <<<"$pr")
  WHO=$(jq -r '.author.login // "?"' <<<"$pr")
  CREATED=$(jq -r '.createdAt'   <<<"$pr")
  HOLD=$(jq -r '[.labels[].name] | map(select(.=="do-not-merge" or .=="hold" or .=="wip")) | length' <<<"$pr")

  # A draft or a held PR is stuck ON PURPOSE. Reporting those trains people to
  # ignore the report, which is how a guard stops working.
  [ "$DR" = "true" ] && continue
  [ "$HOLD" != "0" ] && continue

  AGE_H=$(( (NOW - $(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$CREATED" +%s 2>/dev/null \
             || date -u -d "$CREATED" +%s 2>/dev/null || echo "$NOW")) / 3600 ))
  [ "$AGE_H" -lt "$STUCK_AFTER_H" ] && continue

  # Same lazy-mergeability trap as agent-autopilot.yml. Here it was worse: the
  # `case` below ends in `*) continue ;;`, so an UNKNOWN state did not merely
  # mis-classify a pull request, it DROPPED IT FROM THE REPORT ENTIRELY. This
  # is the report that exists so a stranded pull request cannot go unnoticed,
  # and it under-reported precisely when nothing else had warmed the cache —
  # which is exactly when nobody was looking. Asked per pull request, after the
  # draft/hold/age filters above so no call is wasted on a row we skip anyway.
  if [ "$ST" = "UNKNOWN" ] || [ -z "$ST" ] || [ "$ST" = "null" ]; then
    ST=$(gh pr view "$N" --repo "$REPO" --json mergeStateStatus \
           --jq .mergeStateStatus 2>/dev/null || echo UNKNOWN)
  fi

  case "$ST" in
    DIRTY)
      WHY="conflicts with the base branch"
      FIX="resolve it hunk by hunk — never \`--ours\`/\`--theirs\` on a whole file" ;;
    BLOCKED|UNSTABLE)
      LAST=$(gh run list --repo "$REPO" --branch "$BR" --limit 1 \
               --json conclusion,status --jq '.[0] | "\(.status)/\(.conclusion // "-")"' 2>/dev/null || echo "")
      case "$LAST" in
        ""|"null/-")
          WHY="**no check has ever reported**"
          FIX="the branch predates the workflow, or a required context no job produces. Push an empty commit to re-trigger, or fix the ruleset" ;;
        completed/failure|completed/cancelled|completed/timed_out)
          WHY="a required check is $LAST"
          FIX="read the failing check and fix the code" ;;
        in_progress/*|queued/*)
          continue ;;   # genuinely still working
        *)
          WHY="blocked ($ST, last run $LAST)"
          FIX="check whether a required context is missing rather than failing" ;;
      esac ;;
    BEHIND)
      WHY="behind its base and not refreshing"
      FIX="\`gh pr update-branch $N --repo $REPO\`" ;;
    UNKNOWN|"")
      # Still unknown after asking directly. Say so rather than dropping it:
      # a pull request missing from this table reads as "nothing is stuck",
      # and that silence is the failure this whole script exists to prevent.
      WHY="mergeability unknown even when asked directly"
      FIX="open the pull request and look — GitHub may still be computing, or the token cannot see it" ;;
    *)
      continue ;;
  esac

  ROWS="${ROWS}| [#${N}](https://github.com/${REPO}/pull/${N}) | \`${BR}\` | ${WHO} | ${AGE_H}h | ${WHY} | ${FIX} |
"
  COUNT=$((COUNT + 1))
done < <(jq -c '.[]' <<<"$PRS")

# ── Branches that were pushed and never proposed ───────────────────────────
# Machine-made namespaces are excluded: they are couriers and bot output, not
# somebody's work waiting to ship. Squash-merged branches are excluded by
# asking whether a PR EVER existed for the ref, because a squash leaves the
# branch's own commits permanently "ahead" of main even though the content
# landed - filtering on `git rev-list` alone reports every merged branch and
# is how a report like this becomes noise and then gets ignored.
ORPHANS=""
ORPHAN_COUNT=0
AUTO_OPENED=0
if [ "${SKIP_ORPHAN_BRANCHES:-0}" != "1" ]; then
  EVER=$(gh pr list --repo "$REPO" --state all --limit 500 --json headRefName \
           --jq '.[].headRefName' 2>/dev/null | sort -u)

  # WHEN EACH BRANCH'S PULL REQUEST FINISHED.
  #
  # "Has ever had a PR" is not the same as "has nothing left to ship", and the
  # difference cost a fix today. PR #643 in World Hub squash-merged at
  # 16:58:09Z; a commit was pushed to that same branch at 17:07:48Z, nine
  # minutes later, and sat orphaned on the remote while its author believed it
  # was on main. The filter above excluded it - correctly by its own rule, and
  # wrongly in fact.
  #
  # So a branch that has MOVED SINCE its pull request closed is orphaned too.
  # Keyed by branch, taking the most recent PR, because a branch can carry
  # several over its life.
  CLOSED_AT=$(gh pr list --repo "$REPO" --state all --limit 500 \
                --json headRefName,mergedAt,closedAt \
                --jq '[.[] | select((.mergedAt // .closedAt) != null)]
                      | group_by(.headRefName)
                      | map({(.[0].headRefName): ([.[] | (.mergedAt // .closedAt)] | max)})
                      | add // {}' 2>/dev/null || echo '{}')
  DEFAULT_BRANCH=$(gh repo view "$REPO" --json defaultBranchRef --jq '.defaultBranchRef.name' 2>/dev/null || echo main)

  # EVERYTHING HERE IS ASKED OF THE API, NOT OF THE LOCAL CLONE.
  #
  # The first version computed `git rev-list --count origin/main..origin/$B`
  # locally, and the numbers it published were nonsense: branches reported as
  # 3,908 and 4,693 commits ahead. The cause is that actions/checkout clones
  # with fetch-depth 1. In a shallow repository a merge base cannot be found,
  # so almost every commit on the branch counts as "not on main". The figures
  # were artifacts of the checkout, and a table with an impossible number in it
  # is a table people stop reading.
  #
  # `repos/{repo}/compare/{base}...{head}` answers the same question on the
  # server, against the full history, in one call - and returns `status`, which
  # also identifies the branches that are strictly behind and carry nothing.
  while read -r B; do
    [ -n "$B" ] || continue
    case "$B" in
      "$DEFAULT_BRANCH"|master|production) continue ;;
      ci-marker/*|build/*|backup/*|dependabot/*|sentry-autofix/*|revert-*|renovate/*) continue ;;
    esac
    # A branch with no PR at all is an orphan. So is one whose PR has finished
    # and which has been pushed to since - decided below, once the tip date is
    # known, because that is the only thing that can tell them apart.
    FINISHED=$(jq -r --arg b "$B" '.[$b] // empty' <<<"$CLOSED_AT")
    if printf '%s\n' "$EVER" | grep -qx "$B"; then
      [ -n "$FINISHED" ] || continue          # PR still open: the list above owns it
    else
      FINISHED=""                             # never proposed at all
    fi

    CMP=$(gh api "repos/${REPO}/compare/${DEFAULT_BRANCH}...${B}" \
            --jq '{a:.ahead_by,b:.behind_by,s:.status,d:(.commits|last|.commit.committer.date // "")}' 2>/dev/null || echo "")
    [ -n "$CMP" ] || continue
    AHEAD=$(jq -r '.a // 0' <<<"$CMP")
    BEHIND=$(jq -r '.b // 0' <<<"$CMP")
    STATUS=$(jq -r '.s // ""' <<<"$CMP")
    TIP=$(jq -r '.d // ""'   <<<"$CMP")
    # "behind" or "identical" means the branch carries nothing main does not.
    # Those are stale pointers to delete, not work waiting to ship, and listing
    # them is how this report would become noise.
    [ "${AHEAD:-0}" -gt 0 ] || continue

    if [ -n "$TIP" ]; then
      TIP_EPOCH=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$TIP" +%s 2>/dev/null \
                  || date -u -d "$TIP" +%s 2>/dev/null || echo "$NOW")
    else
      TIP_EPOCH=$NOW
    fi
    AGE_H=$(( (NOW - TIP_EPOCH) / 3600 ))
    [ "$AGE_H" -lt "$STUCK_AFTER_H" ] && continue

    WHY_ORPHAN="never proposed"
    if [ -n "$FINISHED" ]; then
      FIN_EPOCH=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$FINISHED" +%s 2>/dev/null \
                  || date -u -d "$FINISHED" +%s 2>/dev/null || echo 0)
      # Two minutes of slack: a squash merge and the branch tip are written
      # seconds apart, and reporting that as orphaned work would be noise.
      if [ "$TIP_EPOCH" -le $((FIN_EPOCH + 120)) ]; then
        continue
      fi
      WHY_ORPHAN="**pushed $(( (TIP_EPOCH - FIN_EPOCH) / 60 ))m AFTER its PR closed**"
    fi

    # An agent/* branch under a day old is an agent that stopped one step
    # short. Finish the step for it; that is the whole point of Autopilot.
    # ANY young orphan, not only agent/* (2026-09-02). The namespace test was
    # the wrong proxy: CLAUDE.md 11.0 tells agents to use `fix/<slug>`, so most
    # real work never had the prefix this looked for, and on 2026-09-02 three
    # agents' finished work stranded because of it. The AGE gate is the real
    # safety - a branch under a day old with commits ahead of main is somebody
    # who stopped one step short today, whatever they named it. A months-old
    # branch is still only reported, never opened. `rescue/*` joins the
    # never-a-proposal namespaces above: those are recovery snapshots.
    case "$B" in
      rescue/*) ;;
      *)
        if [ "$AGE_H" -lt 24 ] && gh_write \
             "open a pull request for orphan branch $B (${AHEAD} commits, ${AGE_H}h old)" \
             pr create --repo "$REPO" --head "$B" --base "$DEFAULT_BRANCH" --fill; then
          AUTO_OPENED=$((AUTO_OPENED + 1))
          continue
        fi ;;
    esac

    ORPHANS="${ORPHANS}| \`${B}\` | ${AHEAD} | ${BEHIND} | ${AGE_H}h | ${WHY_ORPHAN} | [open a PR](https://github.com/${REPO}/compare/${DEFAULT_BRANCH}...${B}?expand=1) |
"
    ORPHAN_COUNT=$((ORPHAN_COUNT + 1))
  done < <(gh api "repos/${REPO}/branches" --paginate --jq '.[].name' 2>/dev/null)
fi
[ "$AUTO_OPENED" -gt 0 ] && echo "auto-opened $AUTO_OPENED pull request(s) for branches that were never proposed."

ORPHAN_SECTION=""
if [ "$ORPHAN_COUNT" -gt 0 ]; then
  ORPHAN_SECTION="

---

### ${ORPHAN_COUNT} branch(es) pushed, never proposed

Either no pull request has ever existed for these, or one did and **the branch was pushed to after it closed** — a commit that landed on the remote nine minutes after its PR squash-merged is exactly as orphaned as one that was never proposed, and until 2026-08-22 this report could not see the second kind. Nothing else can see either: Autopilot queues pull requests, and there is nothing to queue. Branches carrying nothing \`${DEFAULT_BRANCH}\` does not already have are filtered out, as are squash-merged ones — a squash leaves every merged branch permanently \"ahead\", so filtering on that alone reports the entire repo and the report gets ignored within a day.

| branch | commits it has | commits it is missing | last commit | why | |
|---|---|---|---|---|---|
$(printf '%s' "$ORPHANS" | head -60)
The **missing** column is the size of the job: a branch a few commits behind is a merge, one that is hundreds behind is a rebase and probably a rewrite.

Judge each one: open a pull request, or delete the branch. Leaving it is the option that looks like nothing happening and is actually work quietly going nowhere."
fi

EXISTING=$(find_issue "$TITLE")

if [ "$COUNT" -eq 0 ] && [ "$ORPHAN_COUNT" -eq 0 ]; then
  echo "found: nothing stuck and no unproposed branches older than ${STUCK_AFTER_H}h."
  if [ -n "${EXISTING:-}" ]; then
    gh_write "comment on #$EXISTING" issue comment "$EXISTING" --repo "$REPO" \
      --body "Everything listed here has merged, closed, or been proposed. Nothing is stuck and no branch is sitting unproposed." || true
    gh_write "close issue #$EXISTING" issue close "$EXISTING" --repo "$REPO" || true
  fi
  exit 0
fi

PR_SECTION=""
if [ "$COUNT" -gt 0 ]; then
  PR_SECTION="${COUNT} open pull request(s) have been unable to merge for more than ${STUCK_AFTER_H}h. Autopilot cannot land these on its own — that is the whole reason this list exists rather than a log line nobody reads.

| PR | branch | opened by | age | why it is stuck | what unsticks it |
|---|---|---|---|---|---|
${ROWS}"
else
  PR_SECTION="Every open pull request is merging normally."
fi

BODY="${PR_SECTION}
A pull request that never merges is not a neutral state. The work does not ship, and from outside the repo that is indistinguishable from the feature having regressed.

Whatever you do, do not reach for a flag that makes the check stop applying. \`--admin\` bypassed required checks and put red code on main four times; \`--merge\` and \`--rebase\` are disabled here and fail **silently**, leaving the PR open while the agent reports success.

_Updated in place by \`.github/workflows/agent-autopilot.yml\` on every sweep. It closes itself when the list empties._${ORPHAN_SECTION}"

echo "found: $COUNT stuck pull request(s), $ORPHAN_COUNT unproposed branch(es)."
if [ -n "${EXISTING:-}" ]; then
  gh_write "update issue #$EXISTING" issue edit "$EXISTING" --repo "$REPO" --body "$BODY" || true
else
  gh_write "open an issue" issue create --repo "$REPO" --title "$TITLE" --body "$BODY" || true
fi

{
  echo "### $COUNT pull request(s) cannot merge on their own"
  echo ""
  echo "| PR | branch | opened by | age | why | fix |"
  echo "|---|---|---|---|---|---|"
  printf '%s' "$ROWS"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
