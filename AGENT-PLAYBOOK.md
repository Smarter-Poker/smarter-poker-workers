# Agent playbook

**Non-engine delivery: push, publish, verify and finish without waiting for `:55`.** Apply the maintenance cutover only to an actual engine replacement or a specifically identified dependency on new engine behavior. A Club Arena client using existing engine APIs, an unrelated pending engine release, and a generic engine-health check do not create that dependency. Required checks and normal client publication/live proof still apply.

Read [AGENTS.md](AGENTS.md) first, then the full references in [the reference index](docs/agent-policy/REFERENCE-INDEX.md). [The operating law](docs/agent-policy/OPERATING-LAW.md) owns scope, resumption, blocker recovery and productive waiting. [The hardening standard](docs/agent-policy/HARDENING.md) owns implementation and regression protection. [PUBLISHING.md](PUBLISHING.md) owns the approved delivery route. Product and financial rules in `CLAUDE.md`, where present, still apply.

Run `node docs/agent-policy/agent-policy.mjs read` on start/resumption, read its full output and the other required references, then record the version/hash receipt in the existing checkpoint. `plan origin/main HEAD` classifies the exact candidate; `report` and `timing` summarize actual evidence. See the reference index for schemas and limits. The normal pre-push hook and existing CI run policy integrity/scenario checks.

## Preserve work and authority

Recover the assigned worktree, branch, PR and evidence. Use an owned linked worktree; a unique writable directory on `/Volumes/SmarterWork/agent-work` is permitted when mounted. Do not reset, clean, stash, move or commit another task's changes. Stage explicit paths and use normal hooks and the configured Git identity. Resolve conflicts by inspecting both sides; never blanket-accept one side or force-push main. Integrate current main into the owned branch when needed and revalidate affected evidence.

Use configured Git/GitHub tools; verify availability in the current environment. Prefer authenticated CLI/API tools for repository operations, with other authorized tools when needed. An unavailable interface is not proof that all access is unavailable. Never read `.env` values or scrape tokens from remotes, documents or sibling repos.

## Workspace, credentials and guard references

`scripts/agent-workspace.sh <agent-name> <branch-slug> --print-path` is the maintained workspace-preparation helper. Inspect its current checkout and preserve existing ownership before using it; an existing owned SSD worktree does not need to be recreated. Keep the `reference-transaction` Git hook that protects retained commits from destructive ref changes. The `estate-integrity` workflow audits repository guards read-only; it does not publish or repair releases.

Use configured authenticated GitHub tools. Repository Actions may use the configured GitHub App identifier `AUTOPILOT_APP_ID`; that secret name is a location reference, not permission to extract secret values or reactivate retired autopilot. Necessary assigned credential repairs follow the current owner policy. Read `PUBLISHING.md` for the actual route. Verify Club Arena client provenance with `build-info.json` at both required public endpoints, and engine identity separately.

## Read the actual check result

Use `node scripts/ci/pr-status.mjs <PR-number>` or the authenticated Actions API for the exact head revision. `GET /commits/:sha/status` reports legacy commit statuses and can say pending with zero results even when Actions has failed. A denied `/commits/:sha/check-runs` read is UNKNOWN, never proof that no check failed. Read `/actions/runs?head_sha=<sha>` and its jobs to identify the actual result. On this Mac `/opt/homebrew/bin` must be on PATH for the configured `gh` executable; check the current environment before declaring it unavailable. A green check still requires the authorized agent to complete protected merge and publication under PUBLISHING.md.

## Complete the assigned result

Do not stop at a push when authorized delivery is unfinished. Find or create the PR, pass applicable checks, complete protected merge, and verify the actual publication and behavior. Reuse a remote commit or PR already present. If its PR has merged, a new follow-up needs an owned branch and PR; pushing into a closed PR does not deliver it.

Failed delivery enters immediate blocker recovery under the operating law. Compare the last successful equivalent, fix the cause, validate affected inputs and promptly continue through the existing route when eligible. Unknown remote outcome requires readback before retry. Keep pending work and remaining verification in the existing checkpoint. Never bypass a failing gate or add a release timer, watcher or recurring agent.

Evidence must match the actual inputs and component. A merge badge, successful command, open PR, frontend version or filled form is not proof of every downstream result. For a write, read back the persisted row and affected consumer safely. Prove inclusion when a newer protected version contains concurrent work; do not overwrite it to force an older SHA.

## Preserve product rules

The owner's ban on “em bars” means em dashes in user-visible text. It does not ban the hamburger menu. Preserve the approved artwork and navigation enforced by `tests/approvedHamburgerGearGuard.law.test.ts`, financial safeguards and task-specific product laws. Do not use real chips or active games for destructive tests. Unrelated TODOs are not an assignment, and unavailable verification must be reported rather than invented.
