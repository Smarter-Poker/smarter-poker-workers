# Anti-cheat sweeps: a missed run is now re-runnable, and three of the four were blind anyway

2026-09-01

## What happened

One bearer `CRON_SECRET` was serving two hosts that validate it independently.
Vercel's copy was rotated, the private workers VM's was not, so every
workers-routed cron returned 401 from **2026-08-31 08:59:01 UTC** until the
dispatcher redeployed at **2026-09-01 17:21:17 UTC**. PR #1214 fixed the
secret. This change owns the hole those missed runs left behind, for the four
integrity sweeps.

Last good runs and first recovered runs, from `cron_execution_log`:

| sweep | cadence | last good run | first recovered run |
| --- | --- | --- | --- |
| collusion-scan | every 30 min, 24h window | 2026-08-31 08:30 | 2026-09-01 17:30 |
| anti-cheat-chip-dump | every 30 min, 24h window | 2026-08-31 08:30 | 2026-09-01 17:30 |
| anti-cheat-multi-account | every 30 min, 24h window | 2026-08-31 08:30 | 2026-09-01 17:30 |
| anti-cheat-bot-timing | hourly, 7-day window | 2026-08-31 08:00 | 2026-09-01 18:00 |

Because the first three read a rolling "last 24 hours ending now", the recovered
run at 17:30 could only see back to 2026-08-31 17:30. The hours between the last
good run and that point were examined by nothing and never would be:

> **2026-08-31 08:30 to 17:30 UTC, 106,238 hands.**

`anti-cheat-bot-timing` looks back seven days, so its own recovery covered the
whole outage. It needed no backfill.

## What the gap actually contained

Zero human play. All 573 players seated in those 106,238 hands were horses,
across 320,171 seat rows. Across the **entire** 25-hour outage there were 22
hands involving one human, between 20:19 and 20:32 on 2026-08-31, and those fall
inside the window the recovered sweeps re-covered.

So the unexamined window holds no human hand at all. That is the answer, and it
is luck rather than design: nothing about the outage guaranteed it.

## The defect the outage exposed

The window was a hardcoded `Date.now()`. There was no way to ask a sweep to look
at a period that had already passed, so **a missed sweep was permanently
missed**. `src/lib/scanWindow.ts` closes that: every sweep now accepts
`?since=&until=` (and `dry_run=1`), defaulting to its previous rolling window
exactly. Flag dedupe is anchored to the end of the scanned window rather than to
wall-clock now, so a historical rescan compares against the flags that existed
around that window.

## Three defects found while proving the rescan worked

These are not gap artifacts. All three were measured against production on the
**normal, non-overridden** path.

**1. PostgREST clamped every read to 1000 rows, and still returned 200.**
`.limit(50000)` is not an error and not a warning; it comes back with 1000 rows.
Measured: `collusion-scan` on its default 24-hour window reported
`scanned_hands: 1000` against a window holding roughly 280,000 hands. The sweep
had been examining about a third of one percent of play, and with no `ORDER BY`
it was an arbitrary third of a percent. Every "0 findings" it ever produced was
measuring the cap. `src/lib/pagedSelect.ts` pages with `.range()` up to the
ceiling the original `.limit()` was already asking for, orders newest-first so a
truncated scan sees a contiguous recent slice, and reports `hands_truncated` so a
partial scan can never again look like a clean one.

**2. `anti-cheat-chip-dump` cannot flag anything, by construction.** It requires
`chips_invested > 0` on each player, and `hand_history.players[]` objects carry
only `cards, seat, stack, userId, username`. `chips_invested` is never written,
so every player is skipped and `pairs_scanned` is always 0. Proven: after the
pagination fix the sweep read 50,000 hands over the gap window and still returned
`pairs_scanned: 0`. `anti_cheat_flags` has never held a single `chip_dump` row.
**Not fixed here.** Per-player chip flow is not recoverable from `players[]`; it
would have to be derived from `actions[]` amounts or written at hand close. That
is a product decision about what the signal should be, not a typo, so it is
reported rather than guessed at.

**3. `anti-cheat-bot-timing` has never flagged anything either.** It needs 200+
intra-hand deltas per user and was reading from the same 1000-row-capped sample,
so `users_scanned` was 0 even over its full 7-day window. The pagination fix
raises its read to 20,000 hands. Whether that is enough to reach the 200-delta
floor for real users is now measurable rather than structurally impossible.

`anti_cheat_flags` contains 14 rows in its entire history, all `multi_account`.

**4. The horse lookup could not survive the pagination fix.** `collusion-scan`
resolves which flagged ids are horses with a single `.in('id', findingIds)`,
which serialises every id into the query string. While the scan was capped at
1000 hands that list stayed small and one call worked. Reading the full window
made it large enough that PostgREST refused the request and the scan returned
`horse lookup failed: TypeError: fetch failed`. Found by running the fixed scan
against production before shipping it; the lookup is chunked at 300 ids now.

## Horses

`collusion-scan` already drops pairs where **both** sides are horses, with the
rationale recorded in the file: 169,519 of 169,523 rows ever written were
horse-vs-horse, 99.99% `WIN_RATE_ANOMALY` at an average suspicion score of 97,
and not one was ever reviewed. Horse/human pairs are retained.

That filter is left exactly as it is, but it is named here because it sits in
real tension with CLAUDE.md 10.5 ("horses are subject to every rule a human is
subject to, integrity checks explicitly included"). The dry run over the gap
window returned 72 findings and suppressed all 72 as horse-vs-horse — which,
given the window contained no humans, is the whole of the result. Whether
horse-vs-horse collusion should be scored differently rather than dropped is
Dan's call, not an agent's, and nothing here pre-empts it.

## Staleness alerting: already covered, deliberately not duplicated

I checked for existing per-job staleness coverage before starting and found
none: `v_system_health_cron` reflects only `pg_cron`, and nothing watched Open
Claw. I built one, and while it was in flight
`smarter-poker-workers#43` landed the handler and World Hub `#1226` landed the
identical dispatcher entry. Mine is removed rather than kept. Two watchdogs for
one job, or two schedule entries for one path, is precisely the drift a
staleness watchdog exists to catch.

What #43 covers is a job that stops running. What it cannot see is the other
failure this investigation found: a job that runs on schedule, succeeds, and
examines nothing. `collusion-scan` reported success and zero findings on every
run for months while reading 1000 of ~280,000 hands. That is what
`hands_truncated` and `hands_scanned` in this PR are for, and the two signals
are complementary rather than overlapping.

## Verification

- `npx tsc --noEmit` clean.
- `npx vitest run`: 25 test files, 63 tests, all passing.
- Both new modules covered: `src/lib/scanWindow.test.ts`,
  `src/lib/pagedSelect.test.ts`.
- `src/routes/collusion-scan.horse-filter.test.ts` updated in this commit: its
  Hono and Supabase stubs now provide `req.query()` and `.order().range()`,
  because the code under test genuinely uses both now.
- Every production run made while investigating was `dry_run=1`. No flag row and
  no `collusion_tracking` row was written. `scripts/gap-rescan.ts` requires an
  explicit `--write` to persist anything.

## Deliberately not done

The gap was **not** backfilled with writes. It contains no human play, all four
sweeps produce zero actionable findings over it, and writing a day of
horse-vs-horse noise into a review queue that has never been read would make the
queue worse rather than better. The capability to do it now exists and is one
command; the reason not to is the content of the window, not the difficulty.
