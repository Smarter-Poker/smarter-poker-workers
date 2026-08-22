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

# PROBE CHOICE MATTERS. `gh api user` is only valid for a USER token: a GitHub
# App token (GITHUB_TOKEN) has no user and always returns
# "403 Resource not accessible by integration", so the old probe reported a
# perfectly working App token as dead. Asking about the REPOSITORY works for
# both kinds of token, which is the point — this check exists to answer "can I
# act on this repo", not "who am I".
if OUT=$(gh api "repos/${GITHUB_REPOSITORY}" --jq .full_name 2>&1); then
  echo "token OK — can read $OUT"

  # A PAT with an expiry date is a scheduled outage. When it lapses, every
  # merge and every publish stops at once, and the only symptom is that PRs
  # quietly stop landing. Warn while there is still time to rotate it.
  EXP=$(gh api -i user 2>/dev/null | tr -d '\r' \
        | awk 'tolower($1)=="github-authentication-token-expiration:"{ $1=""; sub(/^ /,""); print }')
  if [ -n "${EXP:-}" ]; then
    EXP_EPOCH=$(date -u -d "$EXP" +%s 2>/dev/null || echo "")
    if [ -n "$EXP_EPOCH" ]; then
      DAYS=$(( (EXP_EPOCH - $(date -u +%s)) / 86400 ))
      # Reached only when GH_TOKEN is a USER token, i.e. the App did not mint
      # one and the fallback PAT is in play. An App installation token has no
      # user, so `gh api user` 403s and this whole block is skipped — which is
      # itself the cheapest signal that the App is working.
      echo "Running on the GH_PAT fallback, which expires in ${DAYS} day(s) (${EXP}). The GitHub App did not mint a token — check vars.AUTOPILOT_APP_ID."
      {
        echo "### Agent Autopilot token"
        echo ""
        echo "\`GH_PAT\` expires in **${DAYS} day(s)** — \`${EXP}\`"
      } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
      if [ "$DAYS" -le 21 ]; then
        echo "::warning::GH_PAT expires in ${DAYS} day(s). When it lapses, NOTHING will auto-merge or publish. Rotate it: gh secret set GH_PAT --repo ${GITHUB_REPOSITORY:-<repo>} --body <fresh PAT>"
        if [ -n "${GITHUB_TOKEN_FALLBACK:-}" ]; then
          # Not --search: that reads the eventually-consistent search index, so
          # two runs minutes apart both see nothing and both file one. Ask the
          # list endpoint, which is current.
          GH_TOKEN="$GITHUB_TOKEN_FALLBACK" gh issue list --repo "$GITHUB_REPOSITORY" --state open \
            --limit 100 --json title --jq '.[].title' 2>/dev/null | grep -q "^Agent Autopilot token expires" \
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
echo "::error::The credential is a GitHub App installation token, minted per run."
echo "::error::Check, in this order: the App is still installed on ${GITHUB_REPOSITORY:-<repo>};"
echo "::error::  vars.AUTOPILOT_APP_ID is set; secrets.AUTOPILOT_APP_PRIVATE_KEY is the full PEM."
echo "::error::A key rotated in the App settings invalidates the old PEM immediately."

# Raise it where a human will actually see it, using the built-in token, which
# is always valid even when GH_PAT is not.
if [ -n "${GITHUB_TOKEN_FALLBACK:-}" ]; then
  export GH_TOKEN="$GITHUB_TOKEN_FALLBACK"
  TITLE="Agent Autopilot is down: GH_PAT is invalid"
  # The list endpoint, not --search: see the note above.
  EXISTING=$(gh issue list --repo "$GITHUB_REPOSITORY" --state open --limit 100 --json number,title \
               --jq "[.[] | select(.title == \"$TITLE\")] | .[0].number // empty" 2>/dev/null || echo "")
  if [ -z "$EXISTING" ]; then
    gh issue create --repo "$GITHUB_REPOSITORY" --title "$TITLE" \
      --body "\`gh api user\` returned:

\`\`\`
$OUT
\`\`\`

**Impact:** no PR will auto-merge and no merge will publish to the World Hub until this is replaced. Agents will appear to work and nothing will ship.

**Fix:** Autopilot mints a GitHub App installation token every run, so there is no expiry to renew — a failure here means the App itself. In order: confirm the App is still installed on this repo, that \`vars.AUTOPILOT_APP_ID\` is set, and that \`secrets.AUTOPILOT_APP_PRIVATE_KEY\` holds the complete PEM including its BEGIN/END lines. Regenerating the key in the App settings invalidates the previous PEM the moment you do it." >/dev/null 2>&1 || true
  fi
fi
exit 1
