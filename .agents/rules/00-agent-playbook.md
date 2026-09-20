---
trigger: always_on
---

# Current operating rules

Read root `AGENTS.md`, `AGENT-PLAYBOOK.md`, `docs/agent-policy/REFERENCE-INDEX.md`, `docs/agent-policy/OPERATING-LAW.md`, `docs/agent-policy/HARDENING.md`, and `PUBLISHING.md` when delivering. This entry point delegates policy to those maintained sources; older duplicated release procedures are retired.

For workspace preparation, the maintained `scripts/agent-workspace.sh` helper is described in `AGENT-PLAYBOOK.md`. Recover an existing owned worktree before creating another; preparation is not publication.

## Release scheduling

NEVER SET A TIMER, AND NEVER USE THE `schedule` TOOL to initiate, advance, retry or certify a release. The retired rule used to say the opposite. The current owner forbids release watchers and recurring repair jobs; unrelated existing business schedules retain their authority. New scheduled functionality requires explicit task-specific instruction.

## RULE 8 — Verified outcomes

A WRITE IS VERIFIED WHEN THE ROW EXISTS: read it back and verify the affected consumer. The `bankroll_ledger_category_check` incident demonstrated why a filled form is insufficient. World Hub's `scripts/check-live-contracts.mjs`, when applicable, detects part of that contract; it does not replace actual persistence and behavior proof.

## APPENDIX A — Current authority

Use required automated checks and the protected delivery route. No manual approval label, root-only restoration owner, numbered release queue, or stop-after-push instruction applies. Preserve real dependencies, financial rules, maintenance and provider concurrency. Scope and evidence remain mandatory.
