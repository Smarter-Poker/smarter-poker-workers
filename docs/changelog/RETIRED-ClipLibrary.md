# ClipLibrary.ts is retired (2026-09-06)

The 150-literal poker clip array is gone. Its 149 distinct clips now live in
`poker_clips`, seeded by
`supabase/migrations/20260906114000_the_retired_clip_array_becomes_rows.sql`
in the World Hub, and the supply is kept renewing by
`/cron/scrape-poker-clips`.

If you are here because you are looking for where to add a poker clip: you
add a CHANNEL, as a row in `content_sources`, and the scraper finds its
videos. Do not re-create the array. The reason it had to go is in
`src/lib/content-engine/ClipSupply.ts` and in
`docs/changelog/2026-09-06-poker-gets-a-supply-that-renews.md`, but the short
version is that a hand-written list is a pool that cannot grow while the
ledger correctly refuses to repeat from it, and 24% of its videos had been
deleted or blocked without anyone noticing.
