#!/usr/bin/env bash
# Verify one freshly minted GitHub App token. No fallback credential exists.
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN must be the current GitHub App installation token}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

if REPO=$(gh api "repos/$GITHUB_REPOSITORY" --jq .full_name 2>&1); then
  [ "$REPO" = "$GITHUB_REPOSITORY" ] \
    || { echo "::error::GitHub authority resolved the wrong repository: $REPO"; exit 1; }
  echo "GitHub App authority verified for $REPO."
  exit 0
fi

echo "::error::The freshly minted GitHub App token cannot read $GITHUB_REPOSITORY."
echo "::error::Verify AUTOPILOT_APP_ID, AUTOPILOT_APP_PRIVATE_KEY, and the App installation."
exit 1
