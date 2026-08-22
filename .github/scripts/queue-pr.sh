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
# minutes). CLEAN specifically - not UNSTABLE - because UNSTABLE means a check
# IS failing, just not a mandatory one, and merging that is how red code lands.
if echo "$OUT" | grep -qiE "clean status|not mergeable|already|required protected branch rules"; then
  STATE=$(gh pr view "$PR" --repo "$REPO" --json mergeStateStatus --jq .mergeStateStatus 2>/dev/null || echo UNKNOWN)
  case "$STATE" in
    CLEAN|HAS_HOOKS)
      if gh pr merge "$PR" --repo "$REPO" --squash 2>&1; then
        echo "  merged #$PR directly (green, and its base branch offers no auto-merge)."
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
