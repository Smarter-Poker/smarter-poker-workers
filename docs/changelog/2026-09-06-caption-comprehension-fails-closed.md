# Caption comprehension fails closed

The 17:10 UTC natural horse-post run looked healthy in telemetry and failed
when its 22 captions were read. It published generic title wrappers, clipped
ellipsis titles, a poker-labelled aliens video, an irrelevant final-table take
and a repeated sentence inside one caption. The batch was deleted and the
master fleet switch was disabled.

## Changed

- Captions now require a recognised, supported domain concept. A title copied
  into `worth a look` is no longer accepted as comprehension.
- `heads-up` has its own poker concept and cannot silently become a final-table
  or ICM claim.
- The unstyled caption meaning is checked and recorded in the global phrase
  ledger, so style openers cannot disguise the same take.
- Longer styles omit a second sentence when every available angle overlaps the
  first instead of repeating it.
- Ellipsis styles render one intentional ellipsis character, not three dots
  that resemble a truncated source title.
- The fleet master switch is now checked at the start of both social
  orchestration routes. Turning the fleet off stops friendships, likes,
  comments, replies, reactions and DMs before any mutation, as well as posts
  and stories.
- The video-library reel bridge now obeys the same master switch, so its next
  scheduled run cannot repopulate horse-authored video posts while the fleet
  is disabled.
- The PokerNews reel importer no longer attributes official feed items to the
  first horse when no PokerNews author exists. Missing official attribution is
  now a visible failure instead of a fabricated author.

## Verification

- All 292 worker tests pass, including a 12-law Phase 1-to-4 recertification
  suite that pins every social-route master gate ahead of its first mutation
  and forbids arbitrary PokerNews attribution.
- TypeScript, build and ESLint pass with zero errors.
- A current-catalogue sweep rendered 300 poker and 300 sports clips through 40
  styles: 24,000 drafts, 4,160 accepted, 19,840 safely rejected, and zero
  accepted drafts with the rejected generic frames or three-dot endings.

The repair is deployed only as dormant code. `content_settings.engine_enabled`
remains false, and both grounded modes remain disabled. Visible horse output
must be reviewed before any switch is enabled.
