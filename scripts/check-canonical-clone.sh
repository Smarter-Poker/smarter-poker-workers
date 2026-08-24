#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  ONE CLONE PER REPO. EVERY AGENT, EVERY TOOL, THE SAME TREE.
# ═══════════════════════════════════════════════════════════════════════════
#
# WHY THIS EXISTS (2026-08-23)
#
# This machine had SIX clones of two repositories:
#
#     club-arena  +  Smarter-Poker-Club-Arena                  (Club Arena)
#     Smarter-Poker-World-Hub  +  hub-vanguard
#       +  hub-vanguard3  +  hub-vanguard-clean                (World Hub)
#
# Claude agents worked in one, Antigravity agents in another, and the dev server
# ran from a third. Nothing enforced which was which, so they drifted:
# Smarter-Poker-Club-Arena sat 293 COMMITS BEHIND while a Vite process from two
# days earlier served it. Two days were spent believing deploys were broken.
# They were not - the work was live on smarter.poker the whole time, and the
# browser was pointed at a time capsule.
#
# Duplicate clones cost more than confusion. Each one is a place uncommitted
# work can be stranded where no worktree guard is watching: 390 lines of wallet
# and cashier work were found uncommitted in the shared clone, twenty commits
# behind, one `git reset --hard` from gone.
#
# The old paths are now SYMLINKS to the canonical clone, so anybody's muscle
# memory still works and lands in the right tree. This guard is for the next
# one: a fresh `git clone` into a new directory, which is how all six started.
#
# Bypass, for a deliberate second checkout you are about to throw away:
#     AGENT_CLONE_OK=1 git commit ...
set -euo pipefail

[ "${AGENT_CLONE_OK:-}" = "1" ] && exit 0
[ -n "${CI:-}${GITHUB_ACTIONS:-}" ] && exit 0

# Resolve symlinks: a path THROUGH a symlink into the canonical clone is fine,
# and is exactly what the old directory names now do.
ROOT=$(git rev-parse --path-format=absolute --git-common-dir); ROOT=${ROOT%/.git}
REAL=$(cd "$ROOT" && pwd -P)

# A worktree is ALWAYS fine, whichever clone owns it.
#
# 2026-08-23, and this was wrong for ten minutes on main: the test used $REAL,
# which comes from --git-common-dir and therefore points at the OWNING CLONE,
# not at the worktree. So every worktree of the second clone failed it, and this
# guard blocked twelve live Antigravity worktrees from committing at all.
#
# --show-toplevel is the worktree's own path, which is what the rule is actually
# about. The rule is "do not commit in a second clone's ROOT". A worktree pushes
# to the same remote and carries the same hooks, so which clone spawned it does
# not matter.
TOP=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
TOP=$(cd "$TOP" 2>/dev/null && pwd -P || echo "")
case "$TOP" in *"/.agent-trees/"*) exit 0 ;; esac

REMOTE=$(git config --get remote.origin.url 2>/dev/null || echo "")
case "$REMOTE" in
  *Smarter-Poker-Club-Arena*) CANON="$HOME/Documents/club-arena" ;;
  *Smarter-Poker-World-Hub*)  CANON="$HOME/Documents/Smarter-Poker-World-Hub" ;;
  *) exit 0 ;;  # no canonical path recorded for this repo yet
esac

CANON_REAL=$(cd "$CANON" 2>/dev/null && pwd -P || echo "")
[ -z "$CANON_REAL" ] && exit 0
[ "$REAL" = "$CANON_REAL" ] && exit 0

cat >&2 <<MSG

  ─────────────────────────────────────────────────────────────────────────
  THIS IS A SECOND CLONE OF A REPO THAT ALREADY HAS ONE.

    you are in : $REAL
    the one    : $CANON_REAL

  Every agent - Claude, Antigravity, any other - and the dev server all work in
  ONE clone per repository. Two clones drift, silently and fast. On 2026-08-23 a
  second Club Arena clone sat 293 commits behind while a dev server served it
  for two days, and everyone concluded the deploys were broken. They were not.

  Work you do here will not be seen by the other agents, will not be served by
  the dev server, and is not covered by the worktree guards.

  What to do instead:

      cd $CANON_REAL
      bash scripts/agent-workspace.sh <your-name> <branch-slug>

  That gives you your own isolated worktree off the canonical clone, with hooks,
  the approved commit identity and its own node_modules.

  If this checkout is deliberate and disposable:

      AGENT_CLONE_OK=1 git commit ...
  ─────────────────────────────────────────────────────────────────────────

MSG
exit 1
