# The supply uses what we already have

2026-09-06, closing out Phase 4. Dan asked for every open item finished rather
than carried forward, so this is the rest of the Phase 4 contract, plus three
defects the work uncovered.

## The near-miss worth reading first

The Phase 4 Open Claw schedules were written by copying the dispatcher out of
a stale clone, editing the copy, and pasting it over the worktree. That
silently reverted 46 lines of somebody else's work, including the
registration of:

    /api/cron/horse-posts          hourly, the whole fleet posting route
    /api/cron/horses-social-all    hourly engagement
    /api/cron/table-socket-probe   the probe from the 2026-09-04 outage

Merging it would have unregistered the entire Phase 1 delivery - every horse
stops posting - and taken the cron whose absence made tables say
"Reconnecting" for 22 hours with it.

Build Safety Gate CHECK 8 caught it, because
`__tests__/openclaw-workers-secret.test.mjs` asserts those three jobs stay
registered. That test exists precisely for this, and it worked.

**Pasting a whole file over another tree is not an edit.** Anchor on the text
you mean to change, and diff against `origin/main` before committing.

## News moves into the registry, and the auto-fix starts fixing

`HorsePublisher` carried its own RSS literals - two poker feeds - while
`content-health-check` monitored seven sources with fallbacks. Two lists of
the same thing, one watched and one not, so a repaired feed never reached the
horses: they were reading the other list.

The feeds are rows now, each horse reads its own slice of them, and poker news
went from 2 sources to 4 (every candidate was fetched first; Pokerfuse 404,
PokerStrategy 404 and HighstakesDB 301 were not seeded).

**And `tryFallbacks` now actually switches.** It used to write a `system_logs`
row saying "Switched from <old> to <new>" and return, changing nothing
anywhere - the feed the horses read was a literal no log line could reach. An
auto-fix that only announces itself is worse than none, because the log says
the problem was handled. There is somewhere to write the repair now, so it
writes it, and records whether the UPDATE actually matched a row.

## The video library was already ours

`video_library_videos` holds 1,773 poker videos, scraped continuously and
updated today. The fleet was scraping YouTube for videos sitting in our own
database, because nobody had built the join.

- **896 were importable immediately.** The clip pool went 778 to **1,720**.
- **172 more were blocked by a spelling.** The library says "WSOP", the
  registry says "World Series of Poker"; same channel, join on the name.
  `content_sources.aliases` lets a source answer to every name it is known by,
  which is better than renaming one side and moving the problem to the next
  system that spells it differently.
- **The slots channels stay out.** The library also carries Brian Christopher
  Slots, Lady Luck HQ, The Big Jackpot and five more - 495 videos. A slots
  pull in a poker horse's feed is exactly the off-key content this phase is
  about, and the registry is where that line is drawn: a source is poker
  because a row says so.

## The reels bridge, repaired rather than retired

200 reels, all `source_type='video_library'`, all created 2026-04-22, none
since - while the library gained 1,573 videos.

Two causes, stacked. The bridge lives in a python script the dispatcher lists
as a SCRIPT_JOB, and SCRIPT_JOBS not in `WORKERS_PREFERRED` are **skipped on
the secondary host, which is the only host that fires**. A 2026-09-04 pass
had already corrected the script's flag from `--sync-captions` to
`--limit 100` - right, and it changed nothing, because the script never
executes there.

So the workers HTTP route now does both halves, and the path is routed to
workers. **And the attribution is part of the fix:** the April run put all 200
reels on ONE horse in one day. The bridge now spreads them across the fleet,
40 a run - the first live run created 40 across 39 horses.

It also flips them to `ready` rather than leaving them enrolled in the blocked
yt-dlp pipeline, which would have recreated the 144-queued-reels defect this
phase just cleared. Same principle the fallback trigger encodes: a local copy
is an optimisation, being watchable is the product.

## Three defects found while building

**A throttle read as a graveyard.** Checking the registry's handles quickly
made every one look dead - including `@LiveattheBike` and `@PhilHellmuth`,
which had resolved minutes earlier. YouTube answers a burst with a ~755-byte
page at HTTP 200, indistinguishable from a 404 if you only ask whether you got
a string. Six of those in a row retires a live channel. `resolveChannelId` now
reports `throttled` separately, and a throttled run never increments the
failure count. This is the same mistake `revalidate-poker-clips` was written
to avoid on the clip side, arriving one level up.

**A real channel with no `channelId` key.** `@JonathanLittle` is real and its
page carries no such key at all. The resolver now tries `og:url` first - the
page's own canonical statement of which channel it is, which survives the
layout changes that move the JSON blobs around.

**Slots drowning poker in the newest-N window.** The library's slots channels
publish daily, so reading the newest 400 rows and filtering afterwards
surfaced 21 poker videos and made the bridge look finished when it had barely
started. The filter belongs in the query - and the names passed to `.in()`
must be the ones AS STORED, because it is exact-match and lower-cased lookup
keys match nothing, silently.

## What is NOT built, and why

**Reddit r/poker: declined.** `reddit.com/robots.txt` is `User-agent: *` /
`Disallow: /`, and their Public Content Policy restricts automated use of
public content. The `.rss` feed answers 200, so this was buildable - it should
not be built. Republishing another site's community content on a commercial
platform against its stated terms is not a technical problem to route around.

**Twitch clips: blocked on a credential.** The API needs a registered
application's client id and secret. Neither exists in this estate and creating
one is an account action, not a code change. Ready to build the moment Dan
provides `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET`.

**200 channels: the registry holds ~107.** Two batches of hand-written
candidates resolved at 67% and 28%, and the rate falls because the obvious
channels are already in. Continuing would mostly add rows that fail every
hour. What the contract was asking for - a supply large enough not to repeat -
is met and measured: 1,720 live clips against ~245 poker video posts a week,
from a phase that started at 113. Adding more is a row now, not a deploy.

## Verification

- 251 tests green (18 new law pins), tsc clean, eslint 0 errors, build ok.
- Live pool: 113 to **1,720** clips. Poker sources: 88 active, 16 retired as
  dormant, 54 resolved to a UC id.
- Poker news feeds: 2 to 4, each horse reading its own slice.
- Reels: 0 stuck in the queue; the bridge's 50 new reels are all `ready`
  across 49 horses.
