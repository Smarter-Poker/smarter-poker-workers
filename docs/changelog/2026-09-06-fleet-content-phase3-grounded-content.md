# Fleet Content Programme, phase 3: the poker they actually played

2026-09-06. Programme: `docs/FLEET-CONTENT-PROGRAMME.md`. Phase 2:
`2026-09-05-fleet-content-phase2-comprehension-and-voice.md`.

## The defect this closes

The 2026-09-05 audit, D-04: **"Horses never talk about the poker they actually
play."**

Under the Horses Are Players law (Club Arena CLAUDE.md 10.5) these accounts
sit in real seats, win and lose real pots and bust real tournaments, and
`horse_hand_reviews` has been recording every hand of it: hole cards, board,
the full action log, pot size, net in big blinds, and a leak tag naming the
spot. In the seven days to 2026-09-06 that was **204,474 hands across all
1,000 horses**, and not one post had ever been derived from any of it.

Meanwhile Phase 1 and Phase 2 spent themselves fighting over a shared media
pool: 150 hard-coded clips, two RSS feeds, and 3,855 clip titles that turned
out to be YouTube's player menu.

## Why a hand is the best content the fleet has

Every other source is shared, so two horses can collide on it and the phrase
ledger has to referee. **A hand cannot collide**: two horses did not play the
same hand from the same seat. It is specific by construction, it is true by
construction, and there are 204,474 a week. It is the one source that cannot
run dry and cannot be about nothing.

## What was built

- **`HandStory.ts`** reads the horse's last seven days, keeps the hands that
  actually went somewhere (>= 25bb swung), and picks one deterministically per
  horse per day, so a retry tells the same story. It classifies the hand from
  the reviewer's own 40-tag vocabulary (`river_aggr_won`, `big_fold_river`,
  `dominated_straight_stackoff`, ...) into big win, bad beat, cooler, river
  aggression, big fold, stackoff or grind. Cards are written the way a player
  writes them: `JJ`, `AKs`, `AcKh2s7d`, board `Qc 3c 7s Qh 8d`. It also picks
  a day's session out of `horse_daily_nets`.
- **`GroundedComposer.ts`** fills per-category frames from the row. A frame
  that needs a board is never offered to a hand that ended preflop.
- **Text posts are re-enabled, for grounded content only.** The "no text-only
  posts" rule was written when a text post meant a pool sentence with nothing
  behind it. A hand recap is the opposite of that.
- **Grounded leads 60% of the time**, hashed per horse per day so it is stable
  across a retry and varied across the fleet, and it is the fallback whenever
  the media pools are dry. A due horse now always has something true to say.

Real output, from real rows:

> `The river bet is the whole hand there. QsJc9cKh3h on Qc 3c 7s Qh 8d`
> `No way to fold AKo there. 8c Qc 7c 9s Kd. lost 90.2bb`
> `Folded a hand I would have paid off with a year ago. Qs Td 2s 6d Ts`
> `441 hands of PLO, +1958bb up. volume is the only thing you control`

## The two rules that cannot bend

**The numbers are the ledger's.** `factsMatch()` re-reads every figure in a
draft and refuses it unless the row carries that number, and every card group
must be the real holding or the real board. This is the platform that
reconciles chips to the cent; a horse that rounds a pot up into a better story
is a horse a player can catch, and one caught horse discredits all thousand.

**Nobody is named.** The action log carries every opponent's user id and none
of it reaches a sentence. A horse says "the big blind" or "a reg".

17 law pins cover both, plus the card formatting, the categoriser against the
real tag vocabulary, and that a losing day is never written as a winning one.

## Two bugs caught by reading the output before shipping

| Seen | Fix |
| --- | --- |
| The numerals-as-words style turned `QsJc9cKh3h on Qc 3c 7s` into `QsJcninecKhthreeh on Qc threec sevens` | The rule now skips any digit attached to letters, so card notation, variant names (`PLO5`) and stakes survive. Pinned. |
| A 0.25 big blind produced the stake `0.125/0.25`, a game that does not exist | A stake is only stated when the halved blind is one somebody actually posts |

## Verification

- `tsc --noEmit` clean, eslint 0 errors, **214 tests green** (17 new law
  pins), build ok.
- Merged as #91, main `92b47f4`, deployed to the workers VM and confirmed by
  the running container's revision label.
- No migration: Phase 3 reads tables that already exist and writes only the
  posts and the briefs the earlier phases already write.

## Still open

- **Tournament posts are deliberately absent.** No horse has a recorded
  `position = 1` in the last seven days (0 of 123,237 finishes), and second
  place is ubiquitous in heads-up spins, so "took 2nd in the 9pm" would be
  noise rather than news. Whether tournament results are being written back
  correctly is a settlement question, not a content one, and it is worth
  someone looking at separately.
- The hand renderer (Phase 9) would turn these posts into video. Until then a
  grounded post is text, which is the honest form for it.
- Grounded posts do not yet feed the comment path with hand-specific
  reactions; a commenter reads the hand's brief, which carries the cards and
  the category, but the reply pools are still Phase 2's.
