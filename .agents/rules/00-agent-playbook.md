---
description: The one and only way agents ship code in this repo. Binding on Claude, Antigravity, Cowork and every other agent.
trigger: always_on
---

# RULE 1 — VERIFICATION PASS. Do not take your own word for it.

Every claim below needs a command behind it, and you must paste the output.

PART A — IS IT ACTUALLY SHIPPED?
git status --porcelain # must be empty of tracked files
git log --oneline origin/main..HEAD # must be empty
git branch -r --contains HEAD # must name your branch
gh pr list --head <your-branch> # must show a PR, or explain why not
# `gh` is NOT installed on the Mac. There, ask the API directly:
# curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
#   "https://api.github.com/repos/Smarter-Poker/<repo>/pulls?head=Smarter-Poker:<branch>&state=all"
# And MERGED IS NOT LANDED - the tick is not evidence, the files are:
# git fetch origin main && git cat-file -e origin/main:<path> && echo on-main
If any of those is wrong, you are not finished. Fix it before continuing.

PART B — DID YOU FOLLOW THE RULES?
pwd # must be under .agent-trees/
git log -1 --format='%an <%ae>' # must be Smarter-Poker # <254329056+...@users.noreply.github.com>
git log --oneline origin/main..HEAD | wc -l
State plainly whether you used --no-verify at any point. If you did, say where and why.

PART C — IS THE CODE ACTUALLY DONE? (THE INTERROGATION)
You must re-read your own diff before answering: `git diff origin/main...HEAD`

1. STUBS & MOCKS — Are there any TODO, FIXME, `throw new Error('not implemented')`, empty catch blocks, or hardcoded placeholders left behind? Run a search. Do not rely on memory.
2. WIRING & EXECUTION — Is every new function actually CALLED? Is every new component actually rendered? Is every route reachable? Name the exact caller for every single addition. Dead code is unacceptable.
3. DATABASE STATE — Did you write a migration? Was it actually APPLIED to production via the Supabase MCP? A migration file that hasn't run is a feature the database doesn't know exists.
4. COLLATERAL DAMAGE — What existing behavior did this change alter? Did you update the tests in the SAME commit, or did you leave them asserting the old rules?
5. HOSTILE STATE & CACHE — What happens if the user's `localStorage` is stale? What happens if they enter via a 6-month-old bookmark? Show exactly where the fallback or transition is handled in your code.
6. USER INTENT VERIFICATION — Did you actually solve the specific complaint the user raised? Explain step-by-step how your code definitively prevents the user's exact reported error sequence from ever happening again.

PART D — DOES IT RUN?
npx tsc --noEmit # paste the result
npx vitest run <the tests covering your change>
npm run build # if you touched src/
Paste real output. "Tests pass" without a count is not an answer.

PART E — IS IT LIVE?
If your PR merged: what SHA does production serve right now, and does it
contain your commit? Check it. Do not say "should be live shortly".
If your PR has not merged: what is blocking it, in the words of the
check that is failing?

ANSWER FORMAT: for each of A–E, either the command output showing it is
satisfied, or a plain statement of what is not done and what you are
doing about it. If something is incomplete, say so — an honest gap is
worth more than a confident claim I have to discover is wrong.

---

Every rule below exists because work was lost, a deploy was blocked, or the
platform stopped publishing. They are not preferences and they are not
negotiable. `AGENT-PLAYBOOK.md` at the repository root is the long form and is
byte-identical in all seven repos; `estate-integrity` checks that hourly.

---

## RULE 1 — YOU MUST PUSH AND PUBLISH. FINISHING IS MERGING.

A task is not finished when the code is written. It is finished when the commit
is on GitHub, the CI checks are green, and the PR is MERGED.

```bash
git push origin HEAD:refs/heads/<your-branch>
```

The pull request opens itself - `agent-open-pr.yml` fires on the push, for any
branch name. Do NOT run `gh pr create`: **`gh` is not installed on the Mac**
agents work on, so that command dies with `command not found` after the push has
already succeeded. On the Mac, ask the REST API with `curl` and the
`GITHUB_TOKEN` in `~/Documents/club-arena/.env`.

**YOU MUST NOT ORPHAN OR ABANDON YOUR WORK** - and you avoid that by PUSHING,
not by waiting. Push, report the branch and the pull request number, and END
YOUR SESSION. Autopilot merges it, the publisher ships it, and the watchdogs
verify it, all server-side, on infrastructure that does not care which account
you were.

**NEVER SET A TIMER, AND NEVER USE THE `schedule` TOOL.** This block used to
say the opposite - "Call `schedule` with `DurationSeconds=300`" - and it broke
two binding laws while not working:

- Club Arena `CLAUDE.md` 10.85 / World Hub 10.9, Dan verbatim: "MAKE IT A HARD
  LAW THAT NO OTHER AGENT SCHEDULES ANY CRITICAL TASK, WATCH DOG OR ANYTHING
  ELSE THERE". A scheduled task belongs to ONE Claude account and Dan works
  across several, so one installed from your session is unreachable from the
  next. It does not error and does not warn: it reports `enabled: true` and
  never fires again. `smarter-poker-cron-health` sat exactly like that from
  2026-06-17 for two and a half months while reading as healthy.
- Club Arena `CLAUDE.md` 10.8 rule 3: "NEVER SET A TIMER TO WATCH CI ... 'I've
  set another brief timer and will be back shortly' is the forbidden
  `wait_and_merge.sh` written in prose."

Checking ONCE at the end to say why something is BLOCKED is fine. Sitting in a
loop is not, and neither is force-pushing to make a red branch go green.

**MERGED IS NOT LANDED.** Autopilot squash-merges the moment the required
checks pass - under two minutes on a small change - so a SECOND push to that
branch lands on a closed pull request, exits 0, and reaches nobody. World Hub
#1387 shipped 1 of its 3 commits that way. A follow-up commit needs a NEW
BRANCH off current `main`, and you verify with the files rather than the tick:

```bash
git fetch origin main && git cat-file -e origin/main:<path> && echo on-main
```

## RULE 2 — STRICT GSD COMPLIANCE (WORKTREES ONLY).

**NEVER DEVELOP INSIDE THE SHARED CLONE (`~/Documents/club-arena` or `~/Documents/Smarter-Poker-World-Hub`).**
You must ALWAYS use the `/gsd-new-workspace` workflow (or the `scripts/agent-workspace.sh` script) to spin up an isolated Git worktree for your tasks.

```bash
cd ~/Documents/club-arena
git pull --ff-only
eval "$(bash scripts/agent-workspace.sh <your-name> fix/<short-slug>)"
```

If you make commits inside the shared clone, you break the estate. Work in `.agent-trees/` only.

## RULE 3 — ENFORCE SOURCE OF TRUTH (NO MANUAL COMPILED ASSETS).

Agents must NEVER manually commit compiled or minified `assets/*.js` files directly to `Smarter-Poker-World-Hub`.
Any updates to Club Arena must STRICTLY flow through a merged PR on the `club-arena` repository, followed by a clean, automated build-and-sync process (Vercel/GitHub Actions). Do not attempt to bypass the pipeline by copying bundled files into World Hub manually.

## RULE 4 — WHEN A GUARD REFUSES YOU, READ IT.

**`--no-verify` is FORBIDDEN.** It disables protections and causes work to be lost. Read the error and fix the problem (e.g., failing tests, bad commit author).

## RULE 5 — NEVER EVER ASK A HUMAN TO DO A TASK.

**DO NOT EVER ASK THE USER TO MANUALLY DO A TASK.**
You have every single credential (CLI, backend, DB access, GitHub, Supabase) to do every single task yourself.

- If a database migration needs to be run, YOU run it via `psql` or `supabase` CLI.
- If the database is timing out, retry it yourself now, or put the job on **Open Claw** (`scripts/openclaw-cron-dispatcher.py`) - never on the Claude `schedule` tool, which `CLAUDE.md` 10.85 bans because it reports `enabled: true` and never fires. Do not abandon the task and do not ask the user to "paste this in the Supabase SQL editor".
- If a server needs to be restarted, YOU restart it.
- If a PR needs to be merged, YOU merge it or wait for autopilot.
  Never tell Dan to run a command, pull a branch, start a server, open a PR, merge anything, or run a SQL query. If a step needs doing, DO IT YOURSELF.

## RULE 6 — REPORT ONLY WHAT YOU VERIFIED.

No claim without a command behind it. "Tests pass" means you ran them and can
paste the count. "It is deployed" means you checked what production serves.

## RULE 7 — FIX YOUR OWN BUILD. DO NOT WAIT FOR HELP.

If your PR fails CI, has a merge conflict, or gets blocked from deploying, **YOU MUST FIX IT YOURSELF IMMEDIATELY.**
Do not abandon the PR. Do not wait for another agent to fix it. Do not wait for a human to fix it.
Read the failing check, fix the cause, and push the fix.

Three corrections to how that used to read (2026-09-06):

- **Not `schedule`.** See RULE 1 - the tool is banned by `CLAUDE.md` 10.85 and
  silently never fires. Push the fix and end the session; autopilot re-runs the
  checks and merges when they are green.
- **Not a force-push, by default.** If your branch's pull request is still open,
  an ordinary push updates it. Force-pushing is what rewound `main` and dropped
  four commits already serving in production.
- **If the pull request already MERGED, a push to that branch changes nothing**
  and exits 0. Make a NEW BRANCH off current `main`. `scripts/guard-merged-branch.sh`
  refuses that push from `.husky/pre-push` and prints the recovery.

## RULE 8 — THE ZERO-ASSUMPTION DOCTRINE (PROOF OF RESOLUTION)

A green CI pipeline and a merged PR only prove your code does not crash. It **DOES NOT** prove you fixed the user's problem. You are forbidden from claiming success until you have verified the resolution in production.

- **NO SURFACE-LEVEL PATCHES:** You must track the bug to its absolute root cause. Fixing a symptom without checking for structural contagion (e.g., stale cache, inherited state, nested URL parameters) is a failure of your duty.
- **HOSTILE ENVIRONMENT TESTING:** You must assume the user's browser is a hostile environment: old `localStorage` data, expired tokens, stale bookmarks, and mid-flight network drops. If your fix relies on a pristine, freshly-cleared browser state to work, your fix is invalid.
- **BURDEN OF PROOF:** You may not tell the user "I fixed it." You must explicitly explain exactly _how_ you proved their exact edge case is eradicated.

## APPENDIX A — CI PIPELINE & REVERT GUARDS

Required (a PR cannot merge until these are green):

- **TypeScript Check**
- **Client Unit Tests (vitest)**
- **Server Engine (typecheck + tests)**
- **Production Build** — vite build + bundle budget. Deterministic.
- **CSS Beat E2E (multi-table + animations)** — Playwright against this commit's own build.

A green tick answers "did it merge". It does not answer "did it reach production". `.github/workflows/publish-watchdog.yml` asks production directly — it compares `build-info.json` against `main` after every publish attempt.

## APPENDIX B — A RESET CAN NO LONGER DESTROY A COMMIT OR AN EDIT

`.husky/reference-transaction` fires before any ref update lands and refuses one that would orphan local commits — and it writes them to `refs/wip/orphan-guard/<stamp>` first. `scripts/agent-trees-snapshot.sh` does the same for uncommitted edits every ten minutes.
If you deliberately need to move a ref backwards, say so: `AGENT_REF_GUARD_OK=1`.
