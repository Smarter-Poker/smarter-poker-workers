---
description: Always-on, BINDING rules for every agent in every Smarter-Poker repo. Not advice. Each rule exists because something was destroyed without it.
trigger: always_on
---

# BINDING RULES — NOT ADVICE

Every rule below exists because work was lost, a deploy was blocked, or the
platform stopped publishing. They are not preferences and they are not
negotiable. `AGENT-PLAYBOOK.md` at the repository root is the long form and is
byte-identical in all seven repos; `estate-integrity` checks that hourly.

---

## RULE 1 — YOU MUST PUSH. FINISHING IS PUSHING.

A task is not finished when the code is written. It is finished when the commit
is on GitHub.

```bash
git push -u origin HEAD && gh pr create --fill
```

Then stop. Autopilot enables squash auto-merge and GitHub merges it when the
required checks go green. **You never merge, and you never wait.**

On 2026-08-23, ten commits across seven branches sat on this Mac for up to
nineteen hours — the union Spin reserve, spin rake parity, the horse busy-set
query. Every watchdog in this estate queries GitHub, so not one of them could
see it. A commit that has not been pushed is invisible to every protection we
have and is one `git reset --hard` from gone.

**Before you report a task complete you MUST run:**

```bash
git status --porcelain          # must be empty of tracked changes
git log --oneline origin/main..HEAD   # must be empty, or your branch is pushed
```

## RULE 2 — YOU MUST WORK IN YOUR OWN WORKTREE.

```bash
cd ~/Documents/club-arena       # or ~/Documents/Smarter-Poker-World-Hub
git pull --ff-only              # the clone SHIPS the tooling. Stale clone,
                                # stale tooling. This step is not optional.
eval "$(bash scripts/agent-workspace.sh <your-name> fix/<short-slug>)"
```

You get hooks live, the approved commit identity, and your own `node_modules`.
It also scans the machine for unpushed work — **read that output.**

**NEVER edit files in `~/Documents/club-arena` itself.** Twice on 2026-08-23
substantial uncommitted work was found sitting there — wallet, cashier,
`server/src/index.ts`, popup styling. `pre-commit` refuses commits in that
directory, so it could never have been committed where it sat, and the clone
was behind: the next fast-forward would have destroyed it.

## RULE 3 — THESE TWO PATHS ARE THE ONLY ONES.

```
~/Documents/club-arena                 Club Arena
~/Documents/Smarter-Poker-World-Hub    World Hub
```

`hub-vanguard`, `hub-vanguard3` and `hub-vanguard-clean` are symlinks to World
Hub — your existing paths still work. `~/Documents/Smarter-Poker-Club-Arena` is
a second Club Arena clone that still exists; **start no new work in it.** When
your current branch merges, claim your next workspace from `~/Documents/club-arena`.

Never `git clone` a repo that already has a clone here.

## RULE 4 — WHEN A GUARD REFUSES YOU, READ IT.

| Refused                                                                                 | Because                                                                                                     |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Commit in a second clone's root                                                         | Two clones drift, silently and fast                                                                         |
| Commit in the shared clone                                                              | One HEAD, one index — the next agent's checkout takes your work                                             |
| Commit as anyone but `Smarter-Poker <254329056+Smarter-Poker@users.noreply.github.com>` | Vercel refuses to BUILD a commit it cannot attribute, and refuses it silently. Five deployments sat BLOCKED |
| Pushing a red test                                                                      | `vitest run tests/` is what PUBLISHES the bundle. A red test stops the deploy for everyone                  |

Every one prints the exact command that fixes it.

**`--no-verify` is FORBIDDEN.** It disables all of the above at once, and every
one of them exists because something was lost.

## RULE 5 — NEVER HAND WORK BACK TO A HUMAN.

Never tell Dan to run a command, pull a branch, start a server, open a PR or
merge anything. If a step needs doing, do it.

Never say "this should be live shortly", "deploy triggered" or "pushed
successfully". Either verify production is serving your SHA, or state precisely
what stopped you and what you tried.

## RULE 6 — REPORT ONLY WHAT YOU VERIFIED.

No claim without a command behind it. "Tests pass" means you ran them and can
paste the count. "It is deployed" means you checked what production serves.

---

## TWO THINGS THAT CHANGED — STOP WORKING AROUND THEM

**`npm ci` in your own worktree is safe now.** Worktrees used to share the main
clone's `node_modules` through a symlink, and `npm ci` deletes `node_modules`
before reinstalling — so one `npm ci` wiped the install all 104 trees shared,
`tsc` and `vitest` vanished everywhere at once, and every agent ran `npm ci`
again to fix it. That loop gutted the shared tree three times in one afternoon.
Each tree now gets its own copy-on-write clone.

**`npm run dev` checks freshness itself.** Behind with a clean tree it
fast-forwards and prints what arrived; behind with uncommitted changes it
refuses and gives you the two commands. You no longer pull first — but see
RULE 2: you still pull before claiming a workspace.

---

**IF YOU ARE LOST:** `AGENT-PLAYBOOK.md` at the repository root.
