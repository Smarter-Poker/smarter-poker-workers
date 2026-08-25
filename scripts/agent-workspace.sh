#!/usr/bin/env bash

# .husky/reference-transaction refuses a ref update that would orphan local
# commits. This script moves refs backwards as part of its job, so it
# announces the intent rather than the guard learning to ignore a command
# shape. See that hook for what it saves before it refuses.
export AGENT_REF_GUARD_OK=1
# ONE WORKING TREE PER AGENT. Never share a checkout.
#
# THE PROBLEM THIS SOLVES
# Several agents were operating in the same clone at once. A working tree has
# exactly one HEAD, one index and one set of uncommitted files, so when agent B
# runs `git checkout -b`, agent A's in-progress edits either travel onto B's
# branch or get stashed out from under it. Neither agent is told. The evidence
# was sitting in this repo: eight abandoned stashes and six `backup/*` branches
# from `git-unstick.sh` rescues, each one somebody's work being saved from
# somebody else's checkout.
#
# Branch protection cannot help here. This damage happens before anything is
# pushed, and the Antigravity `git reset --hard origin/main` loop then destroys
# whatever is still uncommitted at that moment.
#
# A git worktree gives each agent its own directory, HEAD, index and branch,
# sharing one object store. Agents become physically unable to disturb one
# another.
#
# USAGE
#   eval "$(bash scripts/agent-workspace.sh claude fix/leaderboard-rpc)"
#   # -> creates/reuses a worktree and cd's you into it
#
# Or just read the path it prints:
#   bash scripts/agent-workspace.sh claude fix/leaderboard-rpc --print-path
set -euo pipefail

AGENT="${1:-}"
SLUG="${2:-}"
MODE="${3:-}"

if [ -z "$AGENT" ] || [ -z "$SLUG" ]; then
  echo "usage: agent-workspace.sh <agent-name> <branch-slug> [--print-path]" >&2
  echo "   eg: agent-workspace.sh claude fix/leaderboard-rpc" >&2
  exit 2
fi

# Resolve the main clone regardless of which worktree we were invoked from.
ROOT=$(git rev-parse --path-format=absolute --git-common-dir)
ROOT=${ROOT%/.git}
REPO=$(basename "$ROOT")
TREES="${AGENT_WORKTREE_ROOT:-$HOME/Documents/.agent-trees/$REPO}"

SAFE_AGENT=$(printf '%s' "$AGENT" | tr -c 'A-Za-z0-9._-' '-')
BRANCH="agent/${SAFE_AGENT}/$(printf '%s' "$SLUG" | sed 's#^agent/[^/]*/##')"
DIR="$TREES/$SAFE_AGENT"

# Share the main clone's dependencies. The alternative is an npm install per
# tree - minutes each, gigabytes across 47 trees - or a test gate that silently
# skips, which is how a red test reaches main and blocks the bundle for all.
# node_modules: a COPY-ON-WRITE CLONE, never a symlink.
#
# 2026-08-23. This used to be `ln -s`, and a symlink is not a safe thing to hand
# an agent, because npm WRITES THROUGH IT. `npm ci` deletes node_modules before
# reinstalling, so one `npm ci` in one worktree deleted the MAIN CLONE's install
# that all 79 trees share. tsc and vitest vanished everywhere at once, agents
# reasonably concluded their own tree was broken, and ran npm ci again - which
# is a loop that sustains itself. It gutted the shared tree three times in one
# afternoon, and two separate agents reported it independently.
#
# `cp -Rc` is an APFS clone: about five seconds, and copy-on-write, so it costs
# no real disk until something modifies it. Each tree now owns its node_modules
# outright, which means `npm ci` in a worktree is simply SAFE - the thing agents
# were doing all along.
#
# 2026-08-25: EVERY PACKAGE ROOT, AND ON EVERY ENTRY - NOT JUST AT CREATION.
#
# Two holes, both measured on this machine:
#
#   1. This block only ever knew about the repo root. `server/` is its own
#      package with its own node_modules, and NOTHING provisioned it, so
#      124 of 162 Club Arena trees could not run the ENGINE's tsc or vitest
#      at all. That is the highest-stakes code in the repo, and the pre-push
#      hook responds to a missing vitest by printing a WARNING and skipping
#      the test gate - so "NEVER PUSH A RED TEST" was unenforceable in the
#      large majority of trees, silently, for anyone touching server/**.
#      A gate that has quietly stopped running looks exactly like a gate
#      with nothing to complain about.
#
#   2. It ran only when the tree was first created. Provisioning takes a few
#      seconds, and an agent whose session is interrupted inside that window
#      leaves an unprovisioned tree that NOTHING ever repairs - it is skipped
#      forever after, because the `git worktree add` has already happened.
#      That is where the 8 trees with no root node_modules came from.
#
# So: provision every package root, every time this script is run, and repair
# what is missing rather than assuming creation succeeded. Cloning is a no-op
# when the directory is already there, so the steady-state cost is one `[ -e ]`
# per package root.
provision_node_modules() {
  # $1 = package dir relative to the repo root ("" for the root itself)
  local rel="$1"
  local src="$ROOT${rel:+/$rel}"
  local dst="$DIR${rel:+/$rel}"
  local label="${rel:-.}/node_modules"

  [ -d "$dst" ] || return 0
  # A directory is not a package. Without this, a branch where server/ exists
  # but carries no manifest still gets ~700 packages dropped into it.
  [ -f "$dst/package.json" ] || return 0

  if [ ! -d "$src/node_modules" ]; then
    # Silence here is how the server/ hole survived: nothing was provisioned
    # and nothing said so.
    echo "# $label: the main clone has none either - run 'npm ci' in ${rel:-the clone root}" >&2
    return 0
  fi

  [ -e "$dst/node_modules" ] && return 0

  # ATOMIC, because `[ -e ]` above is a presence test and not a completeness
  # test. Copying straight to the destination means any interruption - a killed
  # session, a full disk, a TCC prompt - leaves a partial tree that every later
  # run then treats as provisioned forever. That is the exact hole this block
  # was written to close, and the first version of it reintroduced the hole one
  # line below the fix. Build beside the target, then rename.
  #
  # It also means we never copy ONTO an existing directory, which is what
  # produces node_modules/node_modules and poisons a tree permanently.
  local tmp="$dst/.node_modules-provision.$$"
  rm -rf "$dst"/.node_modules-provision.* 2>/dev/null || true

  if cp -Rc "$src/node_modules" "$tmp" 2>/dev/null; then
    mv "$tmp" "$dst/node_modules" && echo "# $label: cloned from the main clone (copy-on-write, no extra disk)" >&2
  elif cp -R "$src/node_modules" "$tmp" 2>/dev/null; then
    # Not APFS. Slower and it really does use the disk, but still ISOLATED,
    # which is the property that matters.
    mv "$tmp" "$dst/node_modules" && echo "# $label: copied from the main clone (no copy-on-write here)" >&2
  else
    rm -rf "$tmp" 2>/dev/null || true
    echo "# $label: could not be provisioned - run 'npm ci' in ${rel:-the tree root}" >&2
  fi
}

# EVERY package root, discovered rather than listed. The first version of this
# was `for _pkg in server`, under a comment promising "every nested package that
# carries its own manifest" - so the next package added would have been silently
# unprovisioned, which is the same failure one package later.
provision_all_package_roots() {
  provision_node_modules ""
  while IFS= read -r _manifest; do
  [ -n "$_manifest" ] || continue
  provision_node_modules "${_manifest%/package.json}"
  done <<EOF_PKGS
$(cd "$ROOT" 2>/dev/null && find . -name package.json \
    -not -path '*/node_modules/*' -not -path './.git/*' \
    -not -path './.cowork-trees/*' -not -path './.agent-trees/*' \
    -mindepth 2 -maxdepth 3 2>/dev/null | sed 's|^\./||')
EOF_PKGS
  unset _manifest
}

# ── PRESENT IS NOT THE SAME AS USABLE (2026-08-25) ──
#
# A swarm agent lost a session to this: its provisioned server/node_modules
# contained @rollup/rollup-darwin-arm64 as an EMPTY DIRECTORY, so vitest died
# at startup with ERR_MODULE_NOT_FOUND and the tree looked fully provisioned by
# every check we had. The empty directory came from the main clone - the repo
# root had the real .node binary and server/ had the hollow shell - so every
# tree cloned from it inherited a server test runner that could not start.
#
# That is the same lie as `[ -e node_modules ]`, one level down: the thing is
# there, and it does not work. Platform-native optional dependencies are where
# it bites, because npm installs exactly one per platform and a partial or
# interrupted install leaves the directory without its binary.
#
# So verify the payload, not the path. Repair from whichever copy in this
# repository actually has the binary.
verify_native_deps() {
  local dst="$1"
  [ -d "$dst/node_modules" ] || return 0

  # ONLY THIS PLATFORM'S PACKAGE. npm creates a directory for every platform in
  # optionalDependencies and populates exactly one - the host's. So 23 of the 24
  # @esbuild/* directories are empty ON PURPOSE, and a check that calls an empty
  # directory broken invents two dozen faults and buries the one real one.
  local plat
  plat="$(node -p 'process.platform + "-" + process.arch' 2>/dev/null)" || return 0
  [ -n "$plat" ] || return 0

  local pkg name donor cand
  for pkg in "$dst/node_modules/@rollup/rollup-$plat" "$dst/node_modules/@esbuild/$plat"; do
    [ -d "$pkg" ] || continue

    # HOLLOW is the signature, not "no .node" - rollup ships a .node and esbuild
    # ships bin/esbuild, so testing for one file type invents a fault in the
    # other. A package npm left half-installed has its manifest and nothing to
    # run. Count the payload instead.
    [ -n "$(find "$pkg" -type f ! -name 'package.json' ! -name 'README.md' ! -name 'LICENSE*' 2>/dev/null | head -1)" ] && continue

    name="$(basename "$pkg")"
    donor=""
    for cand in "$ROOT/node_modules/@rollup/rollup-$plat" "$ROOT/node_modules/@esbuild/$plat" \
                "$ROOT/server/node_modules/@rollup/rollup-$plat" "$ROOT/server/node_modules/@esbuild/$plat"; do
      [ -d "$cand" ] || continue
      [ "$(basename "$cand")" = "$name" ] || continue
      [ -n "$(find "$cand" -type f ! -name 'package.json' ! -name 'README.md' ! -name 'LICENSE*' 2>/dev/null | head -1)" ] \
        && { donor="$cand"; break; }
    done

    if [ -n "$donor" ]; then
      rm -rf "$pkg" 2>/dev/null
      cp -Rc "$donor" "$pkg" 2>/dev/null || cp -R "$donor" "$pkg" 2>/dev/null
      echo "# native dep repaired: $name (it was installed empty)" >&2
    else
      echo "# native dep $name is empty and no good copy exists in this repo - run 'npm ci'" >&2
    fi
  done
  return 0
}

verify_all_native_deps() {
  verify_native_deps "$DIR"
  [ -d "$DIR/server" ] && verify_native_deps "$DIR/server"
  return 0
}


git -C "$ROOT" fetch origin main --quiet

# ── SNAPSHOT EVERY OTHER TREE BEFORE TOUCHING ANYTHING ──────────────────────
#
# The ten-minute launchd snapshot is the intended safety net, and on a Mac that
# has not granted Full Disk Access it captures NOTHING: ~/Documents is
# TCC-protected, so an unprivileged launchd agent may stat a path inside it but
# not open one. Measured 2026-08-22 — 73 runs, zero snapshots, while nine trees
# held uncommitted work.
#
# THIS script runs in an agent's own shell, which does have that access. And it
# runs at exactly the right moment: an agent arriving is precisely when another
# agent's uncommitted work is most likely to be disturbed. So take the snapshot
# here too.
#
# Deliberately unfailable and silent: `|| true` and output discarded, because a
# safety net must never be the reason a workspace claim fails. It costs about a
# second. If you want to see what it captured:
#   bash scripts/agent-trees-snapshot.sh --list
SNAP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent-trees-snapshot.sh"
[ -f "$SNAP" ] && (cd "$ROOT" && bash "$SNAP" >/dev/null 2>&1) || true

if [ -d "$DIR" ] && git -C "$DIR" rev-parse --git-dir >/dev/null 2>&1; then
  # Reuse. Refuse to move an agent off work it has not committed - that is the
  # exact destruction this script exists to prevent.
  if [ -n "$(git -C "$DIR" status --porcelain)" ]; then
    CUR=$(git -C "$DIR" branch --show-current)
    echo "# NOTE: $DIR has uncommitted changes on '$CUR'." >&2
    echo "# Leaving it exactly as it is. Commit or push that work first." >&2
    # DEPENDENCIES ARE STILL REPAIRED ON THE WAY OUT (2026-08-25).
    #
    # This early return protects the agent's uncommitted WORK, which is right.
    # But it used to skip provisioning too, and provisioning touches no tracked
    # file, no branch and no index - it only adds node_modules that is missing.
    # So the one moment an agent most needs a repair (mid-task, tests suddenly
    # not running) was the one moment this script refused to give them one, and
    # re-running it looked like a no-op.
    #
    # A swarm agent lost a session to exactly that: a hollow
    # @rollup/rollup-darwin-arm64 in its server/node_modules, vitest dead at
    # startup, and a workspace script that said "leaving it as it is" and did.
    provision_all_package_roots
    verify_all_native_deps
    [ "$MODE" = "--print-path" ] && echo "$DIR" || echo "cd '$DIR'"
    exit 0
  fi
  git -C "$DIR" checkout -q -B "$BRANCH" origin/main
else
  mkdir -p "$TREES"
  # -B moves the branch to origin/main if it already exists, and creates it
  # otherwise. --force lets one agent re-take a branch name it owns.
  git -C "$ROOT" worktree add --force -B "$BRANCH" "$DIR" origin/main >/dev/null
fi

# The one identity this estate can deploy under. Vercel refuses to build a
# commit whose author it cannot resolve to a GitHub user; the deployment goes
# to BLOCKED with no logs. Setting it here means an agent cannot get it wrong,
# and scripts/guard-commit-identity.sh catches anyone working outside this tree.
git -C "$DIR" config user.name  "Smarter-Poker"
git -C "$DIR" config user.email "254329056+Smarter-Poker@users.noreply.github.com"

# HOOKS AND DEPENDENCIES BEFORE THE FIRST COMMIT, NOT AFTER.
# 2026-08-23: a fresh worktree had neither, and both failures were silent.
# core.hooksPath pointed at the gitignored .husky/_, so git ran no hooks here at
# all; and with no node_modules the hooks that did run went to the network.
bash "$ROOT/scripts/ensure-hooks.sh" 2>&1 | sed "s/^/# /" >&2 || true

# The link above is shared, and npm run inside ANY worktree writes through it.
# Twice on 2026-08-23 that left ~285 package directories empty and broke the
# hooks in every tree at once, with only an ERR_MODULE_NOT_FOUND to go on.
# Probe it here - the one moment an agent is guaranteed to be looking - and
# repair rather than report.
bash "$ROOT/scripts/check-node-modules.sh" 2>&1 | sed "s/^/# /" >&2 || true

# Every other guard in this estate queries GitHub, so all of them are blind to
# work that never reached it. Ten commits sat in worktrees for nineteen hours on
# 2026-08-23 and nothing noticed. An agent claiming a workspace is the most
# frequent moment anybody looks at this machine, so the scan happens here.
bash "$ROOT/scripts/check-unpushed-work.sh" --quiet 2>&1 | sed "s/^/# /" >&2 || true

provision_all_package_roots
verify_all_native_deps

echo "# worktree: $DIR" >&2
echo "# branch:   $BRANCH  (from origin/main)" >&2
if [ "$MODE" = "--print-path" ]; then
  echo "$DIR"
else
  echo "cd '$DIR'"
fi
