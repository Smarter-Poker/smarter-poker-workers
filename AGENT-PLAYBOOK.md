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

## 2. THE SEVEN REPOS

| Repo                          | What it is                                                                                                 | Publishes to                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `Smarter-Poker-Club-Arena`    | Vite + React poker SPA. The canonical repo — estate-wide tooling lives here first                          | `smarter.poker/hub/club-arena/` via World Hub |
| `Smarter-Poker-World-Hub`     | Next.js app. **Serves production.**                                                                        | `smarter.poker` via Vercel                    |
| `smarter-poker-commander`     | Venue/floor management                                                                                     | Vercel                                        |
| `commander-shared`            | Shared npm package                                                                                         | GitHub Packages                               |
| `smarter-poker-workers`       | Scheduled job workers                                                                                      | Hetzner                                       |
| `Smarter-Poker-Diamond-Arena` | **Parked.** Becomes a 1:1 Club Arena clone (no clubs/unions, diamonds instead) once Club Arena is finished | Vercel                                        |
| `PepNationLab`                | Separate product. Never mix its credentials with smarter.poker's                                           | Vercel                                        |

---

## 3. WHAT PROTECTS YOU, AND WHERE IT LIVES

Every one of these is in every repo. You do not need to run them; you need to
not break them, and to know what they are telling you when they speak.

### Your work cannot be destroyed

| File                                                  | What it does                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/agent-workspace.sh`                          | Gives you your own git worktree, branched from fresh `origin/main`. Refuses to move you off uncommitted work                                                                                                                                                                                                                                                                                                             |
| `.husky/pre-commit` → `scripts/guard-shared-clone.sh` | **Refuses a commit made in the shared clone.** Prints the exact command to get a proper tree. Never stashes, never checks anything out                                                                                                                                                                                                                                                                                   |
| `.husky/reference-transaction`                        | Fires _before_ any ref update lands and refuses one that would orphan local commits — **and writes them to `refs/wip/orphan-guard/<stamp>` first**, so even an override leaves the work recoverable                                                                                                                                                                                                                      |
| `scripts/agent-trees-snapshot.sh`                     | Snapshots every working tree's uncommitted state as a git ref. Safe mid-edit: `git stash create` builds objects without touching the index, the tree, or the stash stack                                                                                                                                                                                                                                                 |
| `scripts/install-wip-snapshot-agent.sh`               | Runs that snapshot every 10 minutes as a launchd agent — **once the Mac has granted Full Disk Access**. `~/Documents` is TCC-protected and a launchd agent cannot read inside it without that; on 2026-08-22 this had captured nothing in 73 runs. `--status` now says which state it is in, and the installer refuses to claim success. Until it is granted, run the snapshot by hand at the start and end of a session |
| `scripts/agent-trees-audit.sh`                        | Lists every tree holding work that exists in exactly one place                                                                                                                                                                                                                                                                                                                                                           |

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

| What                                                 | Where it lives                                                                                   | How to use it                                                                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub App **Smarter-Poker-Autopilot**, id `4680372` | `vars.AUTOPILOT_APP_ID` + `secrets.AUTOPILOT_APP_PRIVATE_KEY` in **all 7 repos**                 | Workflows mint a fresh installation token per run via `actions/create-github-app-token@v1`. **It cannot expire.** This is the merge and publish credential        |
| `GH_PAT`                                             | Repo secret, all 7                                                                               | Legacy fallback only. **Expires 2026-11-19.** Nothing should depend on it                                                                                         |
| `GITHUB_TOKEN`                                       | Automatic                                                                                        | Issue writes only (`GH_TOKEN_ISSUES`). **Never for merges** — a merge made with it does not trigger downstream workflows, so the commit lands and never publishes |
| Supabase service role                                | `secrets.SUPABASE_SERVICE_ROLE_KEY` (CI) · `.env.local` (local, gitignored) · Supabase dashboard | Project `kuklfnapbkmacvwxktbh` for smarter.poker. PepNationLab is `ydsaqnnuwyvtyxgvrnys` — **never cross them**                                                   |
| Vercel                                               | `secrets.VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_ORG_ID`                                     | Project `hub-vanguard` is the only real one for smarter.poker                                                                                                     |
| World Hub sync                                       | `secrets.WORLD_HUB_SYNC_TOKEN`                                                                   | Superseded — the sync now mints an App token scoped to World Hub alone                                                                                            |
| Hetzner                                              | `secrets.HETZNER_SSH_PRIVATE_KEY`, `HETZNER_HOST`                                                | Engine deploys automatically on push to `server/**`                                                                                                               |

**If a credential is missing or dead**, the workflow that needs it says so by
name and opens an issue. `check-token.sh` verifies the token before anything
runs. It does not guess and neither should you.

**Never** ask a human to paste a secret into chat, commit one "temporarily", or
add a team member to unblock a deploy.

---

## 5. NEVER DO THESE

Each one caused a real, dated incident.

| Never                                                                | What happened                                                                                                                                                         |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Work in the shared clone                                             | One HEAD, one index. Agent B's `checkout -b` takes agent A's edits with it. Eight abandoned stashes and six `backup/*` branches were the evidence                     |
| `gh pr merge --admin`                                                | Bypasses required checks. Red code reached `main` four times                                                                                                          |
| `gh pr merge --merge` / `--rebase`                                   | Disabled here. The API call fails **silently** while the agent reports success                                                                                        |
| A polling script (`wait_and_merge.sh`, `while true; do gh run list`) | Fragile and unobservable. Autopilot already does this, server-side                                                                                                    |
| `git push` / `--force` to `main`                                     | Blocked by the ruleset. A force-push once rewound `main` and dropped four commits already live in production                                                          |
| `git pull --rebase origin main` on the Mac clone                     | Strands the clone mid-rebase. Use `bash scripts/git-unstick.sh`                                                                                                       |
| `--no-verify`                                                        | Skips every hook, and each one is there because something was lost                                                                                                    |
| Resolve a conflict with `--ours` / `--theirs` on a whole file        | This is how a leaderboard RPC call vanished while its function signature survived. **Resolve hunk by hunk**                                                           |
| Commit a red test                                                    | `npx vitest run tests/` is what PUBLISHES the bundle. A red test stops the deploy for everyone. Write the spec first as `it.skip()` with a note                       |
| Write a migration and not apply it                                   | The code believes in a feature the database has never heard of. It fails 42703 into a catch block and nothing goes red. Apply with the Supabase MCP `apply_migration` |
| Ask a human to push, merge, deploy, or approve                       | The entire point of this document                                                                                                                                     |

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
  publishes only through the World Hub sync.

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
