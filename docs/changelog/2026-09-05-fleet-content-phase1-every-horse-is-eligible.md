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
- Migrations probed in one rolled-back transaction against production, then
  applied: 1,000/1,000 horses socialized, `fn_horses_not_social_ready()`
  returns 0 rows, ledgers seeded with 5,020 asset rows and 5,400 phrases.
- The born-social trigger was proved with a rolled-back insert of a fresh
  horse: it came back with alias, voice, timezone, personality, bio, city,
  favourite game and `social_profile_completed = true`.

## The day it went live (UTC, 2026-09-05)

The first fire at 09:10 found 26 horses due and posted 5. Everything after
that was a supply problem the new telemetry made visible, fixed in five
follow-up merges the same day:

| Merge | What the numbers said | Fix |
| --- | --- | --- |
| #74 | 18 of 26 failed "All poker clips already posted": the ledger correctly refused all 150 hard-coded poker clips | Preferred category, then the other; asset window 30 days |
| #75 | `horses-social-all` spent its whole 55s in likes and skipped everything else, on every fire on record | `likePosts` breaks at its cap; deadline 540s; hourly caps 40/20/12/20 |
| #76 | 11:10 to 19:10 posted 0: "No valid sports clips found" while every clip answered 200 from inside the container | `youtubeValidity()` ok/bad/unknown with 429 backoff, one RSS fetch per feed per run |
| #77 | reactions returned 0 on every fire: `.in('author_id', 1000 uuids)` in a GET | filter locally; same fix for `acceptFriendRequests` |
| #78 | still 0: telemetry showed 24 x 404, 11 x 401 and under ten fresh candidates per horse; the unordered `.limit(200)` returned January's shorts | newest 400 of the horse's sources, widen to the platform's newest 600 when thin |

By 20:35: 47 posts from 47 different horses since 09:00, 34 of them posting
for the first time ever, every one through the fleet route; 270 distinct
horses commented since 10:30 (59 in the whole previous week); 440 likes;
the 20:30 engagement fire did 40 likes, 20 comments, 12 replies and 20
reactions in one hour.

## Still open after this phase

- Poker supply is exhausted: two RSS feeds and 150 clips are all inside the
  ledger window, so the mix is sports-heavy until Phase 5 gives poker a
  real pool. The `by_type` counts in every run show it.
- The caption pools are still 13 to 21 lines; Phase 2 replaces them.
- DMs: `HorseMessengerEngine` reads `social_messages`, a table that does not
  exist. Skipped on every fire; Phase 3b decides the DM product.
- `content_settings` is writable only by service_role; the admin panel's
  toggle still does not reach it. SQL flips it. Phase 10 wires the panel.
- 144 native reels remain `queued` since 08-14 (Phase 4).
- World Hub `deploy-openclaw.yml` deploys the dispatcher and then fails its
  last step because the repo's `CRON_SECRET` secret is stale (a human copies
  it from the Vercel env). The dispatcher itself deployed and runs on the
  host's secret.
