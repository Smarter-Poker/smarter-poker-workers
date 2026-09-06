# Fleet phases 1-4 recertification

Production output and data were audited again instead of treating prior merge
status as completion.

## Corrected

- The fleet kill switch now fails closed when its control row cannot be read.
- Captions that miss the relevance or freshness gate are skipped, not published
  as a "best available" draft.
- Caption templates safely introduce arbitrary titles and no longer turn clauses
  into malformed noun phrases or random all-caps emphasis.
- Required replies to humans bypass optional activity sampling.
- The reply scan pages through the exact 48-hour window, loads aliases, and
  records the inserted comment id and real turn number in thread state.
- `grounded_hand` and `grounded_session` are independent approvals. One approval
  can never authorize the other by fallthrough.
- The fleet-average sports share is reduced to roughly 12%, preserving the
  platform's poker-first identity.

## Production audit snapshot

- 1,000 horse profiles; all 1,000 social-ready, active and styled.
- Cadence: 465 weekly, 289 twice-weekly, 140 three-times-weekly, 106 daily.
- 1,716 active poker clips and 95 active poker sources including RSS.
- Supply watchdog healthy; latest revalidation 40/40; no reel queued over six
  hours.
- 79 rejected grounded posts and the complete 203-post pre-fix fleet media batch
  were permanently deleted, all from verified horse authors. Zero grounded posts
  and zero pre-fix fleet posts remain.

Phase 3 remains rejected and disabled. Its hand rewrite is unwired and both
grounded mode switches remain off pending Dan's explicit approval. Seven-day
fleet coverage and the next natural scraper/reels executions remain operational
observation gates; they are not papered over as complete.
