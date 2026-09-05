# Fleet Content Programme, phase 1: every horse is eligible

2026-09-05. Programme: `docs/FLEET-CONTENT-PROGRAMME.md`.

## What was true this morning

1,000 horses. 640 had never posted, commented, liked or reeled. Exactly 100
posts a day from exactly 100 horses: `horse-by-index.ts` loaded
`content_authors ... order('profile_id').limit(100)` and ten daily batches
took ten rows each. Nobody chose those hundred; the UUID sort did.

Engagement was narrower still. `shouldHorseBeActive(id, minute, 2)` was
written for four cron fires an hour; `horses-social-all` fires at :00 every
two hours, so only horses whose hash slot is 58..2 ever passed. 58 of the 66
horses that commented in fourteen days sat in those slots.

Dedup forgot. `limit(100)` over 48h with no order saw half the posts; the
phrase memory was a process Map. 133 poker clips carried 1,337 posts in a
month; one sports caption was posted verbatim by 26 horses.

426 horses had `social_profile_completed = false`, 593 had no voice, 1,000 had
no personality. No creation path wrote the same fields as any other.

## What changed

- `src/lib/content-engine/FleetScheduler.ts` (new): weekly slot per horse,
  timezone-aware, 3-hour due window, hour-granular online gate. Pure.
  23 tests.
- `src/routes/horse-posts.ts` (new): hourly, whole fleet, oldest slot first,
  80 per run, 540s deadline, result JSON carries due/posted/skipped/failed/
  collided.
- `src/lib/content-engine/HorsePublisher.ts` (new): the one publish path,
  extracted from the batch route, with a 20-hour recent-post guard, ledger
  reads instead of the unordered limit, ledger writes after every publish,
  and `pickFreshPhrase` retrying the pool on a ledger hit.
- `src/lib/content-engine/ContentLedger.ts` (new): `assetKeyFor`,
  `normalizePhrase`, ledger reads/writes. 6 tests.
- `src/lib/content-engine/Fleet.ts` (new): paged roster, `engine_enabled`
  kill switch (30s cache, fails ON).
- `src/routes/horse-by-index.ts`: reduced to a hand-over shim through
  `HorsePublisher`. Delete when the dispatcher stops calling it.
- `src/lib/content-engine/HorseSocialEngine.ts`: four gates replaced with
  `isOnlineNow`; roster shuffled before per-run caps (otherwise the caps
  would always serve the front of the roster).
- `src/routes/horses-stories.ts`: whole fleet through `loadFleet`, online
  gate, shuffle, kill switch.
- `src/index.ts`: `/cron/horse-posts` registered.

World Hub (separate PR): migrations `20260905120000_content_ledgers...` and
`20260905121000_every_horse_is_born_social` (function + trigger + sweep +
detector; 1,000/1,000 socialized), dispatcher schedule.

## Verification

- `npx tsc --noEmit`: clean. `npx vitest run`: 35 files, 152 tests, all
  green. `npm run build`: dist/index.mjs.
- Migrations probed in one rolled-back transaction against production:
  not_ready_before=1000, touched=1000/1000, assets=5020, phrases=5400,
  not_ready_after=0; existing hand-written bios and voices untouched.
- Production numbers after the dispatcher deploy are recorded in the
  programme doc's Phase 1 section once observed.

## Still open after this phase

- The caption pools are still 13 to 21 lines. With ~235 posts a day the
  phrase ledger will report collisions; that count is the Phase 2 yardstick.
- `content_settings` is writable only by service_role; the admin panel's
  toggle still does not reach it. SQL flips it. Phase 10 wires the panel.
- 144 native reels remain `queued` since 08-14 (Phase 4).
