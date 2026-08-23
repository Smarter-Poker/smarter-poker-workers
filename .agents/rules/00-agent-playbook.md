---
description: Always-on entry point for every agent in every Smarter-Poker repo. Points at AGENT-PLAYBOOK.md and carries the ship sequence inline so the essentials survive even if nothing else is read.
trigger: always_on
---

# READ `AGENT-PLAYBOOK.md` AT THE REPOSITORY ROOT

It is byte-identical in all seven repos, `estate-integrity` checks hourly that
it still is, and it is the single answer to how to work here: how to ship, what
every guard is telling you, and **where each credential lives**.

Everything below is a summary. The playbook is the source.

## Ship like this. Every time.

```bash
eval "$(bash scripts/agent-workspace.sh <your-agent-name> fix/<short-slug>)"
# ...do the work...
git add -A && git commit -m "fix(scope): what changed"
git push -u origin HEAD && gh pr create --fill
# STOP. You are done.
```

Autopilot enables squash auto-merge within seconds and GitHub merges it when
the required checks go green. **You never merge.**

Step 1 is the one that matters most. Three to five agents work here at once and
a working tree has exactly one HEAD, one index and one set of uncommitted
files. Committing in the shared clone puts your work in the path of the next
agent's checkout — `.husky/pre-commit` now refuses it and prints the command
above.

## Work through the CLI and the API. Never the browser UI.

`git`, `gh`, the Supabase MCP, HTTP. Not clicking. A click leaves no audit
trail, and every guard here reasons about repository state through the API — an
action taken outside it is invisible to all of them. Reading a rendered page to
check that production looks right is fine; performing an operation there is not.

**If `api.github.com` is blocked in your sandbox you are still not blocked.**
Use the host shell (`mcp__counselors__host_terminal`), where `gh` is already
authenticated. And if you truly cannot reach the API at all, **pushing is
enough**: `report-stuck-prs.sh` sweeps every ten minutes and opens the pull
request for you on any `agent/*` branch under a day old. It had done that 14
times by 2026-08-22, ten of them already merged.

**Never write a `.command` file, a handoff, or a "run this on your Mac" note.**
That turns a solved problem into a human's task, which is the one thing this
whole system exists to prevent.

Verify before you advise, too: an agent told Dan his clone was divergent and
sent him to `git-unstick.sh` when it was `0 behind, 0 ahead`. Check with
`git rev-list --left-right --count origin/main...HEAD` first.

`gh pr checks` and the Checks API **403** with the local PAT — it has no
Checks: Read. Not a blocker: every check here is a GitHub Actions job, and the
Actions API reads fine with the same token.

```bash
gh pr view <n> --repo Smarter-Poker/<repo> --json state,mergeStateStatus
gh run list --repo Smarter-Poker/<repo> --branch <branch> --limit 5 --json name,conclusion
gh api repos/Smarter-Poker/<repo>/actions/runs/<id>/jobs --jq '.jobs[]|"\(.name) \(.conclusion)"'
```

`mergeStateStatus` is usually the whole answer: BLOCKED = a required check has
not passed yet, CLEAN = it will merge, DIRTY = a real conflict. And you should
not be polling anyway — open the PR and stop.

If a GitHub MCP tool answers **`Bad credentials`**, you are not blocked — you
are using the wrong tool. It carries its own static token, separate from the
one `gh` uses, and on 2026-08-22 that token was dead while `gh` worked fine.
Every guard here is written against `gh` and the REST API. Say so once and
carry on with `gh`; do not ask for a credential.

The GitHub UI also shows things that are not signals. A "had recent pushes —
Compare & pull request" banner persists for about a day _after_ the branch has
merged or been deleted. Ask the API instead:
`gh pr list --state all --head <branch>`.

## Never

- `gh pr merge --admin` — bypasses required checks. Red code reached main four
  times this way.
- `gh pr merge --merge` / `--rebase` — disabled here; the API call fails
  **silently** while you report success.
- `git push` or `--force` to `main` — blocked by the ruleset. A force-push once
  dropped four commits that were already live in production.
- `git pull --rebase origin main` on the Mac clone — strands it. Use
  `bash scripts/git-unstick.sh`.
- `--no-verify` — skips every hook, and each one exists because something was
  lost.
- `--ours` / `--theirs` on a whole file — this is how a leaderboard RPC call
  vanished while its signature survived. **Resolve hunk by hunk.**
- A polling script that waits and merges — Autopilot already does this,
  server-side.
- Writing a migration and not applying it — the code then believes in a feature
  the database has never heard of, and it fails 42703 into a catch block with
  nothing going red. Apply it with the Supabase MCP `apply_migration`.
- Asking a human to push, merge, deploy or approve anything.

## Your work cannot be destroyed, but check anyway

```bash
bash scripts/agent-trees-audit.sh             # what is at risk right now
bash scripts/agent-trees-snapshot.sh --list   # what was captured
```

`.husky/reference-transaction` refuses any ref update that would orphan local
commits and **saves them to `refs/wip/orphan-guard/<stamp>` first**, so even an
override leaves them recoverable. A snapshot of every working tree runs every
ten minutes ONCE the Mac has granted Full Disk Access — `~/Documents` is
TCC-protected and a launchd agent cannot read inside it without that. Check
with `bash scripts/install-wip-snapshot-agent.sh --status`; if it says it is
capturing nothing, run `bash scripts/agent-trees-snapshot.sh` by hand at the
start and end of your session.

## Before you say it is done, ask production — not the exit code

```bash
curl -s https://smarter.poker/hub/club-arena/build-info.json   # Club Arena
curl -s https://smarter.poker/api/health                        # World Hub
```

Compare to `main`. A green tick answers "did it merge". Only production answers
"did it ship", and every failure this estate has had hid behind something that
reported success.
