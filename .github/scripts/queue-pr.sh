#!/usr/bin/env bash
# Queue one PR for squash auto-merge.
#
# Three things this must get right, each learned from a real failure:
#
#  1. SQUASH ONLY. This repo disables merge commits and rebase merges. A bare
#     `gh pr merge --merge` fails at the API and, run inside a polling loop,
#     fails *silently* — the loop exits 0 and the PR sits open. Passing the
#     strategy explicitly is not optional.
#  2. NEVER `--admin`. That flag bypasses required status checks. It is the
#     single mechanism by which red code has reached main here.
#  3. `--auto` errors when a PR is ALREADY green and mergeable ("Pull request
#     is in clean status"). That is a success condition, not a failure: merge
#     it directly, still through the checks.
#  4. `--auto` ALSO errors with "Pull request is in unstable status" when every
#     check the ruleset REQUIRES is green and something it does not require
#     is red. Auto-merge would have merged that PR without a second thought -
#     it waits for required checks only - so refusing it here made the
#     outcome a race: enable auto-merge before the checks finish and the PR
#     lands; sweep after they finish and it sits open forever, "the next
#     sweep will look again", every ten minutes, with no report. World Hub
#     #1364 sat that way on 2026-09-04 with all seven required checks green
#     and one optional suite red. Case 3 below.
set -uo pipefail

REPO="$1"
PR="$2"

echo "→ queueing #$PR for squash auto-merge"

if OUT=$(gh pr merge "$PR" --repo "$REPO" --squash --auto 2>&1); then
  echo "  queued: GitHub will squash-merge #$PR when required checks pass."
  exit 0
fi

echo "  --auto declined: $OUT"

# CASE 1 — already mergeable and green. `--auto` refuses with "clean status"
# because there is nothing left to wait for. Merge it.
#
# CASE 2 — the base branch has no protection rules. GitHub only OFFERS
# auto-merge on a protected branch that requires a check or a review; a ruleset
# that merely blocks force-pushes does not qualify, so `--auto` is refused
# outright with "Branch does not have required protected branch rules". Every
# repo in this estate except Club Arena is in that position, which means
# Autopilot would have queued nothing at all outside Club Arena.
#
# In such a repo there is no required check to wait for, so emulate auto-merge:
# merge when the PR is CLEAN, and otherwise leave it for the next sweep (10
# minutes). CLEAN specifically - not UNSTABLE - because in a repo with NO
# required checks UNSTABLE means the only check there is has failed, and
# merging that is how red code lands.
#
# CASE 3 — UNSTABLE in a repo whose base ruleset DOES require checks. GitHub
# reports BLOCKED while a required check is red or pending, so UNSTABLE there
# can only mean: everything required is green, something optional is not. That
# is exactly the state auto-merge merges in, and the ruleset still enforces the
# required checks on the merge call itself - a red required check gets a 405
# from the API, never a merge. Merging here is therefore the same bar `--auto`
# applies three lines above; refusing was the race described in the header.
# Whatever was waived is named in the log so the waiver is never silent.
if echo "$OUT" | grep -qiE "clean status|unstable status|not mergeable|already|required protected branch rules"; then
  STATE=$(gh pr view "$PR" --repo "$REPO" --json mergeStateStatus --jq .mergeStateStatus 2>/dev/null || echo UNKNOWN)
  case "$STATE" in
    CLEAN|HAS_HOOKS)
      if gh pr merge "$PR" --repo "$REPO" --squash 2>&1; then
        echo "  merged #$PR directly (green, and its base branch offers no auto-merge)."
        exit 0
      fi
      ;;
    UNSTABLE)
      BASE=$(gh pr view "$PR" --repo "$REPO" --json baseRefName --jq .baseRefName 2>/dev/null || echo "")
      REQUIRED_COUNT=$(gh api "repos/$REPO/rules/branches/$BASE" \
        --jq '[.[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context] | length' 2>/dev/null || echo 0)
      if [ "${REQUIRED_COUNT:-0}" -gt 0 ]; then
        NOT_GREEN=$(gh pr view "$PR" --repo "$REPO" --json statusCheckRollup \
          --jq '[.statusCheckRollup[] | select(((.conclusion // .state // "") | ascii_upcase) | IN("SUCCESS","SKIPPED","NEUTRAL") | not) | (.name // .context)] | unique | join(", ")' 2>/dev/null || echo "unknown")
        echo "  #$PR is UNSTABLE: all $REQUIRED_COUNT checks the $BASE ruleset requires are green; not green and not required: ${NOT_GREEN:-none}."
        if gh pr merge "$PR" --repo "$REPO" --squash 2>&1; then
          echo "  merged #$PR directly (required checks green; optional checks waived, named above)."
          exit 0
        fi
      else
        echo "  #$PR is UNSTABLE and $BASE requires no checks — not merging. The next sweep will look again."
        exit 0
      fi
      ;;
    *)
      echo "  #$PR is $STATE — not merging. The next sweep will look again."
      exit 0
      ;;
  esac
fi

# Do not fail the workflow: a PR that cannot be queued yet (conflicts, failing
# checks) is normal. The next sweep retries. Surface it, keep going.
echo "::warning::#$PR could not be queued yet — the next sweep will retry. Reason: $OUT"
exit 0
