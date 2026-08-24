#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  EVERY GUARD IN THIS ESTATE WATCHES GITHUB. NOTHING WATCHED THIS MACHINE.
# ═══════════════════════════════════════════════════════════════════════════
#
# WHY THIS EXISTS (2026-08-23)
#
# report-stuck-prs.sh names pull requests that cannot merge. estate-integrity.sh
# checks rulesets and shared files. publish-watchdog.sh asks production what it
# is serving. Every one of them queries GitHub - so all of them are blind to the
# one failure that actually loses work: a commit that never REACHED GitHub.
#
# Found today, by hand: TEN commits across SEVEN branches, sitting in worktrees
# for between nine and nineteen hours. Real feature work - the union Spin
# reserve, spin rake parity, the horse busy-set query. None of the branches
# existed on the remote. Nothing anywhere had noticed, and nothing would have.
#
# It was invisible for a second reason worth naming. Those worktrees belonged to
# a DUPLICATE clone, and the estate had six clones of two repositories. Work
# stranded in one is unseen by anyone looking at another. So this scans the
# machine, not a directory: every clone of this repo it can find, and every
# worktree of each.
#
# THIS IS THE LOAD-BEARING FIX. Consolidating to one clone per repo is worth
# doing and is a separate change, but it would NOT have caught these ten
# commits: 98 worktrees hang off the canonical clone too, and they are guarded
# identically. What was missing was anyone asking "is there work here that has
# not left this machine".
#
#     bash scripts/check-unpushed-work.sh            # report
#     bash scripts/check-unpushed-work.sh --quiet    # only speak if something is wrong
set -uo pipefail

QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

REMOTE_URL=$(git config --get remote.origin.url 2>/dev/null || echo "")
REPO_KEY=$(printf '%s' "$REMOTE_URL" | sed 's#.*[:/]##; s#\.git$##')
[ -z "$REPO_KEY" ] && exit 0

FINDINGS=""
CLONES=""

# Every clone of this repo under ~/Documents, plus every worktree of each.
for d in "$HOME"/Documents/*/; do
  [ -d "$d/.git" ] || continue
  U=$(git -C "$d" config --get remote.origin.url 2>/dev/null || echo "")
  case "$U" in *"$REPO_KEY"*) ;; *) continue ;; esac
  CLONES="$CLONES $d"
  # `worktree list` already includes the clone itself, and $d carries a trailing
  # slash, so without normalising, the main clone is reported twice.
  for t in $(git -C "$d" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}'); do
    [ -d "$t" ] || continue
    t=$(cd "$t" 2>/dev/null && pwd -P) || continue
    git -C "$t" rev-parse --git-dir >/dev/null 2>&1 || continue
    B=$(git -C "$t" rev-parse --abbrev-ref HEAD 2>/dev/null) || continue
    [ "$B" = "HEAD" ] && continue          # detached: nothing to push to
    SHA=$(git -C "$t" rev-parse HEAD 2>/dev/null) || continue

    # commits here that no remote branch contains
    if ! git -C "$t" branch -r --contains "$SHA" 2>/dev/null | grep -q .; then
      MB=$(git -C "$t" merge-base HEAD origin/main 2>/dev/null || echo "")
      N=$([ -n "$MB" ] && git -C "$t" rev-list --count "$MB"..HEAD 2>/dev/null || echo "?")
      # `git cherry` tells apart "not pushed" from "pushed under a different sha"
      REAL=$([ -n "$MB" ] && git -C "$t" cherry origin/main HEAD 2>/dev/null | grep -c '^+' || echo "?")
      [ "$REAL" = "0" ] && continue
      FINDINGS="$FINDINGS
  $REAL commit(s) on a branch no remote has:
      $t
      branch $B"
    fi

    # uncommitted TRACKED changes - untracked scratch is not interesting
    D=$(git -C "$t" status --porcelain 2>/dev/null | grep -vc '^??' || true)
    if [ "${D:-0}" -gt 0 ]; then
      FINDINGS="$FINDINGS
  $D uncommitted tracked file(s):
      $t"
    fi
  done
done

NCLONES=$(printf '%s' "$CLONES" | wc -w | tr -d ' ')
if [ "$NCLONES" -gt 1 ]; then
  FINDINGS="$FINDINGS
  $NCLONES separate clones of $REPO_KEY on this machine. Work stranded in one is
  invisible to anyone looking at another - which is how the ten commits above
  went unnoticed for nineteen hours:$(printf '%s' "$CLONES" | tr ' ' '\n' | sed 's#^#\n      #')"
fi

if [ -z "$FINDINGS" ]; then
  [ "$QUIET" = "1" ] || echo "  nothing unpushed on this machine for $REPO_KEY."
  exit 0
fi

cat >&2 <<MSG

  ─────────────────────────────────────────────────────────────────────────
  WORK ON THIS MACHINE THAT GITHUB HAS NEVER SEEN
$FINDINGS

  None of this is protected by anything. Branch protection, the autopilot and
  every watchdog in this estate operate on what has been pushed. A commit that
  never left this Mac is one \`git reset --hard\` from gone, and the Antigravity
  sync loop runs that reset on a timer.

  Push it:   cd <the tree above> && git push -u origin HEAD
  Then stop. The autopilot opens the pull request and merges it.
  ─────────────────────────────────────────────────────────────────────────

MSG
exit 1
