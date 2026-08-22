#!/usr/bin/env bash
# Fail LOUDLY when the autopilot token is dead.
#
# WHY: on this workflow's first run GH_PAT was expired. `gh` returned
# "HTTP 401: Bad credentials" from inside a loop and the job just went red with
# no indication that a CREDENTIAL, not the code, was the problem. A dead token
# means nothing merges and nothing publishes, silently — the exact failure mode
# this whole workflow exists to abolish. So we check it first, say so in plain
# words, and raise an issue that names the fix.
set -uo pipefail

if OUT=$(gh api user --jq .login 2>&1); then
  echo "token OK — authenticated as: $OUT"

  # A PAT with an expiry date is a scheduled outage. When it lapses, every
  # merge and every publish stops at once, and the only symptom is that PRs
  # quietly stop landing. Warn while there is still time to rotate it.
  EXP=$(gh api -i user 2>/dev/null | tr -d '\r' \
        | awk 'tolower($1)=="github-authentication-token-expiration:"{ $1=""; sub(/^ /,""); print }')
  if [ -n "${EXP:-}" ]; then
    EXP_EPOCH=$(date -u -d "$EXP" +%s 2>/dev/null || echo "")
    if [ -n "$EXP_EPOCH" ]; then
      DAYS=$(( (EXP_EPOCH - $(date -u +%s)) / 86400 ))
      echo "GH_PAT expires in ${DAYS} day(s) (${EXP})."
      {
        echo "### Agent Autopilot token"
        echo ""
        echo "\`GH_PAT\` expires in **${DAYS} day(s)** — \`${EXP}\`"
      } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
      if [ "$DAYS" -le 21 ]; then
        echo "::warning::GH_PAT expires in ${DAYS} day(s). When it lapses, NOTHING will auto-merge or publish. Rotate it: gh secret set GH_PAT --repo ${GITHUB_REPOSITORY:-<repo>} --body <fresh PAT>"
        if [ -n "${GITHUB_TOKEN_FALLBACK:-}" ]; then
          GH_TOKEN="$GITHUB_TOKEN_FALLBACK" gh issue list --repo "$GITHUB_REPOSITORY" --state open \
            --search "Agent Autopilot token expires in:title" --limit 1 --json number --jq '.[0].number' 2>/dev/null | grep -q . \
          || GH_TOKEN="$GITHUB_TOKEN_FALLBACK" gh issue create --repo "$GITHUB_REPOSITORY" \
               --title "Agent Autopilot token expires ${EXP}" \
               --body "\`GH_PAT\` expires in ${DAYS} day(s) (\`${EXP}\`).

When it lapses every PR stops auto-merging and nothing publishes to the World Hub. Agents will keep reporting success.

Rotate: \`gh secret set GH_PAT --repo $GITHUB_REPOSITORY --body <fresh PAT>\` (needs contents + pull-requests write)." >/dev/null 2>&1 || true
        fi
      fi
    fi
  fi
  exit 0
fi

echo "::error::Agent Autopilot's token is invalid ($OUT)."
echo "::error::Nothing will auto-merge or publish until it is replaced."
echo "::error::Fix: gh secret set GH_PAT --repo ${GITHUB_REPOSITORY:-<repo>} --body <a fresh PAT with repo + pull_requests write>"

# Raise it where a human will actually see it, using the built-in token, which
# is always valid even when GH_PAT is not.
if [ -n "${GITHUB_TOKEN_FALLBACK:-}" ]; then
  export GH_TOKEN="$GITHUB_TOKEN_FALLBACK"
  TITLE="Agent Autopilot is down: GH_PAT is invalid"
  EXISTING=$(gh issue list --repo "$GITHUB_REPOSITORY" --state open --search "$TITLE in:title" --limit 1 --json number --jq '.[0].number' 2>/dev/null || echo "")
  if [ -z "$EXISTING" ]; then
    gh issue create --repo "$GITHUB_REPOSITORY" --title "$TITLE" \
      --body "\`gh api user\` returned:

\`\`\`
$OUT
\`\`\`

**Impact:** no PR will auto-merge and no merge will publish to the World Hub until this is replaced. Agents will appear to work and nothing will ship.

**Fix:** \`gh secret set GH_PAT --repo $GITHUB_REPOSITORY --body <fresh PAT>\` (needs repo contents + pull-requests write)." >/dev/null 2>&1 || true
  fi
fi
exit 1
