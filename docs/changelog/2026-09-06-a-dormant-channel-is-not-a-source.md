# A dormant channel is not a source

2026-09-06, immediately after the Phase 4 supply landed. Found by running the
new scraper against production and reading what it stored - the same way the
four Phase 3 defects were found this morning.

## What the first production runs showed

The scraper worked: 25 channels a run, real titles, correct dates, 146 clips
on the first pass. Then the stored rows:

| source | newest upload |
| --- | --- |
| Hustler Casino Live | 2026-09-03 |
| PokerGO | 2026-09-05 |
| Stones Gambling Hall | **2018-02-13** |
| Poker Night in America | **2013-04-07** |
| Asian Poker Tour | **2008-06-11** |

Those channels answered perfectly. Their feeds parsed cleanly. They are simply
not making videos any more, and a feed of genuinely old uploads is what a dead
channel looks like from the outside - there is no error to catch.

**A supply that renews with 2008 uploads has not renewed.** It has moved the
frozen list from a TypeScript file into a table, which is the Phase 4 defect
wearing the Phase 4 fix as a costume.

## The two changes

**A channel whose newest upload is older than 540 days is marked dormant.**
Its clips are kept - they are real poker videos and the pool is better for
having them - but we stop asking it every day, and the registry says which
channels went quiet and when. This is the same convergence the failure counter
already did for handles that will not resolve: the registry's job is to end up
describing what is actually there.

**Candidates are read newest-first.** The sports side learned this the
expensive way on 2026-09-05 - an unordered `.limit()` returned the OLDEST
rows, January shorts of which 24 answered 404 in a single run. A scraped pool
grows at the recent end, so that is the end to read from. `poker_clips` knows
when YouTube published a video; `sports_clips` only knows when we scraped it,
so each domain orders by the freshness it actually records rather than by a
column one of them does not have.

## Measured after four production runs

| | before Phase 4 | after |
| --- | --- | --- |
| live poker clips | 113 | **778** |
| poker sources active | n/a (60 literals, 18 with clips) | 72 |
| sources retired as dormant | n/a | 16 |
| clips published in the last 90 days | unknown, never recorded | 277 |

The fourth run saved 0 new clips, which is the correct answer: a channel feed
holds recent uploads, the registry had been walked, and there was nothing new
to find until the channels publish again. A scraper that keeps "finding"
things on a static catalogue is double-counting.
