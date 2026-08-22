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
  DEFAULT_BRANCH=$(gh repo view "$REPO" --json defaultBranchRef --jq '.defaultBranchRef.name' 2>/dev/null || echo main)
  git fetch --no-tags --quiet origin "+refs/heads/*:refs/remotes/origin/*" 2>/dev/null || true

  while read -r ref; do
    B=${ref#refs/heads/}
    case "$B" in
      "$DEFAULT_BRANCH"|master|production) continue ;;
      ci-marker/*|build/*|backup/*|dependabot/*|sentry-autofix/*|revert-*|renovate/*) continue ;;
    esac
    printf '%s\n' "$EVER" | grep -qx "$B" && continue
    AHEAD=$(git rev-list --count "origin/${DEFAULT_BRANCH}..origin/${B}" 2>/dev/null || echo 0)
    [ "${AHEAD:-0}" -gt 0 ] || continue

    LAST_EPOCH=$(git log -1 --format=%ct "origin/$B" 2>/dev/null || echo "$NOW")
    AGE_H=$(( (NOW - LAST_EPOCH) / 3600 ))
    [ "$AGE_H" -lt "$STUCK_AFTER_H" ] && continue

    # An agent/* branch under a day old is an agent that stopped one step
    # short. Finish the step for it; that is the whole point of Autopilot.
    case "$B" in
      agent/*)
        if [ "$AGE_H" -lt 24 ] && gh pr create --repo "$REPO" --head "$B" \
             --base "$DEFAULT_BRANCH" --fill >/dev/null 2>&1; then
          echo "opened a pull request for orphan branch $B (${AHEAD} commits, ${AGE_H}h old)."
          AUTO_OPENED=$((AUTO_OPENED + 1))
          continue
        fi ;;
    esac

    ORPHANS="${ORPHANS}| \`${B}\` | ${AHEAD} | ${AGE_H}h | [open a PR](https://github.com/${REPO}/compare/${DEFAULT_BRANCH}...${B}?expand=1) |
"
    ORPHAN_COUNT=$((ORPHAN_COUNT + 1))
  done < <(git for-each-ref --format='%(refname)' refs/remotes/origin/ 2>/dev/null \
            | sed 's|refs/remotes/origin/|refs/heads/|')
fi
[ "$AUTO_OPENED" -gt 0 ] && echo "auto-opened $AUTO_OPENED pull request(s) for agent branches that were never proposed."

ORPHAN_SECTION=""
if [ "$ORPHAN_COUNT" -gt 0 ]; then
  ORPHAN_SECTION="

---

### ${ORPHAN_COUNT} branch(es) pushed, never proposed

No pull request has ever existed for these, so nothing above can see them and Autopilot cannot queue what does not exist. Squash-merged branches are already filtered out — every row here is work that has genuinely never been asked to land.

| branch | commits ahead | last commit | |
|---|---|---|---|
$(printf '%s' "$ORPHANS" | head -60)
Judge each one: open a pull request, or delete the branch. Leaving it is the option that looks like nothing happening and is actually work quietly going nowhere."
fi

EXISTING=$(gh issue list --repo "$REPO" --state open --search "$TITLE in:title" \
             --limit 1 --json number --jq '.[0].number' 2>/dev/null || true)

if [ "$COUNT" -eq 0 ] && [ "$ORPHAN_COUNT" -eq 0 ]; then
  echo "nothing stuck and no unproposed branches older than ${STUCK_AFTER_H}h."
  if [ -n "${EXISTING:-}" ]; then
    gh issue comment "$EXISTING" --repo "$REPO" \
      --body "Everything listed here has merged, closed, or been proposed. Nothing is stuck and no branch is sitting unproposed." >/dev/null 2>&1 || true
    gh issue close "$EXISTING" --repo "$REPO" >/dev/null 2>&1 || true
    echo "closed issue #$EXISTING."
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

if [ -n "${EXISTING:-}" ]; then
  gh issue edit "$EXISTING" --repo "$REPO" --body "$BODY" >/dev/null 2>&1 \
    && echo "updated issue #$EXISTING with $COUNT stuck PR(s) and $ORPHAN_COUNT unproposed branch(es)."
else
  gh issue create --repo "$REPO" --title "$TITLE" --body "$BODY" >/dev/null 2>&1 \
    && echo "opened an issue listing $COUNT stuck PR(s) and $ORPHAN_COUNT unproposed branch(es)."
fi

{
  echo "### $COUNT pull request(s) cannot merge on their own"
  echo ""
  echo "| PR | branch | opened by | age | why | fix |"
  echo "|---|---|---|---|---|---|"
  printf '%s' "$ROWS"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
