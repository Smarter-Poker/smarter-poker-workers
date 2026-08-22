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

# Already mergeable and green -> merge now (checks still enforced by the ruleset).
if echo "$OUT" | grep -qiE "clean status|not mergeable|already"; then
  if gh pr merge "$PR" --repo "$REPO" --squash 2>&1; then
    echo "  merged #$PR directly (it was already green)."
    exit 0
  fi
fi

# Do not fail the workflow: a PR that cannot be queued yet (conflicts, failing
# checks) is normal. The next sweep retries. Surface it, keep going.
echo "::warning::#$PR could not be queued yet — the next sweep will retry. Reason: $OUT"
exit 0
