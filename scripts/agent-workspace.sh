#!/usr/bin/env bash

# ONE WORKING TREE PER AGENT. Never share a checkout.
#
# THE PROBLEM THIS SOLVES
# Several agents were operating in the same clone at once. A working tree has
# exactly one HEAD, one index and one set of uncommitted files, so when agent B
# runs `git checkout -b`, agent A's in-progress edits either travel onto B's
# branch or get stashed out from under it. Neither agent is told. The evidence
# was sitting in this repo: eight abandoned stashes and six `backup/*` branches,
# each one somebody's work being saved from somebody else's checkout.
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
# ── WORKTREES LIVE ON THE EXTERNAL SSD (2026-09-29) ────────────────────────
#
# AGENTS.md has said for weeks that agent worktrees belong on
# /Volumes/SmarterWork/agent-work. This script said otherwise, and this script
# is what agents actually run: its default put every tree it made under
# $HOME/Documents/.agent-trees. On 2026-09-29 the Mac carried 659 registered
# worktrees, 490 of them on the boot disk, which reached 100% of its container
# with 116 MiB left. Nothing announced itself as "disk full": npm ci died with
# ENOSPC inside a pre-push gate, vitest failed on temp files, and a merge
# resolved into a tree that could not be written. Agents spent hours on it.
#
# So the default follows the law: the SSD when it is mounted and writable, the
# old path only as a fallback for a machine that has no SSD attached, and
# AGENT_WORKTREE_ROOT still overrides both.
SSD_TREES="/Volumes/SmarterWork/agent-work"
if [ -n "${AGENT_WORKTREE_ROOT:-}" ]; then
  TREES="$AGENT_WORKTREE_ROOT"
elif [ -d "$SSD_TREES" ] && [ -w "$SSD_TREES" ]; then
  TREES="$SSD_TREES/$REPO"
else
  echo "note: $SSD_TREES is not mounted or not writable; falling back to the boot disk." >&2
  TREES="$HOME/Documents/.agent-trees/$REPO"
fi

SAFE_AGENT=$(printf '%s' "$AGENT" | tr -c 'A-Za-z0-9._-' '-')
BRANCH="agent/${SAFE_AGENT}/$(printf '%s' "$SLUG" | sed 's#^agent/[^/]*/##')"
DIR="$TREES/$SAFE_AGENT"

# ── THE COPY ON DISK IS NOT NECESSARILY THE ESTATE'S (2026-09-11) ───────────
#
# This script is invoked from the MAIN CLONE, and the main clone's working tree
# is not kept current by anything. On 2026-09-11 the Club Arena clone was 624
# commits behind origin/main with 408 staged entries left over from an
# abandoned index, and two separate things followed from it in one morning:
#
#   1. `./scripts/agent-workspace.sh` was 100644 there and refused to run,
#      while origin/main has had it 100755 all along.
#   2. The copy that DID run was the pre-2026-09-10 provisioner, which judges
#      node_modules against the MAIN CLONE's lockfile instead of the tree's -
#      the exact bug fixed in #4205 and synced to the Hub in #1735. Every tree
#      claimed from that clone would have come up short again.
#
# The worktree itself was never at risk: it is cut from origin/main a few lines
# below. The risk is entirely that the LOGIC doing the cutting is old, and an
# agent has no way to tell - the script prints a confident banner either way.
#
# So: fetch, compare this file against origin/main's, and if they differ, hand
# over to main's copy. The guard variable is what stops that being a loop, and
# it is set on the exec so a nested invocation inherits it.
#
# Deliberately NOT a warning. An agent reading a warning has to decide whether
# a 624-commit-old provisioner matters, with no information to decide it with.
git -C "$ROOT" fetch origin main --quiet 2>/dev/null || true
if [ -z "${AGENT_WORKSPACE_REEXEC:-}" ] && [ -r "$0" ]; then
  _MAIN_COPY=$(git -C "$ROOT" show origin/main:scripts/agent-workspace.sh 2>/dev/null || true)
  if [ -n "$_MAIN_COPY" ] && [ "$_MAIN_COPY" != "$(cat "$0")" ]; then
    # An older provisioner would reinstate the Mac copies/installs that the
    # user prohibited. Never hand this machine back to that implementation.
    if [ "$(uname -s)" = Darwin ] && [[ "$_MAIN_COPY" != *'# MAC_DEPENDENCIES_CI_ONLY_V1'* ]]; then
      echo "# origin/main has the older Mac dependency provisioner; refusing that handover" >&2
      echo "# use git worktree add directly; dependency installation belongs in CI" >&2
      exit 1
    fi
    _MAIN_SCRIPT=$(mktemp "${TMPDIR:-/tmp}/agent-workspace.XXXXXX")
    printf '%s\n' "$_MAIN_COPY" > "$_MAIN_SCRIPT"
    echo "# this copy of agent-workspace.sh differs from origin/main - running main's copy instead" >&2
    echo "#   (the clone at $ROOT is $(git -C "$ROOT" rev-list --count HEAD..origin/main 2>/dev/null || echo '?') commit(s) behind)" >&2
    AGENT_WORKSPACE_REEXEC=1 exec bash "$_MAIN_SCRIPT" "$@"
  fi
fi

# MAC_DEPENDENCIES_CI_ONLY_V1
# User policy, 2026-09-11: Mac worktrees receive no dependency copies or installs.
# APFS clones still grow when tools write them, and the fallback is a full copy.
# Superseded in part September 17: applicable local prechecks must run before
# push. The helper still never copies or installs Mac dependencies. Prepare
# exact locked dependencies explicitly in a unique owned SSD checkout after
# checking mounted/writable storage and ensuring node_modules is not shared.
# Existing shared tools may be read without mutation. Non-Mac behavior is unchanged.
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
# outright. This historical approach is no longer permitted on the Mac.
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
  if [ "$(uname -s)" = Darwin ]; then
    echo "# ${1:-.}/node_modules: automatic Mac provisioning disabled; prepare owned SSD dependencies for required local prechecks" >&2
    return 0
  fi
  # $1 = package dir relative to the repo root ("" for the root itself)
  local rel="$1"
  local src="$ROOT${rel:+/$rel}"
  local dst="$DIR${rel:+/$rel}"
  local label="${rel:-.}/node_modules"

  [ -d "$dst" ] || return 0
  # A directory is not a package. Without this, a branch where server/ exists
  # but carries no manifest still gets ~700 packages dropped into it.
  [ -f "$dst/package.json" ] || return 0

  [ -e "$dst/node_modules" ] && return 0

  # PRESENT IS NOT USABLE, at the source either (2026-09-08). The World Hub's
  # main clone held ONE package (typescript) after an interrupted install and a
  # rolled-back install, and every tree claimed that day cloned that one
  # package and came up with no `next`, no `tsc` and a dead pre-push hook.
  # So the source is judged by its payload, and when it fails the judgement
  # the freshest sibling tree whose lockfile matches the main clone's donates
  # instead. A donor with a different lockfile is not a donor: it would hand
  # this tree somebody else's dependency set.
  if ! node_modules_usable "$src/node_modules" "$rel"; then
    local donor
    donor="$(find_node_modules_donor "$rel")"
    if [ -n "$donor" ]; then
      echo "# $label: the main clone's copy is hollow; cloning from $donor instead" >&2
      src="${donor%/node_modules}"
      src="${src%"${rel:+/$rel}"}"
    elif [ -z "$rel" ] && [ -x "$ROOT/scripts/check-node-modules.sh" ]; then
      echo "# $label: the main clone's copy is hollow and no sibling can donate; repairing the main clone" >&2
      bash "$ROOT/scripts/check-node-modules.sh" 2>&1 | sed "s/^/#   /" >&2 || true
    fi
  fi

  if [ ! -d "$src/node_modules" ]; then
    # Silence here is how the server/ hole survived: nothing was provisioned
    # and nothing said so.
    echo "# $label: the main clone has none either - run 'npm ci' in ${rel:-the clone root}" >&2
    return 0
  fi

  # THE TREE'S OWN LOCKFILE IS THE JUDGE (2026-09-10). Usable is not current.
  # The Club Arena main clone sat 25 commits behind origin/main with 400 dirty
  # entries, and its install matched its OWN old lockfile perfectly - typescript,
  # tsc, 319 packages, every test above green - while the tree being claimed was
  # cut from origin/main and needed 430. Every tree cloned that day came up with
  # `tsc` failing on a package that was not there, and every agent ran `npm ci`
  # by hand after reading the same confusing error. The donor search could not
  # help: it compared candidates against the MAIN CLONE's lockfile, which was
  # the stale one. So the reference is the lockfile this tree will actually run
  # with, for the source and for every donor alike.
  if [ -f "$dst/package-lock.json" ] \
     && ! node_modules_matches_lockfile "$src/node_modules" "$dst/package-lock.json"; then
    local fresh
    fresh="$(find_node_modules_donor "$rel")"
    if [ -n "$fresh" ]; then
      echo "# $label: the main clone's install is behind this tree's lockfile; cloning from $fresh instead" >&2
      src="${fresh%/node_modules}"
      src="${src%${rel:+/$rel}}"
    else
      echo "# $label: no install on this machine matches this tree's lockfile; npm ci runs here after the clone" >&2
    fi
  fi

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
    mv "$tmp" "$dst/node_modules" && echo "# $label: cloned from $src (copy-on-write, no extra disk)" >&2
  elif cp -R "$src/node_modules" "$tmp" 2>/dev/null; then
    # Not APFS. Slower and it really does use the disk, but still ISOLATED,
    # which is the property that matters.
    mv "$tmp" "$dst/node_modules" && echo "# $label: copied from $src (no copy-on-write here)" >&2
  else
    rm -rf "$tmp" 2>/dev/null || true
    echo "# $label: could not be provisioned - run 'npm ci' in ${rel:-the tree root}" >&2
    return 0
  fi

  # A clone that does not satisfy this tree's lockfile is finished by npm, in
  # THIS tree, which the 2026-08-23 note above established is safe: the tree
  # owns its node_modules outright. About a minute, and it is the minute every
  # agent was already spending by hand, after a failed hook, without knowing why.
  if [ -f "$dst/package-lock.json" ] \
     && ! node_modules_matches_lockfile "$dst/node_modules" "$dst/package-lock.json"; then
    if command -v npm >/dev/null 2>&1; then
      echo "# $label: installing this tree's lockfile exactly (npm ci, about a minute)..." >&2
      (cd "$dst" && npm ci --no-audit --no-fund 2>&1 | tail -3 | sed "s/^/#   /" >&2) || true
      if node_modules_matches_lockfile "$dst/node_modules" "$dst/package-lock.json"; then
        echo "# $label: now matches this tree's lockfile" >&2
      else
        echo "# $label: STILL does not match this tree's lockfile - run 'npm ci' in ${rel:-the tree root} and read its output" >&2
      fi
    else
      echo "# $label: does not match this tree's lockfile and npm is not on PATH - run 'npm ci' in ${rel:-the tree root}" >&2
    fi
  fi
}

# Does an install satisfy a lockfile? npm records what it installed in
# node_modules/.package-lock.json; every top-level, non-optional package the
# lockfile names must be there at the lockfile's version. Optional packages are
# skipped on purpose: npm populates exactly one platform binary per family and
# leaves the other twenty-three directories empty by design. Without node the
# only honest answer is the two lockfiles being the same bytes.
node_modules_matches_lockfile() {
  local nm="$1" lock="$2"
  [ -f "$lock" ] || return 0
  [ -f "$nm/.package-lock.json" ] || return 1
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs");
      const have = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).packages || {};
      const want = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).packages || {};
      for (const [k, v] of Object.entries(want)) {
        if (!k.startsWith("node_modules/") || k.indexOf("node_modules/", 13) !== -1 || v.optional) continue;
        if (!have[k] || have[k].version !== v.version) process.exit(1);
      }
    ' "$nm/.package-lock.json" "$lock"
  else
    cmp -s "$(dirname "$nm")/package-lock.json" "$lock"
  fi
}

# A node_modules that can actually run the hooks and the build. The root needs
# the type checker binary and a real population; a nested package just needs
# more than a rolled-back handful.
node_modules_usable() {
  local nm="$1" rel="$2" n
  [ -d "$nm" ] || return 1
  n=$(ls "$nm" 2>/dev/null | wc -l | tr -d ' ')
  if [ -z "$rel" ]; then
    [ -f "$nm/typescript/package.json" ] || return 1
    [ -x "$nm/.bin/tsc" ] || return 1
    [ "$n" -ge 100 ] || return 1
  else
    [ "$n" -ge 5 ] || return 1
  fi
  return 0
}

# The freshest sibling tree with a usable node_modules AND a package-lock.json
# byte-identical to THIS TREE's (2026-09-10: it used to be the main clone's,
# which is the stale one whenever the main clone is behind), whose install
# satisfies that lockfile. Prints the node_modules path, or nothing.
find_node_modules_donor() {
  local rel="$1" cand nm best="" best_t=0 t
  local lock="$DIR${rel:+/$rel}/package-lock.json"
  [ -f "$lock" ] || lock="$ROOT${rel:+/$rel}/package-lock.json"
  [ -d "$TREES" ] || return 0
  for cand in "$TREES"/*/; do
    cand="${cand%/}"
    [ "$cand" = "$DIR" ] && continue
    nm="$cand${rel:+/$rel}/node_modules"
    node_modules_usable "$nm" "$rel" || continue
    cmp -s "$cand${rel:+/$rel}/package-lock.json" "$lock" || continue
    node_modules_matches_lockfile "$nm" "$lock" || continue
    t=$(stat -f %m "$nm" 2>/dev/null || stat -c %Y "$nm" 2>/dev/null || echo 0)
    if [ "$t" -gt "$best_t" ]; then best="$nm"; best_t="$t"; fi
  done
  [ -n "$best" ] && printf '%s\n' "$best"
  return 0
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
  # Repairing an existing shared link would mutate every consumer. On the Mac
  # this path must neither copy native packages nor remove incomplete ones.
  [ "$(uname -s)" = Darwin ] && return 0
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

if [ -d "$DIR" ] && git -C "$DIR" rev-parse --git-dir >/dev/null 2>&1; then
  # Reuse. Refuse to move an agent off work it has not committed - that is the
  # exact destruction this script exists to prevent.
  if [ -n "$(git -C "$DIR" status --porcelain)" ]; then
    CUR=$(git -C "$DIR" branch --show-current)
    echo "# NOTE: $DIR has uncommitted changes on '$CUR'." >&2
    echo "# Leaving it exactly as it is. Commit or push that work first." >&2

    # ── AND SAY HOW OLD IT IS, AND WHOSE IT IS (2026-08-31) ───────────────
    #
    # The two lines above protect the agent's uncommitted WORK, which is right,
    # and they are also the lines that quietly hand them a STALE BASE. The
    # fresh path below checks out from origin/main; this path deliberately does
    # not, so a tree reused days later is still branched wherever it was
    # branched, and nothing on screen says so.
    #
    # PR #2058 was built in exactly this state. The tree was 20 commits behind
    # and held four modified files belonging to a previous session. Another PR
    # had since changed an assertion in TournamentRecurringService.test.ts, so
    # CI failed on a test the agent never touched and could not see - and the
    # agent then guessed at the cause, which was the expensive part.
    #
    # This is a NOTE, not a refusal. Refusing here would strand exactly the
    # uncommitted work this block exists to protect, and rebasing is the
    # agent's call once their work is committed - never this script's, while
    # their edits are still loose on the floor. Failures are swallowed: a
    # missing upstream ref or a detached HEAD must never break a workspace
    # claim over a courtesy message.
    DIRTY_FILES=$(git -C "$DIR" status --porcelain | wc -l | tr -d ' ')
    echo "# $DIRTY_FILES uncommitted file(s) here. Run 'git status' before you stage:" >&2
    echo "# some of them may belong to whoever used this tree last, not to you." >&2
    BEHIND=$(git -C "$DIR" rev-list --count HEAD..origin/main 2>/dev/null || echo 0)
    if [ "${BEHIND:-0}" -gt 0 ]; then
      echo "# STALE BASE: this tree is $BEHIND commit(s) behind origin/main." >&2
      if [ "${BEHIND:-0}" -ge 10 ]; then
        echo "# That is far enough back to fail CI on tests you never touched." >&2
      fi
      echo "# Once your work is committed:  git -C '$DIR' merge origin/main" >&2
    fi
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
    node "$DIR/docs/agent-policy/agent-policy.mjs" check >&2
    echo "# Read current policy: node '$DIR/docs/agent-policy/agent-policy.mjs' read" >&2
    [ "$MODE" = "--print-path" ] && echo "$DIR" || echo "cd '$DIR'"
    exit 0
  fi
  CURRENT_BRANCH="$(git -C "$DIR" branch --show-current)"
  if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
    echo "workspace path $DIR already belongs to branch '$CURRENT_BRANCH'; choose a different agent name" >&2
    exit 1
  fi
else
  mkdir -p "$TREES"
  if git -C "$ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    echo "branch '$BRANCH' already exists without its expected worktree; choose a new slug" >&2
    exit 1
  fi
  git -C "$ROOT" worktree add -b "$BRANCH" "$DIR" origin/main >/dev/null
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
bash "$ROOT/scripts/check-node-modules.sh" --check 2>&1 | sed "s/^/# /" >&2 || true

# Every other guard in this estate queries GitHub, so all of them are blind to
# work that never reached it. Ten commits sat in worktrees for nineteen hours on
# 2026-08-23 and nothing noticed. An agent claiming a workspace is the most
# frequent moment anybody looks at this machine, so the scan happens here.
bash "$ROOT/scripts/check-unpushed-work.sh" --quiet 2>&1 | sed "s/^/# /" >&2 || true

# The freshness scan is the same argument one guard over, and until 2026-09-21
# it was the one with no reader at all. `.husky/pre-push` was its ONLY caller
# anywhere in this repo - no workflow references it - and
# `scripts/guard-shared-clone.sh` forbids pushing from ~/Documents/club-arena.
# So the single tree every Cowork agent is pointed at, and the tree an agent
# LOADS `CLAUDE.md` and `.claude/skills/**` out of, was the one tree the check
# never ran in. On 2026-09-21 it was found 258 commits and four days behind,
# serving the SUPERSEDED September 16 owner instruction: every agent that read
# it was told it was a read-only helper waiting in a numbered release queue,
# which the September 17 instruction on origin/main had already revoked.
#
# The jam was not the 2026-09-12 one. No commit sat on local main - HEAD was a
# clean ancestor of origin/main. 1218 tracked files were dirty, so
# `git merge --ff-only` refused with "Your local changes would be overwritten",
# and the estate runs it as `pull -q --ff-only` into a log nobody reads.
#
# Same placement and same reason as the scan above: an agent claiming a
# workspace is the most frequent moment anybody looks at this machine. ADVISORY
# and never blocking - CLAUDE.md 10.87 rule 1 is explicit that a freshness
# guard which can wedge every push is worse than the staleness it reports.
bash "$ROOT/scripts/check-checkout-freshness.sh" --quiet 2>&1 | sed "s/^/# /" >&2 || true

provision_all_package_roots
verify_all_native_deps

node "$DIR/docs/agent-policy/agent-policy.mjs" check >&2
echo "# Read current policy: node '$DIR/docs/agent-policy/agent-policy.mjs' read" >&2
echo "# worktree: $DIR" >&2
echo "# branch:   $BRANCH  (from origin/main)" >&2
if [ "$MODE" = "--print-path" ]; then
  echo "$DIR"
else
  echo "cd '$DIR'"
fi
