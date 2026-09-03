# RULE 0 — "EM BARS" MEANS EM DASHES (—), NOT HAMBURGER BARS

Dan, 2026-08-20: **"forbid the use of em bars anywhere."** He means the
PUNCTUATION MARK, U+2014. It is a rule about the characters inside copy.

It says nothing about artwork or icons, and **it does not ban the hamburger
menu.** Misreading it as "horizontal bars are banned" has removed the hamburger
from every page of the app twice in two days (#2321, then #2429 after #2401
reverted the first). Both times Dan opened the app and found a different icon
where his menu button used to be. Both times the agent that did it believed it
was enforcing a house rule.

**If the word "bars" leads you toward an icon, a raster, an SVG path or a
header composite, you have misread it.** The hamburger is the menu. See
`CLAUDE.md` §10.7 and `tests/approvedHamburgerGearGuard.law.test.ts`.

---

# RULE 1 — VERIFICATION PASS. Do not take your own word for it.

Every claim below needs a command behind it, and you must paste the output.

PART A — IS IT ACTUALLY SHIPPED?
git status --porcelain # must be empty of tracked files
git log --oneline origin/main..HEAD # must be empty
git branch -r --contains HEAD # must name your branch
gh pr list --head <your-branch> # must show a PR, or explain why not
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
5. HOSTILE STATE & CACHE — What happens if the user's localStorage is stale? What happens if they enter via a 6-month-old bookmark? Show exactly where the fallback or transition is handled in your code.
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

## RULE 8 — THE ZERO-ASSUMPTION DOCTRINE (PROOF OF RESOLUTION)

A green CI pipeline and a merged PR only prove your code does not crash. It **DOES NOT** prove you fixed the user's problem. You are forbidden from claiming success until you have verified the resolution in production.

- **NO SURFACE-LEVEL PATCHES:** You must track the bug to its absolute root cause. Fixing a symptom without checking for structural contagion (e.g., stale cache, inherited state, nested URL parameters) is a failure of your duty.
- **HOSTILE ENVIRONMENT TESTING:** You must assume the user's browser is a hostile environment: old `localStorage` data, expired tokens, stale bookmarks, and mid-flight network drops. If your fix relies on a pristine, freshly-cleared browser state to work, your fix is invalid.
- **BURDEN OF PROOF:** You may not tell the user "I fixed it." You must explicitly explain exactly _how_ you proved their exact edge case is eradicated.

---

# AGENT PLAYBOOK

**Read this before you touch anything.** Claude, Antigravity, Cowork, Codex,
any agent, any repo in this estate. It is byte-identical in all seven repos and
`.github/scripts/estate-integrity.sh` checks hourly that it still is.

Last rebuilt 2026-08-22. It exists because work kept disappearing — deleted by
another agent's checkout, orphaned by a reset, merged but never published, or
finished and simply never proposed. Every rule below is one of those, fixed.

---

## 1. THE THIRTY-SECOND VERSION

```bash
# 1. Claim your own working tree. NEVER work in the shared clone.
eval "$(bash scripts/agent-workspace.sh <your-agent-name> fix/<short-slug>)"

# 2. Do the work. Commit normally.
git add -A && git commit -m "fix(scope): what changed"

# 3. Push and open a pull request.
git push -u origin HEAD && gh pr create --fill

# 4. STOP. You are done.
```

Autopilot enables squash auto-merge within seconds, keeps the branch fresh, and
GitHub merges it the moment the required checks are green. **You never merge.**

If you do only one thing from this document, do step 1. Sharing a checkout is
the single largest cause of destroyed work here.

---

## 1b. ONE CLONE PER REPO. THESE EXACT PATHS.

```
~/Documents/club-arena                 Club Arena
~/Documents/Smarter-Poker-World-Hub    World Hub
```

Every agent — Claude, Antigravity, any other — and the dev server work in those
two directories and nowhere else. You never work in them directly; you claim a
worktree off them:

```bash
cd ~/Documents/club-arena
eval "$(bash scripts/agent-workspace.sh <your-name> fix/<slug>)"
```

**Why this is a rule and not a preference.** On 2026-08-23 this machine had SIX
clones of these two repos — `Smarter-Poker-Club-Arena`, `hub-vanguard`,
`hub-vanguard3`, `hub-vanguard-clean`. Claude worked in one, Antigravity in
another, the dev server ran from a third. `Smarter-Poker-Club-Arena` drifted
**293 commits behind** while a Vite process served it, and two days were spent
believing deploys were broken. They were not; the work was live the whole time.

The old directory names are now **symlinks** to the canonical clone, so any
path you already have memorised still works and lands in the right tree.
`scripts/check-canonical-clone.sh` refuses a commit made in a fresh duplicate,
which is how all six started.

---

## 2. THE SEVEN REPOS

| Repo                          | What it is                                                                                                 | Publishes to                                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `Smarter-Poker-Club-Arena`    | Vite + React poker SPA. The canonical repo — estate-wide tooling lives here first                          | `smarter.poker/hub/club-arena/` — published to its own origin `ca-static.smarter.poker`, which the World Hub rewrites to (2026-09-03) |
| `Smarter-Poker-World-Hub`     | Next.js app. **Serves production.**                                                                        | `smarter.poker` via Vercel                                                                                                            |
| `smarter-poker-commander`     | Venue/floor management                                                                                     | Vercel                                                                                                                                |
| `commander-shared`            | Shared npm package                                                                                         | GitHub Packages                                                                                                                       |
| `smarter-poker-workers`       | Scheduled job workers                                                                                      | Hetzner                                                                                                                               |
| `Smarter-Poker-Diamond-Arena` | **Parked.** Becomes a 1:1 Club Arena clone (no clubs/unions, diamonds instead) once Club Arena is finished | Vercel                                                                                                                                |
| `PepNationLab`                | Separate product. Never mix its credentials with smarter.poker's                                           | Vercel                                                                                                                                |

---

## 3. WHAT PROTECTS YOU, AND WHERE IT LIVES

Every one of these is in every repo. You do not need to run them; you need to
not break them, and to know what they are telling you when they speak.

### Your work cannot be destroyed

| File                                                               | What it does                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/agent-workspace.sh`                                       | Gives you your own git worktree, branched from fresh `origin/main`. Refuses to move you off uncommitted work                                                                                                                                                                                                                                                                                                             |
| `.husky/pre-commit` & `pre-push` → `scripts/guard-shared-clone.sh` | **Refuses a commit or push made in the shared clone.** Prints the exact command to get a proper tree. Never stashes, never checks anything out                                                                                                                                                                                                                                                                           |
| `.husky/reference-transaction`                                     | Fires _before_ any ref update lands and refuses one that would orphan local commits — **and writes them to `refs/wip/orphan-guard/<stamp>` first**, so even an override leaves the work recoverable                                                                                                                                                                                                                      |
| `scripts/agent-trees-snapshot.sh`                                  | Snapshots every working tree's uncommitted state as a git ref. Safe mid-edit: `git stash create` builds objects without touching the index, the tree, or the stash stack                                                                                                                                                                                                                                                 |
| `scripts/install-wip-snapshot-agent.sh`                            | Runs that snapshot every 10 minutes as a launchd agent — **once the Mac has granted Full Disk Access**. `~/Documents` is TCC-protected and a launchd agent cannot read inside it without that; on 2026-08-22 this had captured nothing in 73 runs. `--status` now says which state it is in, and the installer refuses to claim success. Until it is granted, run the snapshot by hand at the start and end of a session |
| `scripts/agent-trees-audit.sh`                                     | Lists every tree holding work that exists in exactly one place                                                                                                                                                                                                                                                                                                                                                           |

```bash
bash scripts/agent-trees-audit.sh              # what is at risk right now
bash scripts/agent-trees-snapshot.sh --list    # what has been captured
git checkout -b rescue refs/wip/<...>          # recover any of it
```

### Your work cannot silently fail to ship

| File                                     | What it does                                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/agent-autopilot.yml`  | Enables squash auto-merge on every PR; sweeps every 10 minutes                                                                                                                        |
| `.github/scripts/queue-pr.sh`            | Squash only, never `--admin`                                                                                                                                                          |
| `.github/scripts/report-stuck-prs.sh`    | Names every PR that cannot merge **and every branch pushed but never proposed**, in one self-closing issue per repo. Opens a PR automatically for an `agent/*` branch under a day old |
| `.github/workflows/publish-watchdog.yml` | Asks **production** what it is serving and compares it to `main`. Self-heals once per sha (Club Arena), diagnoses via the Vercel API (World Hub)                                      |
| `.github/workflows/estate-integrity.yml` | Checks hourly that all seven repos still have their rulesets, no unexpected bypass actors, byte-identical guards, and a live Autopilot                                                |

### Your work cannot regress silently

| File                                            | What it does                                                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `tests/shipped-invariants.test.ts` (Club Arena) | Pins behaviour that shipped and is expensive to lose — anchored on the RPC name, route or file, never on phrasing            |
| `scripts/ci/check-migrations-applied.mjs`       | **A migration this branch adds must already exist in the live schema.** Reads `ALTER TABLE … ADD COLUMN` as well as `CREATE` |
| `.github/workflows/silent-revert-guard.yml`     | Catches a merge that quietly undoes a previous one                                                                           |

---

## 4. WHERE THE CREDENTIALS ARE

**No secret value is ever written in a file in these repos.** Several are
public. If you are looking for a value, you are looking in the wrong place —
look for the _name_ and read it from where it lives.

| What                                                 | Where it lives                                                                                   | How to use it                                                                                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub App **Smarter-Poker-Autopilot**, id `4680372` | `vars.AUTOPILOT_APP_ID` + `secrets.AUTOPILOT_APP_PRIVATE_KEY` in **all 7 repos**                 | Workflows mint a fresh installation token per run via `actions/create-github-app-token@v1`. **It cannot expire.** This is the merge and publish credential                             |
| `GH_PAT`                                             | Repo secret, all 7                                                                               | Legacy fallback only. **Expires 2026-11-19.** Nothing should depend on it                                                                                                              |
| `GITHUB_TOKEN`                                       | Automatic                                                                                        | Issue writes only (`GH_TOKEN_ISSUES`). **Never for merges** — a merge made with it does not trigger downstream workflows, so the commit lands and never publishes                      |
| Supabase service role                                | `secrets.SUPABASE_SERVICE_ROLE_KEY` (CI) · `.env.local` (local, gitignored) · Supabase dashboard | Project `kuklfnapbkmacvwxktbh` for smarter.poker. PepNationLab is `ydsaqnnuwyvtyxgvrnys` — **never cross them**                                                                        |
| Vercel                                               | `secrets.VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_ORG_ID`                                     | Project `hub-vanguard` is the only real one for smarter.poker                                                                                                                          |
| Club Arena origin                                    | `secrets.CA_ORIGIN_SSH_KEY`, `CA_ORIGIN_HOST`, `CA_ORIGIN_HOST_KEY` (Club Arena repo)            | The publisher rsyncs `dist/` to `ca-static.smarter.poker` as the unprivileged `ci` user. Replaced `WORLD_HUB_SYNC_TOKEN` on 2026-09-03: nothing is committed to the World Hub any more |
| Hetzner                                              | `secrets.HETZNER_SSH_PRIVATE_KEY`, `HETZNER_HOST`                                                | Engine deploys automatically on push to `server/**`                                                                                                                                    |

**If a credential is missing or dead**, the workflow that needs it says so by
name and opens an issue. `check-token.sh` verifies the token before anything
runs. It does not guess and neither should you.

**Never** ask a human to paste a secret into chat, commit one "temporarily", or
add a team member to unblock a deploy.

---

## 5. NEVER DO THESE

Each one caused a real, dated incident.

| Never                                                                | What happened                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Work in the shared clone                                             | One HEAD, one index. Agent B's `checkout -b` takes agent A's edits with it. Eight abandoned stashes and six `backup/*` branches were the evidence                                                                                                                                                                                                                |
| `gh pr merge --admin`                                                | Bypasses required checks. Red code reached `main` four times                                                                                                                                                                                                                                                                                                     |
| `gh pr merge --merge` / `--rebase`                                   | Disabled here. The API call fails **silently** while the agent reports success                                                                                                                                                                                                                                                                                   |
| A polling script (`wait_and_merge.sh`, `while true; do gh run list`) | Fragile and unobservable. Autopilot already does this, server-side                                                                                                                                                                                                                                                                                               |
| `git push` / `--force` to `main`                                     | Blocked by the ruleset. A force-push once rewound `main` and dropped four commits already live in production                                                                                                                                                                                                                                                     |
| `git pull --rebase origin main` on the Mac clone                     | Strands the clone mid-rebase. Use `bash scripts/git-unstick.sh`                                                                                                                                                                                                                                                                                                  |
| `--no-verify`                                                        | Skips every hook, and each one is there because something was lost                                                                                                                                                                                                                                                                                               |
| Resolve a conflict with `--ours` / `--theirs` on a whole file        | This is how a leaderboard RPC call vanished while its function signature survived. **Resolve hunk by hunk**                                                                                                                                                                                                                                                      |
| Commit a red test                                                    | `npx vitest run tests/` is what PUBLISHES the bundle. A red test stops the deploy for everyone. Write the spec first as `it.skip()` with a note                                                                                                                                                                                                                  |
| Write a migration and not apply it                                   | The code believes in a feature the database has never heard of. It fails 42703 into a catch block and nothing goes red. Apply with the Supabase MCP `apply_migration`                                                                                                                                                                                            |
| Commit under any identity but `Smarter-Poker`                        | Vercel refuses to build a commit whose author it cannot resolve to a GitHub user. The deployment goes to **BLOCKED** - no build, no logs, nothing in CI can see it, only a red dashboard row. Five sat that way on 2026-08-23, all authored `Agent <agent@smarter.poker>`                                                                                        |
| Commit a hook file non-executable                                    | git **skips** a hook that is not mode 755 and mentions it only as a hint buried in commit output. `.husky/pre-commit` was 644 in two repos, so both guards it holds were decorative for months                                                                                                                                                                   |
| ~~`npm install` inside a worktree~~ — **now safe**                   | Worktrees used to share the main clone's `node_modules` through a symlink, and `npm ci` writes through it: one install deleted the shared tree and broke `tsc`/`vitest` for all 79 trees at once, three times in one afternoon. `scripts/agent-workspace.sh` now gives each tree its own copy-on-write clone, so npm in your own tree affects only your own tree |
| Ask a human to push, merge, deploy, or approve                       | The entire point of this document                                                                                                                                                                                                                                                                                                                                |

---

## 5b. YOUR COMMIT IDENTITY, AND WHY A HOOK MIGHT NOT BE RUNNING

Set in every worktree `scripts/agent-workspace.sh` creates, so normally you
never touch it. If you are somewhere else, set it before your first commit:

```bash
git config user.name  "Smarter-Poker"
git config user.email "254329056+Smarter-Poker@users.noreply.github.com"
```

That is the only identity this estate can deploy under. Vercel refuses to build
a commit whose GitHub author it cannot resolve, and refuses it **silently**: the
deployment goes to BLOCKED with no build and no logs, so no check anywhere goes
red. `scripts/guard-commit-identity.sh` now refuses such a commit at commit
time, which is the last moment the answer is still "that commit was never made".

**If a guard prints a refusal and your commit lands anyway, or no guard speaks
at all, the hook layer is broken rather than satisfied.** Run:

```bash
bash scripts/ensure-hooks.sh          # repair
bash scripts/ensure-hooks.sh --check  # report only
```

Two faults it fixes, both of which git reports by saying nothing:

- **`core.hooksPath` pointing at `.husky/_`.** That directory is gitignored and
  generated by husky during `npm install`. A worktree has no `node_modules`, so
  it never exists there and git runs **no hooks at all**. On 2026-08-23 that was
  38 of 47 Club Arena trees. hooksPath must point at the **tracked** `.husky`.
- **A hook committed mode 644.** git skips it and mentions it only as a hint in
  the commit output. `.husky/pre-commit` was 644 in Club Arena and World Hub.

There is a third, subtler one, worth knowing because the symptom looks like
success: a hook with no `set -e` and no `|| exit 1` runs every line and exits
with the status of the **last** one. A guard in the middle can print a full
refusal and refuse nothing. Both were true here.

`.github/scripts/estate-integrity.sh` now checks hook modes across all seven
repos hourly, because a guard that has quietly stopped running looks exactly
like a guard that has nothing to complain about.

---

## 6. WHEN SOMETHING IS RED

**Read the failing check and fix the code.** Never reach for a flag that makes
the check stop applying.

| Symptom                                          | What it means                                                                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| PR stuck at `BLOCKED`                            | A required check has not passed. Read it                                                                                                    |
| PR stuck at `DIRTY`                              | A real conflict. Resolve hunk by hunk. Autopilot deliberately will not touch it                                                             |
| PR pending with **no check ever reporting**      | The quiet killer: a required context no job produces, or a branch cut before the workflow existed. Push an empty commit, or fix the ruleset |
| "Publish watchdog" issue                         | `main` moved and production did not. It re-dispatched once already; a second failure is not transient                                       |
| "Estate integrity" issue                         | A guard or a ruleset drifted in one repo. **Fix by making the repos agree, not by relaxing the check**                                      |
| `CHECK 17` failure                               | A migration in your branch declares something the live schema does not have. Apply it                                                       |
| Commit refused: "this is the shared clone"       | You skipped step 1. The message prints the exact command                                                                                    |
| Ref update refused: "would orphan local commits" | Your commits are saved at the ref it names. Push them, do not discard them                                                                  |

---

## 7. VERIFY OUTCOMES, NOT STATUS CODES

Every failure this estate has had hid behind something that reported success:
a merge script that exited 0 without merging, a sync that built a bundle and
never pushed it, an Autopilot that swept happily and queued nothing, a
de-duplicating guard that filed six duplicates.

So before you say a thing is done:

```bash
# Did it actually publish?
curl -s https://smarter.poker/hub/club-arena/build-info.json   # Club Arena
curl -s https://smarter.poker/api/health                        # World Hub
```

Compare to `main`. A green tick answers "did it merge". Only production
answers "did it ship".

---

## 7b. YOUR TIME GOES SOMEWHERE. IT IS ALMOST NEVER THE WORK

Measured on this machine 2026-08-25, after a session that took ~30 minutes and
should have taken ~10. The gates are cheap. Waiting is not.

| What                                      | Actual cost |
| ----------------------------------------- | ----------- |
| `npx vitest run tests/` — **4,240 tests** | **~10s**    |
| server `npx vitest run` — **1,452 tests** | **~21s**    |
| `npx tsc --noEmit` (client)               | **~21s**    |
| `npx tsc --noEmit` (server)               | **~3s**     |
| CI required checks, end to end            | **0-2 min** |
| **Every gate above, run in full**         | **~55s**    |

The pre-push hook does not even run all of that — it runs the tests _related
to what you touched_, which is faster still. And measure before you assume:
an earlier draft of this table said "1432 tests in 3.5s", taken from a
partial run, and was wrong in both columns.

**So if your task took 25 minutes, roughly 24 of them were not compute.**
They were one of these four:

### 1. Waiting for something that finishes without you

The single largest waste. Do not `sleep`-and-poll a deploy, a check, a merge,
or a watchdog. **Every one of them is already watched server-side** — Autopilot
merges, `publish-watchdog` compares production to `main`, `report-stuck-prs`
opens the PR you forgot. Section 5 forbids `wait_and_merge.sh` by name; this is
the same rule for the same reason, and "I'll just check every 30 seconds"
is that script written by hand.

Push, open the PR, **stop**. Check once at the end if you must. A poll loop also
burns a tool call and a slice of context per iteration, so it costs tokens as
well as minutes.

### 2. Re-solving the same setup, once per worktree

If you hit a missing dependency, a PATH problem or a broken tool, fix it **for
the session**, not for the command in front of you. Four worktrees means four
chances to solve the identical problem four times.

`gh`, `node` and `npx` are not on the default PATH in every shell here:

```bash
export PATH="/opt/homebrew/bin:$PATH"; source ~/.nvm/nvm.sh
```

### 3. One command per round trip

Every tool call is latency. Batch independent commands into one invocation and
independent tool calls into one message. Ten `echo`-and-check calls that could
have been one script are ten round trips you paid for and nine you did not need.

Trim output at the source — `| head`, `--jq`, `cut -c1-120`. An unbounded `ps`
or `git log` can blow the response limit outright, which costs the whole call.

### 4. Long operations inside a blocking call

Anything over ~90s can outlive the call and you will lose the result, retry, and
pay twice. Background it and come back:

```bash
nohup bash -c 'long-thing' >/tmp/out.log 2>&1 &      # returns instantly
```

### And before you expand the job

"Get everything up to date" is not a mandate to open eleven pull requests across
seven repositories. When a task grows past what was asked, **say what you found
and let the human choose the scope.** Finding six more problems is useful; fixing
all of them unasked, slowly, is usually not what was wanted.

---

## 8. AGENTS WORK THROUGH THE CLI AND THE API. NEVER THE BROWSER UI

Every operation in this estate — branching, committing, pushing, opening a pull
request, reading a check, applying a migration, inspecting a deployment — is
done with `git`, `gh`, the Supabase MCP, or an HTTP call. **Not by clicking.**

That is not a style preference:

- **It is auditable.** A `gh` call leaves a run log and an API trail. A click
  leaves nothing, so when something goes wrong the reconstruction stops at
  "somebody did something in the UI".
- **The guards cannot see a click.** `report-stuck-prs.sh`,
  `publish-watchdog.sh` and `estate-integrity.sh` all reason about repository
  state through the API. An action taken outside it is invisible to every
  protection in section 3.
- **It is reproducible.** A command can be pasted into a commit message, put in
  a script, and run again by the next agent. A screenshot cannot.

**Reading a rendered page is a different thing and is fine** — checking that
production actually looks right, or that a UI change landed. Use the browser
tools for that. Never use them to _perform_ a git, deploy, or database
operation that a command can do.

### If `api.github.com` is blocked, you are still not blocked

Some agent sandboxes have no route to `api.github.com` — `git` gets through and
`gh` does not. Two answers, in order:

**1. Use the host shell.** Cowork sessions have `mcp__counselors__host_terminal`,
which runs on the Mac where `gh` is already authenticated. Everything in this
playbook works there. Check with `gh auth status` before concluding anything.

**2. If you genuinely cannot reach the API at all, PUSHING IS ENOUGH.**

```bash
git push -u origin HEAD     # and stop
```

`report-stuck-prs.sh` sweeps every ten minutes and **opens the pull request for
you** on any `agent/*` branch less than a day old. That is not a theory: as of
2026-08-22 it had opened **14 pull requests** for agents that stopped at the
push, and ten of them had already merged.

So: branch under `agent/<your-name>/…` (which `agent-workspace.sh` does for
you), push, and the system finishes the job. An older branch, or one outside
that namespace, gets _reported_ rather than opened — deliberately, because
auto-merging a months-old branch is a regression wearing a rescue costume.

**Never write a `.command` file, a handoff, or a "run this on your Mac" note.**
That converts a solved problem into a human's task, and this is the one rule
the whole system exists to enforce. If you are about to write one, the answer
is one of the two above.

**And verify before you advise.** An agent told Dan his clone was divergent and
pointed him at `git-unstick.sh`; the clone was `0 behind, 0 ahead`. Running an
unstick on a healthy clone creates a backup branch and a reset for nothing.
Check first:

```bash
git rev-list --left-right --count origin/main...HEAD   # behind <tab> ahead
```

### Reading CI status: `gh pr checks` 403s, and that is not a blocker

The local fine-grained PAT has no **Checks: Read**, so these fail:

```
gh pr checks <n>                                   # GraphQL statusCheckRollup
gh api repos/OWNER/REPO/commits/<sha>/check-runs   # Checks API
```

Both answer `Resource not accessible by personal access token`. That limit is
real. It is **not** a reason to stop, because every check in this estate is a
GitHub Actions job, and the Actions API is fully readable with the same token:

```bash
# 1. Can it merge? This is usually the only question you have.
gh pr view <n> --repo Smarter-Poker/<repo> --json state,mergeStateStatus
#    BLOCKED = a required check has not passed YET   CLEAN = it will merge
#    DIRTY   = a real conflict, resolve hunk by hunk  MERGED = done

# 2. Which workflows ran on the branch, and how did they end?
gh run list --repo Smarter-Poker/<repo> --branch <branch> --limit 5   --json name,status,conclusion

# 3. Which JOB failed, and at which step?
gh api repos/Smarter-Poker/<repo>/actions/runs/<run-id>/jobs   --jq '.jobs[] | "\(.name) \(.status)/\(.conclusion)"'
gh run view <run-id> --repo Smarter-Poker/<repo> --log-failed
```

Every guard in this repo — `report-stuck-prs.sh`, `publish-watchdog.sh`,
`estate-integrity.sh` — reads CI exactly this way, for exactly this reason.

Inside a workflow the question does not arise: the App (id 4680372) has Checks
permission, so anything running in Actions can read them. Only the local PAT
cannot.

**And you should not be polling in the first place.** Open the PR and stop.
Autopilot merges it when the checks go green. Checking once to see _why_
something is BLOCKED is fine; sitting in a loop waiting is the thing the
forbidden `wait_and_merge.sh` scripts did.

### `gh` is the sanctioned path. The GitHub MCP is not.

If a GitHub MCP tool answers **`Bad credentials`**, you are not blocked — you
are using the wrong tool. It carries its own static token, separate from the
one `gh` uses, and a token nobody watches is a token that eventually expires.
That happened on 2026-08-22: the MCP's token was dead while `gh` worked
perfectly, and an agent reported itself blocked on a repository it could read.

Every guard, script and workflow in this estate is written against `gh` and the
REST API for exactly this reason. Use them:

```bash
gh pr create --fill                    # not the MCP's create_pull_request
gh api repos/OWNER/REPO/contents/PATH  # not the MCP's get_file_contents
```

If you find the MCP dead, say so once and carry on with `gh`. Do not treat it
as a blocker, and do not ask for a credential — `gh auth status` will tell you
whether the one that matters is alive.

### The GitHub UI shows things that are not signals

Worth knowing, because it has caused a false alarm:

- **"`<branch>` had recent pushes — Compare & pull request"** persists for about
  a day _after the branch has already merged or been deleted_. It is browser
  chrome, not state. Both banners on the Club Arena page on 2026-08-22 were
  like this: one branch had merged as a PR, the other no longer existed.
  `gh pr list --state all --head <branch>` is the answer; the banner is not.
- **A red "Production" badge** on a repo that is not supposed to deploy. Club
  Arena carried one for a day from a forbidden `vercel --prod` workflow. If you
  see one here, it is a bug to fix, not a deploy to retry — Club Arena
  publishes only through `publish-club-arena.yml`, which rsyncs the bundle to
  its own origin at `ca-static.smarter.poker`. It has not published through the
  World Hub repo since 2026-09-02.

If you want to know the true state of anything, ask the API:

```bash
gh pr list --state all --head <branch>      # has this branch ever been proposed
gh run list --branch <branch> --limit 5      # what actually ran
gh api repos/Smarter-Poker/<repo>/compare/main...<branch> --jq '.ahead_by,.status'
```

---

## 9. IF YOU ARE COMPLETELY LOST

```bash
bash scripts/agent-trees-audit.sh        # is any work at risk right now
bash scripts/git-unstick.sh              # this clone is stranded mid-rebase
gh pr list --state open                  # what is waiting
gh issue list --state open               # what the guards are saying
```

Then read, in this order: this file → the repo's `CLAUDE.md` →
`.agents/rules/00-anti-regression-workflow.md` (Club Arena) →
`.agent/audits/` for why any of it exists.

**Nothing here requires a human.** If you think it does, you have found either
a genuine credential you cannot obtain, or a bug in this document. Both are
worth saying out loud.
