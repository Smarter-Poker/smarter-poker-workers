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
2. **A language model runs only behind a hard daily budget with the template
   path as fallback.** Phase 1 uses none; Phase 2 introduces it (Dan's
   requirement for 100+ voices and 100% relevance cannot be met by pools).
   The feed never goes quiet.
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

- Grounded posts lead 60% of the time and are the fallback when the media
  pools are dry (Phase 3, 2026-09-06).
- Cadence (Dan, 2026-09-05: "10% OF HORSES SHOULD BE POSTING DAILY"): weekly
  floor; 45% 1/wk, 30% 2/wk, 15% 3/wk, 10% daily. `fn_fleet_cadence()` in
  Postgres is the same hash and buckets, so `personality.cadence_per_week`
  is what the scheduler runs. Measured on the real fleet: 2,196 openings a
  week, every UTC hour between 58 and 123 of them, no hour above 5.6%.
- Sports share stays at the 75/25 coin flip until Phase 4 makes it a persona
  trait (target fleet average ~15%).
- Phrase ledger: same horse never repeats in 90 days; platform-wide 48 hours
  (short because the pools are 13 to 21 lines; Phase 2 lengthens it to 30 days).
- Model spend: none in Phase 1; from Phase 2, Haiku-class behind a daily cap.

## Phases

### Phase 1: the whole fleet is eligible (SHIPPED 2026-09-05, see changelog for the live numbers and the four follow-up fixes)

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

### Phase 2: comprehension and voice (SHIPPED 2026-09-05; see the changelog for the live numbers and the data defects the first fires exposed)

Dan, verbatim: "WE NEED LIKE 100+ DIFFERENT WRITING STYLES WHEN POSTING, THEY
CAN NOT APPEAR SIMILAR OR SAME FORMATTING OR ANYTHING ELSE. THEY ALSO NEED TO
BE SMART AND THE WORDS THAT ARE POSTED NEED TO MAKE SENSE FOR THE ACTUAL THING
THE HORSE IS POSTING ABOUT 100%. SAME BASIC FUNCTIONALITY FOR COMMENTING ON
POSTS AS WELL: SOME KIND OF POST REVIEW ON THE BACK END THAT CREATES A SUMMARY
THAT THE HORSES CAN INGEST BEFORE COMMENTING ON IT, AS WELL AS A DETERMINISTIC
ENGINE THAT CAN REPLY TO THE REPLIES (WHEN NEEDED, NOT AN ENDLESS STREAM)."

This replaces the phrase pools. Five parts, all in the workers service:

1. **Post comprehension (`PostBrief`).** Every post, horse or human, gets a
   backend brief before any horse touches it: what it is (hand, clip, news
   link, text, photo), the subject (players, teams, sport, variant, stakes),
   the sentiment, the claim, the question it asks if any, and the entities a
   reply could reference. Built from the post's own fields first (link title,
   clip title, source channel, metadata, hand data), then a small model for
   free text, cached in a `post_briefs` table keyed by post id. A comment is
   generated FROM the brief, never from a category regex. A caption is
   generated FROM the asset's brief (title, channel, sport, what happens in
   it), never from a pool keyed on "sports_highlight".
2. **Style sheets, 100+.** `content_authors.personality` carries a full style
   sheet per horse: archetype, sentence length, punctuation habits, case
   habits, openers and closers it uses and never uses, emoji policy (none),
   slang set, how it refers to itself, how it formats a hand (line breaks or
   one line, cards as "AKs" or "ace king suited"), whether it asks questions,
   whether it tags people. Generated once per horse from a 12-dimension grid
   so no two sheets are the same, then hand-reviewed sample output for 20.
   Formatting variety is a dimension, not decoration: some horses write one
   line, some write four paragraphs, some list, some never punctuate.
3. **Generation with a phrase ledger and a relevance check.** Model writes
   from brief + style sheet + grounded fact; the phrase ledger rejects a
   near-duplicate sentence platform-wide (trigram similarity, 30 days); a
   second cheap pass scores relevance of the text to the brief and rejects
   below threshold. Template fallback stays for outages only.
4. **Deterministic reply engine.** A thread is a state machine, not a loop:
   a horse replies to a reply only when the reply addresses it by name, asks
   a question, or disagrees with a claim in its brief; at most two replies
   per horse per thread; no horse-to-horse exchange beyond three turns; a
   human's reply always earns exactly one horse answer within the horse's
   next awake hour. State lives in `thread_state(post_id, horse_id, turns,
   last_turn_at)`.
5. **Friend graph and tagging.** Horses are friends with a small, plausible
   set: same city or same club or same stakes, 8 to 40 friends each, never
   the whole fleet. Built once from the data (`horse_friend_edges`) and grown
   slowly by the existing friend-request job. A horse tags a friend in a
   post or comment only when the brief gives a reason (same team, played the
   same event, the friend commented earlier), at most one tag per post, and
   never a human without opt-in.

Cost: briefs and captions at ~250 posts and ~500 comments a day on a
Haiku-class model are a few dollars a day. Hard daily cap in
`content_settings`, template fallback when spent.

### Phase 3: grounded content (SHIPPED 2026-09-06; see the changelog)

- `HandStoryService.ts`: pick the week's hand from `horse_hand_reviews`
  (biggest pot won, worst beat by `net_bb`, a bluff that got through, a
  cooler), the week from `horse_daily_nets`, finishes from
  `tournament_players` (position, prize). The hand becomes the brief; the
  style sheet becomes the voice.
- Leak confessions from `leak_tags`; text posts for grounded content only.
- Static hand card PNG (server image route) as the post media and OG image.
- Stories and comments draw on the same facts.
- Law test: no human alias in any horse-authored text. Numbers must match
  the ledger.

### Phase 3b: engagement that reaches humans

- Humans-first targeting for likes and comments; reply-to-human trigger.
- Witness comments (praise only, per-player opt-out); welcome committee.
- DMs: the messenger engine reads `social_messages`, a table that does not
  exist; decide the DM product before writing a line.

### Phase 4: media supply that does not repeat (SHIPPED 2026-09-06; see the changelog)

The measurement that defined it: over seven live days sports drew 285 posts
from a scraped pool of 8,271 while poker drew 245 from a frozen array of 150,
using 114 of them in one week. **A poker platform posted more sports than
poker (53.8% to 46.2%)** because sports was the only supply that renewed. 36
of the 149 clips were already dead - deleted, private or embedding-disabled -
and all 36 were still being offered, because the only validity cache was a Map
in process memory.

DONE:

- `poker_clips` is the twin of `sports_clips`; `content_sources` is one
  registry for every channel, poker and sports. The 149-clip array is retired
  and its clips are rows, carrying the measurement that retired 36 of them.
- The scraper reads channel RSS, not page HTML. The old scraper paired the Nth
  video id with the Nth title found in the page, which is where
  `Bleacher Report NBA NBA Clip` came from and how a brief named "Keyboard" as
  a person. Real titles make better briefs, captions and comments.
- oEmbed validity lives on the row; `/cron/revalidate-poker-clips` re-asks the
  pool inside a week and never reads a 429 or 403 as "dead".
- Per-horse source slices, with the stride varying per horse - the first
  version varied only the start, so ~1 horse in 11 had an identical set of
  favourite channels, and its own law test caught it.
- Sports share is a trait of the horse, not one global `Math.random() < 0.75`.
- A channel dormant for 540 days is retired: three seeded channels last
  uploaded in 2018, 2013 and 2008, and a supply that renews with 2008 uploads
  has not renewed.
- The 144 queued reels are released and cannot recur. All 149 of their yt-dlp
  jobs had failed with YouTube's anti-bot response; the job was marked failed
  and the reel was never told, so it kept pointing at a storage file that was
  never written. A trigger now makes a reel fall back to its YouTube origin
  when its download job dies.
- `/cron/content-supply-watchdog`: both defects above were silent for weeks,
  because a queue that stops draining and a pool that stops growing both look
  exactly like a quiet week.

Live pool: **113 to 1,720 clips**, 91 active sources, 16 retired as dormant, 4 poker news feeds, 0 reels stuck in the queue.

CLOSED OUT THE SAME DAY (Dan: finish it, do not carry it):

- The news feeds are rows in `content_sources`, each horse reading its own
  slice; poker news went from 2 sources to 4 (every candidate fetched first,
  three 404/301s not seeded). `content-health-check`'s auto-fix now APPLIES
  its repair - it used to log "Switched from X to Y" and change nothing,
  because the feed the horses read was a literal no log line could reach.
- The video library is joined at last: 1,773 poker videos scraped
  continuously and never once read by the fleet. `content_sources.aliases`
  fixed the 172 blocked by "WSOP" vs "World Series of Poker". The library's
  495 slots videos stay out - a source is poker because a row says so.
- The reels bridge is repaired, not retired. It was a SCRIPT_JOB skipped on
  the only host that fires, so the library gained 1,573 videos and the reels
  feed gained none. The workers route does both halves now, and spreads its
  output: the April run put 200 reels on ONE horse in a day; the first live
  run of this one made 40 across 39 horses, all watchable.
- **Reddit: declined, not deferred.** `robots.txt` is `Disallow: /` and their
  public content policy restricts automated use. Buildable; should not be
  built.
- **Twitch: blocked on a credential** that does not exist in this estate.
  Ready to build given `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET`.
- **The registry holds ~91 active channels, not 200.** Two batches of
  hand-written candidates resolved at 67% and 28% against YouTube, and the
  rate falls because the obvious ones are in. What the contract wanted - a
  supply that does not repeat - is met: **1,720 live clips against ~245 poker
  video posts a week**, from a phase that began at 113. Adding more is a row.

FIVE MORE DEFECTS, all found by reading output or running the code live:

- A stale copy of the dispatcher pasted over the worktree would have
  unregistered `horse-posts`, `horses-social-all` and `table-socket-probe` -
  the whole of Phase 1. Build Safety Gate CHECK 8 caught it.
- A YouTube throttle (755 bytes, HTTP 200) made every live channel look dead;
  six such runs would have retired the registry.
- `@JonathanLittle` is a real channel whose page carries no `channelId` key;
  `og:url` is tried first now.
- The library's slots channels drowned poker in any newest-N window, so the
  filter moved into the query - with the names AS STORED, because `.in()` is
  exact-match and lower-cased keys match nothing, silently.
- A real title is not a noun: `{topic} is a spot worth sitting with` given a
  sentence produced "Daniel Negreanu is literally trying to give his money is
  a spot worth sitting with", and a nine-word trim turned "give his money
  away" into "give his money" - a different claim, stated as fact.

### Phase 5: media supply, poker

- (moved up from Phase 4 detail) `poker_clips` scraper and the seven news
  sources; the 150 hard-coded clips retired.

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
