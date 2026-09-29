# Operational alerts go to the incident inbox

Operational alerts that previously texted the owner now call the service-only
`fn_record_operational_alert` RPC in the shared production database. Codex
consumes the resulting `operational_alert_events` records. The RPC returns a
positive event ID only after persistence; repeat deliveries use the same event
key. A queue error is a failed cron run, never a successful SMS fallback.

| Producer                                        | Incidents                                                                                                                                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy-error-poll`                             | Vercel API failure, failed deployment, failed autofix rebuild, circuit breaker, build OOM, autofix PR requiring review                                                                                                                      |
| `scraper-watchdog`                              | Source stale/dead/anomalous, database read failure, recovery                                                                                                                                                                                |
| `scraperAlerts` through `tour-schedule-scraper` | Failed/no-output scraper, high error rate, low output, extraction result                                                                                                                                                                    |
| `auto-settlement` (owner account copy only)     | Weekly player P&L parked for review, weekly player P&L failed, union rule violation, a settlement problem notice that remains in the owner account's personal inbox, a settlement problem push queued for its phone; each with its recovery |

Scraper state and cooldown advance only after a receipt. Recovery retains the
previous occurrence identity so a new failure cannot collide with the original
incident. The deployment monitor records the original failed deployment before
any autofix action or suppression. Full diagnostic payloads are preserved in
the inbox instead of being clipped to SMS length.

The scraper watchdog's owner-only push notification follows the same inbox
route. User notifications and the shared SMS utility are unchanged. A source
and compiled-bundle audit found no remaining operational Twilio caller in the
workers service. The separate World Hub and Open Claw senders are migrated in
their owning repository.

The weekly settlement's problem notices go to a union's owner and admins as
personal notifications. The owner account's copy is recorded here instead
(`workers.auto-settlement`), because a personal notification is mirrored to
the owner account's phone. `insertOperationalNotices` refuses any operational
batch that addresses the owner account. Every other recipient keeps the
notification as it was, with a marker added to its data: `component`
`workers.auto-settlement`, and the `alertname` and `severity` its incident is
recorded under here. A refusal is never swallowed. If the sender's own split
ever lets the owner account through, the guard refuses the batch before any
write; the run records that as a failed step (HTTP 500, `retryable: false`
once money moved), the owner account's copy still goes to the store, and the
other recipients get the notice written without the owner row. Any other throw
from that write fails the run the same way. A database error on the other
recipients' insert is logged, as it always was, and the store copy records
`other_recipients_notified`.

A settlement problem notice is a notification of type `settlement` whose
normalized title is one of the three problem titles, or whose data carries that
marker. A title is normalized by folding ASCII letters to lower case, making
each run of ASCII whitespace one space and trimming the ends. In SQL that is
`btrim(regexp_replace(translate(title, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), E'[\\t\\n\\v\\f\\r ]+', ' ', 'g'), ' ')` (the `E''` spelling keeps the same regex whether or not the writer's session has `standard_conforming_strings` on).
The detector below and the settlement clause of the database classifier
`fn_is_owner_operational_notification` use this one definition, pinned by
`SETTLEMENT_PROBLEM_CLASSIFIER` and its unit test. The database clause ships
separately, as HELD Club Arena migrations that install in this order: the
store-only delivery (#5512, `20260927235053`), then the classifier clause
(#5575, `20260928171444`), whose guard refuses to install before it, then the
owner-inbox cleanup (#5568, `20260928000622`).

Every incident is one condition, true or false at each run. A re-run while it
holds coalesces into the open incident: `delivery_count` rises and the payload
stays the first occurrence's, because the store keeps an event's first payload.
The first run that proves the condition false records the recovery, with key
`<incident key>:resolved` and `resolves` naming the incident. After a recovery,
or after the fleet set the incident to `verified_fixed`, `historical` or
`test`, a recurrence opens the next link of that condition's chain
(`<base>:r1`, `<base>:r2`, ...). An incident never closes because its harm ran
its course; an incident the run left open for that reason is listed in the
run's `results.operational_alerts` with status `left_open` and the reason.

| Incident                                    | One per                              | Recovered when                                                                                                                            |
| ------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `UnionPlayerPnlFailed`, `...NeedsReview`    | union and kind                       | settled `union_pnl_settlements` rows, from this job or any other path, cover every window it holds                                        |
| `UnionRuleViolation`                        | broken invariant (platform-wide)     | both governance checks complete without reporting that invariant as critical                                                              |
| `OwnerSettlementNoticeReachedPersonalInbox` | problem notice in the personal inbox | the notice has left the personal inbox, `operational_notification_destinations` preserves its original, and its store receipt is recorded |
| `OwnerSettlementPushQueuedForPhone`         | problem push queued for the phone    | the push ends `skipped` or `failed`, so it never reached the phone                                                                        |

A union's weekly player P&L has one open incident per kind (failed, or parked
for review), and every fault of that union and kind joins it while it is open,
whatever window the fault concerns and whether or not its window could be
read. A union's windows follow one another along its chain, and the window of
a fault cannot always be read when it happens, so no window is ever held by two
open incidents and none is left beside the incident of the window it turns out
to be.

A window starts at the union's chain anchor, the `period_end` of its latest
settled or baseline `union_pnl_settlements` row that the call can see. The
recovery proves each incident from the earliest start its first window can
have had:

- a call parked for review wrote its own window as a `needs_review` row, so its
  start is exact;
- otherwise the anchor is taken as of the first run: the latest chain row that
  ended, and was written (`settled_at`), at least 10 minutes before that run
  started, which the call could see;
- a later chain row written and ended no later than 10 minutes after the fault
  (written during the run, by a transaction that began shortly before it, or
  stamped by a database clock behind or ahead of the worker's) may or may not
  have been the call's anchor. Nothing recorded tells which, so the earliest
  start any of them gives is the start to prove (`window_basis`
  `anchor_moved`, with `window_moved_by`);
- a chain row written later than that cannot have been the call's anchor,
  whatever span it names: a settlement made afterwards, by hand, for a past
  span never moves the start;
- with no anchor, the call's own fallback, no later than 7 days before the run
  start less 10 minutes (`no_anchor`).

These rules hold within two bounds: every transaction that writes a
`union_pnl_settlements` row finishes within 10 minutes, and the worker's and the
database's clocks differ by less than 10 minutes. Beyond them a row the failed
call never saw can pass for its anchor, and a P&L incident can close falsely.

Every run reads, read-only, each open incident's union rows and needs settled
rows that cover, with no gap, the span from that start through the end of the
incident's last window. A parked call recorded where its window ended, so a
parked incident ends at its last `needs_review` row, exactly, and a re-run of
that very period proves it. Otherwise the span ends at the incident's last
record in the store: `received_at`, or `last_received_at` once a re-run joined
it. The database stamps those with `clock_timestamp()`, the clock that stamps
`settled_at` and a weekly call's `period_end`, after the failed call returned,
so every window the incident holds ended before that time. A weekly settlement begun after the
record, such as a re-run minutes later or the next week's settlement, reaches
past it, so chained from the incident's start it closes the incident. One that
ended before the record may have been the failed call's own anchor, so it
proves nothing until the chain extends past the record; an incident whose
covering settlement began before its fault was recorded (a run overlapping
the failed one) waits for that, normally the next week's settlement, which is
conservative within the bounds above. The rows may come from this job or from a
manual settlement (World Hub `settle-period.js`, or a parked period re-run by
hand). One cover proves every window the incident holds, and the proof of an
earlier window alone never closes an incident that holds a later one. A
settlement that starts later than a window, after a baseline reset or from a
club's own later period start, leaves that window unsettled.

The governance checks are platform-wide, so a broken invariant is one incident
whichever unions' owner copies report it, including a copy whose union list
could not be read. A leaked notice recovers only when its original is
preserved for the fleet in `operational_notification_destinations`, by the
capture at insert or by the history intake, which also takes the row out of the
personal inbox, and only once the capture has recorded its receipt in the
store (`inbox_event_id`). While that receipt is pending (recording it failed;
the destination keeps `last_error`, and the history intake retries it) the
incident stays open, listed in the run's outcomes as `left_open`. The owner account can delete or
edit its own notifications, so a notice that is only gone proves nothing.

Some incidents never close on their own, by design. The fleet closes them:

- a P&L incident whose first window has no anchor (`no_anchor`: the weekly
  function settled from `now() - 7 days`, and no later chained settlement
  reaches back to it);
- a P&L incident whose span a baseline skipped: a baseline reset after the
  fault, one written within 10 minutes of the fault's run (`anchor_moved`),
  and a union whose chain sits behind its settlement floor, where the weekly
  call returns `before_settlement_floor` every week;
- a P&L incident whose windows were each settled, but not by one gap-free run
  of settled rows through its last record: a later fault that joined it after
  a gap in the chain (a joined occurrence records no window of its own), or a
  settlement that ended before the fault was recorded followed by a span the
  chain skipped (a parked span, or a club period settled by hand from its own
  start);
- a P&L incident of a union that was deleted: its `union_pnl_settlements` rows
  go with it (`ON DELETE CASCADE`), so nothing can prove its windows settled;
- a P&L incident while no club has auto-settlement enabled: that path skips
  the P&L phase, so this job settles none of its windows, and it closes only if
  a settlement made by hand covers them;
- a leaked notice the owner account deleted or edited before its original was
  preserved, and one whose preserved original never gets its store receipt;
- a phone incident whose push was `sent`: the push reached the phone, and the
  harm finishing is not a recovery. So is one whose push row no longer exists;
- a rule incident while no club has auto-settlement enabled: that path does not
  run the governance checks, so nothing can prove the rule repaired until the
  next run that completes both checks.

Only open incidents are read: firing, not finished by the fleet, and without a
recorded recovery. A condition's chain is read by its key prefix. Every read,
including the owner account's personal inbox (`personal_notifications`, with
no lookback window) and its queued pushes, is paged on `id` in 200-row pages
until a short page ends it. A read that fills all 50 of its pages (10,000 or
more matching rows) fails the step and decides nothing, because a full last
page cannot prove there is no more. The alert phase runs after the last money
call, and also when no club has auto-settlement enabled (then after nothing but
the clubs read). A failed write or read fails the run with HTTP 500 and, after
money moved, `retryable: false`; it never falls back to the owner account's
inbox. It is 500 rather than 503 because this estate treats 503 as retryable.

A failed store step loses that run's owner copies: they are not kept anywhere
else. (A refused owner-addressed batch, or a notice write that throws, is a
failed step of the run too, but the owner copy of that notice is still
recorded. A database error returned for the other recipients' insert is only
logged, as it always was.) The dispatcher logs the 500
and nothing pages, because the auto-settlement job is not among its critical
jobs. A condition that still holds at the next run is recorded then (a leak or
a queued push is read again; a P&L fault or a rule break that recurs is
recorded again); one that did not recur is gone.

The queue migration must be present before this service deploys. Unit coverage
exercises persistence rejection, successful retry with an unchanged key,
separate incidents, recovery, recurrence, and a real-shaped Vercel invalid-token
response. No production SMS probe is required.
