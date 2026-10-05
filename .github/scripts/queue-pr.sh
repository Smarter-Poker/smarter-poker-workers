#!/usr/bin/env bash
# Queue one pull request for squash auto-merge without a bypass or reconciler.
set -euo pipefail

REPO="${1:?repository is required}"
PR="${2:?pull request number is required}"

DETAILS=$(gh pr view "$PR" --repo "$REPO" \
  --json state,isDraft,mergeStateStatus,autoMergeRequest,baseRefName)
STATE=$(jq -r '.state' <<<"$DETAILS")
DRAFT=$(jq -r '.isDraft' <<<"$DETAILS")
MERGE_STATE=$(jq -r '.mergeStateStatus' <<<"$DETAILS")
AUTO=$(jq -r 'if .autoMergeRequest then "yes" else "no" end' <<<"$DETAILS")
BASE=$(jq -r '.baseRefName' <<<"$DETAILS")

[ "$STATE" = "OPEN" ] || { echo "PR #$PR is not open; nothing to queue."; exit 0; }
[ "$DRAFT" = "false" ] || { echo "PR #$PR is a draft; leaving it unqueued."; exit 0; }
[ "$AUTO" = "no" ] || { echo "PR #$PR already has auto-merge armed."; exit 0; }

echo "Queueing #$PR for protected squash auto-merge."
if OUT=$(gh pr merge "$PR" --repo "$REPO" --squash --auto 2>&1); then
  echo "$OUT"
  exit 0
fi

# GitHub refuses --auto after a protected PR is already clean. Direct squash
# merge is safe only after proving the base still requires status checks; the
# server enforces those checks and no --admin path exists here.
if [ "$MERGE_STATE" = "CLEAN" ] || [ "$MERGE_STATE" = "HAS_HOOKS" ]; then
  RULES=$(gh api "repos/$REPO/rules/branches/$BASE")
  REQUIRED=$(jq '[.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[]] | length' <<<"$RULES")
  [ "$REQUIRED" -gt 0 ] \
    || { echo "::error::$BASE has no required checks; refusing a direct merge."; exit 1; }
  gh pr merge "$PR" --repo "$REPO" --squash
  echo "Merged #$PR only after GitHub reported the protected PR clean."
  exit 0
fi

echo "::error::Could not arm protected auto-merge for #$PR (state=$MERGE_STATE): $OUT"
exit 1
