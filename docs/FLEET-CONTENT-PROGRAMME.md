# Fleet Content Programme

Every one of the 1,000 horses posts, engages, and sounds like itself, from
content that is fresh because it is grounded in what that horse actually did.
Ten phases. One at a time. Each phase is built, wired, published and verified
in production before the next starts.

Dan, 2026-09-05: "WE NEED TO GET THE ENTIRE FLEET ACTIVE AS WELL, NOT JUST A
HANDFUL OF THEM, WE NEED TO BUILD OUT AND ENHANCE THE LIVE ENGINE MODEL TO BE
TRULY SOMETHING SPECIAL." And: "ANYTIME A NEW HORSE IS CREATED, IT INHERITS
ALL THE SOCIAL POSTING SKILLS AND ABILITIES AS WELL."

The audit this programme answers:
`Smarter-Poker-World-Hub/.agent/audits/2026-09-05-horse-content-engine-audit.md`.

## Where the engine lives

| Layer | Repo | What |
| --- | --- | --- |
| Scheduler | World Hub `scripts/openclaw-cron-dispatcher.py` | fires the routes (Hetzner VM, `deploy-openclaw.sh`) |
| Engine | **this repo** `src/routes/horse-*.ts`, `src/lib/content-engine/*` | the only code that runs |
| Schema | World Hub `supabase/migrations/` | ledgers, socialize trigger |
| Identity | club-arena `server/src/services/HorseOnboarding.ts` | engine-boot sweep |

The World Hub `src/content-engine/*.js` and `archive/cron/*` are stale mirrors.
Do not edit them; Phase 9 deletes them.

## Invariants (hold in every phase)

1. **Horses are players** (club-arena CLAUDE.md 10.5). Content is grounded in
   the same hands, wallets and tournaments a human has. No `is_horse` filter
   ever removes a horse from something a human gets.
2. **No language model on the live path** until Phase 5, and then behind a
   hard budget with the template path as fallback. The feed never goes quiet.
3. **A horse never names a human player** in any post, story, comment or DM.
   "A reg", "seat 5", never an alias. Horse aliases are fine. Law test in
   Phase 2.
4. **Memory is a table, not a Set.** Anything that decides "have we posted
   this" reads `content_asset_use` / `horse_phrase_ledger`.
5. **Eligibility is the whole fleet.** No `limit(100)`, no batch index, no
   ordering by id decides who exists. `loadFleet()` pages the roster.
6. **Every new horse is born social.** `trg_profiles_horse_is_born_social`
   fires `fn_socialize_horse` on every `is_horse` insert.
   `fn_horses_not_social_ready()` must return zero rows.
7. **Every run leaves a row.** `cron_execution_log.result` carries the counts
   (due, posted, skipped, failed, collided). A run that did nothing says so.
8. **Kill switch**: `content_settings.engine_enabled = false` stops every
   fleet route within 30 seconds. `update content_settings set engine_enabled=false;`
9. No em dashes, no emoji, in anything a horse publishes.

## Defaults taken (Dan can overrule any of these)

- Cadence: weekly floor; 60% 1/wk, 25% 2/wk, 10% 3/wk, 5% 5/wk.
- Sports share stays at the 75/25 coin flip until Phase 4 makes it a persona
  trait (target fleet average ~15%).
- Phrase ledger: same horse never repeats in 90 days; platform-wide 48 hours
  (short because the pools are 13 to 21 lines; Phase 2 and 5 lengthen it).
- Model spend: none until Phase 5; then Haiku-class with a daily cap.

## Phases

### Phase 1: the whole fleet is eligible (SHIPPED 2026-09-05)

- `FleetScheduler.ts`: weekly slot per horse (day(s) + hour in its timezone),
  3-hour due window, hour-granular `isOnlineNow` engagement gate.
- `/cron/horse-posts` hourly over all 1,000 horses; `horse-batch/*` reduced to
  a hand-over shim through the same `HorsePublisher`.
- `HorseSocialEngine` and `horses-stories` gate on `isOnlineNow`, roster
  shuffled before per-run caps.
- `ContentLedger.ts` + migration `20260905120000_content_ledgers...`:
  asset and phrase ledgers, seeded from 90 days.
- `Fleet.ts`: paged roster, `engine_enabled` kill switch.
- Migration `20260905121000_every_horse_is_born_social`: 1,000/1,000 horses
  socialized (bio, city, favourite game, birth year, voice, personality seed,
  `social_profile_completed`), trigger for every future horse, drift detector.
- Dispatcher: `horse-posts` hourly at :10, `horses-social-all` hourly at :30,
  ten `horse-batch` entries removed.

Measured before: 100 posts/day from 100 horses, 640 silent, 59 horses
commenting/week. Expected after: ~235 posts/day across the fleet, every horse
at least weekly, engagement open to every awake horse.

### Phase 2: grounded content (the horse's own poker)

- `HandStoryService.ts`: pick the week's hand from `horse_hand_reviews`
  (biggest pot won, worst beat by `net_bb`, a bluff that got through, a
  cooler), the week from `horse_daily_nets`, finishes from
  `tournament_players` (position, prize).
- Templates by archetype, slot-filled with the real cards, board, size and
  result. Text posts re-enabled for grounded content only.
- Leak confessions from `leak_tags` ("what I'm fixing this week").
- Static hand card PNG (server image route) as the post media and OG image.
- Stories and comments draw on the same facts.
- Law test: no human alias in any horse-authored text. Numbers must match
  the ledger.
- Mix: grounded content becomes the majority of posts; clips and links are
  the remainder.

### Phase 3: engagement that reaches humans

- Humans-first targeting for likes and comments (weight human-authored posts).
- Reply-to-human trigger: a human comments on a horse post, the horse replies
  in its next awake hour, about what was said.
- Witness comments: a horse seated at a hand where a human wins big or
  finishes ITM comments on it (praise only, per-player opt-out).
- Welcome committee: first human post gets a comment within the hour and two
  or three friend requests from same-city, same-stakes horses.
- Comments routed through `HumanVoiceEngine` (scrubber, memory, questions);
  replies stop being five hard-coded prefixes.
- Horse-to-horse arguments: multi-reply threads seeded from a hand post.

### Phase 4: media supply that does not repeat

- `poker_clips` table + channel RSS scraper (200 channels, no API key), the
  150 hard-coded clips retired.
- Reddit r/poker and Twitch/Kick clips as sources; the seven news sources
  `content-health-check` already monitors replace the two RSS feeds.
- Per-horse source slices; oEmbed validity cached per video.
- Sports share becomes a persona trait.
- Unstick the 144 queued native reels; transcode queue watchdog; repair or
  retire the daily video-library reels bridge.

### Phase 5: a real voice per horse

- Persona completion for 1,000 horses into `content_authors.personality`:
  archetype, cadence, favourite team and format, home room, two pet topics.
- Model-written captions from persona + grounded fact, behind a daily budget
  in `content_settings`, phrase-ledger collision check, template fallback.
- Phrase-ledger platform window lengthened to 30 days.

### Phase 6: data-native and local content

- Official club accounts post daily and weekly stats (biggest pot, luckiest
  river, hands dealt, jackpot progress, club leaderboards), tournament results,
  and a weekly club digest. Horses react.
- Local events from the venue, series and charity scrapers, posted by horses
  whose home city matches.
- Seasonality (WSOP, football season, holidays) and the horse's city team.

### Phase 7: interactive content

- Puzzles from real boards ("nuts on this board", pot odds) with deterministic
  answers; diamonds through the existing `social_post` earn key.
- "What do you do here" hand questions, result revealed six hours later.
- Threads horses open for humans to fill; throwbacks; rail-a-human stories
  with real chip counts; live tournament stories.

### Phase 8: discovery and the feed

- `social_posts.topics` populated consistently; Hands tab and filters.
- Feed ranking: per-author cap per screen, seen-dedup, played-with ordering.
- Profiles as content: real stats from hands for horses and humans alike.
- Video UX: cover frames, captions, muted autoplay, reels tab shows only
  `ready`.

### Phase 9: the hand replay renderer

- Headless renderer (Remotion or Playwright + ffmpeg) on Hetzner turns any
  hand into a 15 to 40 second clip with the real felt; optional TTS voiceover
  from the persona sheet; uploads to `social-media`, mirrors to reels.
- One-tap "share this hand" for humans producing the same clip.
- Generative b-roll experiment on a rented GPU, behind a quality gate.

### Phase 10: one engine, measured

- Delete the World Hub JS mirror, `archive/cron`, the Grok/`seeded_content`
  branch. Admin panel wired to the settings the worker reads.
- Metrics on the horses admin page: horse share of the feed, human reactions
  per horse post, distinct-caption rate, fleet coverage (horses that posted
  this week / 1,000), `fn_horses_not_social_ready()` count.
- Weekly digest email (Resend). Table talk at the felt (club-arena).

## How to verify a phase

Playbook Rule 1, Part A to E, in full, and additionally for this programme:
`cron_execution_log` shows the new route running with the expected counts,
and a `social_posts` query shows the behaviour change (distinct horses per
day, distinct assets, phrase repeats). "It merged" is not a phase.
