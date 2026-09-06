# Poker gets a supply that renews

2026-09-06. Phase 4 of 10 of the fleet content programme
(`docs/FLEET-CONTENT-PROGRAMME.md`). Phase 3 and its verification pass shipped
this morning.

## The measurement that defines the phase

Seven days of live fleet output, split by where the video came from:

| supply | posts | distinct clips | pool | renews? |
| --- | --- | --- | --- | --- |
| sports | 285 (53.8%) | 247 | 8,271 | hourly, from 38 channels |
| poker | 245 (46.2%) | 114 | 150 | no - a TypeScript array last edited in April |

**A poker platform posted more sports than poker.** Not by design and not by
any decision anyone made: sports was the only supply that renewed.

114 of 150 poker clips were used in one week - 76% of the library. The Phase 1
asset ledger then refuses each of them for thirty days, correctly, which is
why the very first hourly fleet fire had **18 of 26 due horses fail with "All
poker clips already posted"** and fall through to sports. The publisher's own
comment said so, and named the fix: "until Phase 4 gives poker a real supply".

The pool was also smaller than it looked. Every one of the 149 distinct video
ids was probed against YouTube oEmbed: **36 were dead** - 22 deleted or
private (404) and 14 with embedding disabled (401). All 36 were still being
offered to horses, because the only validity cache on the platform was a `Map`
in process memory that dies with the container. The real pool was 113 clips
against 245 posts a week.

## What shipped

**`poker_clips` is now the twin of `sports_clips`.** The table already existed
and was empty - created by an earlier pass, never written to, never read. It
was reshaped rather than replaced, and seeded with the 149 retired clips
carrying today's measurement: 113 active, 36 tombstoned so the scraper cannot
rediscover a video already proved gone. Seeding is what makes the cutover
safe; the pool is never empty for an instant.

**`content_sources` is one registry for every channel the fleet draws from**,
poker and sports together - 90 poker channels and the 35 sports ones that were
previously a literal in a different file. A source is a row now, with its
resolved channel id, its last success, and its consecutive failures.

**The scraper reads channel RSS, not page HTML.** The sports scraper it is
modelled on fetches `/@handle/shorts` and pairs the Nth video id with the Nth
title string found in the page - a positional pairing nothing guarantees.
**That is where `Bleacher Report NBA NBA Clip` came from** (the fallback title
used when the title list runs short) and how a brief ended up naming
"Keyboard" as a person. YouTube publishes a real Atom feed per channel, no API
key and no quota, where each entry carries its own id and title. Verified
against three live channels: `DISASTER In Biggest Pot Of The Day`,
`Can Negreanu Fold TWO PAIR vs Andy Stacks in $100K+ Hand?`. Real titles make
better briefs, which make better captions and comments, all the way down.

**oEmbed validity lives on the row**, so a dead video costs the fleet one
question rather than one per container, and `/cron/revalidate-poker-clips`
re-asks the whole pool inside a week. A 429 or 403 is never read as "dead" -
that would empty the pool in one run, which is the same mistake as the
in-memory cache but permanent.

**A horse draws from its own slice of the catalogue**, and **how much sport a
horse posts is now a trait of the horse** rather than one global
`Math.random() < 0.75`. A thousand horses each posting exactly 25% sports are
a script; most horses now sit between 10% and 35%, a few are almost pure
poker, a few mostly watch the game, and the fleet still averages near a
quarter.

## Two defects found while building, both by reading output

**The slice was a rotation.** The first version of `sliceForHorse` varied only
the starting index, so only as many distinct tastes could exist as there were
sources. Its own law test caught it: 200 horses over 90 sources produced 85
distinct slices, meaning roughly every eleventh horse in a thousand-strong
fleet had an identical set of favourite channels. The stride varies per horse
now.

**A title fragment was being watched doing things.** With real YouTube titles
flowing in, the caption question frame produced `anyone else watch DISASTER do
this?` and `anyone else watch Nobody Folds do this?`. `anchorOf` falls back to
the brief's key phrase - a fragment of the title - and a fragment cannot act.
This is the same shape as the "Keyboard" case `PostBrief.ts` already guards on
the extraction side, arriving by the other road. Frames whose subject must be
an agent now ask `agentOf`, which is people and teams only.

## The 144 reels, and why they waited 23 days

144 reels sat at `media_status='queued'` from 2026-08-05, invisible to every
viewer because the feed only shows `ready`.

A horse posts a YouTube clip; a trigger mirrors the post into `social_reels`;
another trigger recognises the YouTube url and queues a job to download the
video into our own storage with yt-dlp. **All 149 of those jobs failed**, every
one with `yt-dlp_exit_1: ERROR: [youtube] <id>: The page needs to be reloaded.`
- YouTube's anti-bot response, nothing to do with the video. The job was marked
failed. **The reel was never told.** It kept the storage URL the pipeline had
promised to write and never wrote: fetching one today returns HTTP 400, while
the YouTube original answers oEmbed 200.

Two records of one truth and only one updated on failure - the same shape as
the `post_briefs` defect fixed this morning.

The repair is not an invention: 10,961 reels already play as
`source_type='youtube'` with `video_url` pointing at YouTube, and the 144
already carried `youtube_video_id` and `original_youtube_url`. They differed
from a working reel in two columns. Rehearsed in a rolled-back transaction
first - 144 queued before, 0 after, 0 shape mismatches across all 11,105
YouTube reels - then applied. **A trigger now makes a reel stop waiting when
its download job dies:** a local copy is an optimisation, being watchable is
the product.

## The watchdog

Both defects were silent for weeks and both were found by a person reading
rows. A queue that stops draining and a pool that stops growing look exactly
like a quiet week. `/cron/content-supply-watchdog` asks the four questions
whose answers would have caught both, hourly, and reports rather than repairs.

## Verification

- 234 tests green (12 new law pins), tsc clean, eslint 0 errors, build ok.
- Scraper proved against three live channels: handles resolved to `UC...`,
  feeds parsed, titles correct and attached to the right videos.
- `poker_clips`: 149 rows, 113 live, 36 tombstoned - matching the probe.
- `content_sources`: 90 poker, 35 sports.
- Reels: 144 queued to 0; youtube/ready 10,961 to 11,124.

## Deviation from the contract, stated plainly

The contract said 200 poker channels. This seeds 90. Padding a registry to a
number with invented handles produces rows that fail silently every hour;
these are the ones that can be named with confidence. The scraper resolves
each handle, counts consecutive failures and deactivates what it cannot find,
so the registry converges on what is really there and says so in a column -
adding more is now a row, not a deploy.

Reddit and Twitch/Kick as sources, and the seven news sources replacing the
two RSS feeds, are also still open from the Phase 4 contract. They are
additive to this structure rather than blocked by it.
