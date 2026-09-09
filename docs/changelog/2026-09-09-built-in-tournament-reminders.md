# Built-In Tournament Reminder Execution

The existing service starts the reminder owner when its HTTP listener starts and
stops it on shutdown. It restores deadlines from committed tournament schedules
and registrations, creates bounded batches through prepare_tournament_reminders,
and invokes the authenticated World Hub tournament-reminders sender when durable
work is pending. An in-memory timer only wakes this owner. Repeated starts,
restarts, late results, concurrent calls and failures are covered by eight focused
lifecycle tests; the two existing health tests and service build pass.

The database receipt owns each tournament, recipient, start and stage. Both the
normal cron and this service use that receipt; there is no new cron or secret.
The existing CRON_SECRET authenticates delivery. Health exposes actual preparation,
dispatch and unresolved-outcome counters. Provider acceptance is not device receipt.

Release order: Club Arena database contract 20260909195446, World Hub shared sender
and read-only protocol readiness, then this service. Verify the deployed revision
and naturally occurring outcomes. Do not send live user notifications as probes.

This pass implements one reminder path. Required gates are retained; unrelated
changes, duplicate verification passes and speculative hardening are excluded.
