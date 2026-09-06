# Grounded posts read like poker, not like a template

2026-09-06. The Phase 3 verification pass, before Phase 4 begins. Phase 3:
`2026-09-06-fleet-content-phase3-grounded-content.md`.

Phase 3 shipped clean: 215 tests green, tsc and eslint clean, the deploy
workflow's own revision check satisfied, and ten real grounded posts on the
feed. Then eight hours of live output were read line by line, and four
defects came out of it. Every one of them was TRUE, well-formed, and passing
every test that existed. That is the whole point of reading the output: the
gates prove a post is not wrong, and they cannot tell you it is not good.

## 1. The fleet told every hand through the same fourteen sentences

58 grounded posts in eight hours, drawn from 14 sentence skeletons. `got
there with {hole}, {board} runout` ran seven times, `the river bet is the
whole hand there` six, `no way to fold {hole} there` six. A reader scrolling
the feed saw the same sentence from seven different accounts.

**The phrase ledger could not see any of it.** It keys on the rendered text,
and the cards make every grounded post unique - so the numbers that make a
hand post TRUE are the same numbers that hid the repetition. `no way to fold
aa there qc 8s qs 9c 9d lost 263bb` and `no way to fold a9s there 8d ad 6s 3s
kh lost 196bb` are two different strings and one identical sentence.

Fixed by ledgering the SKELETON as well as the sentence, under a key no
caption can collide with (`frame:hand:<category>:<n>`; `normalizePhrase`
strips colons out of any real sentence, so the two namespaces cannot meet and
no migration was needed). `FRAME_GLOBAL_HOURS = 3`, short because the pool is
small and bounded: a horse repeating a turn of phrase three hours later reads
like a person, three in one hour reads like a template.

One read per publish, not one per candidate - the composer is choosing
between a dozen frames and a round trip each would put twelve reads on the
critical path of every post. It fails OPEN: a ledger that cannot be read must
never stop a horse posting, and if every frame in a category is spoken for,
the horse repeats one rather than going silent. A repeated skeleton is a
blemish; a horse that cannot speak is a defect.

The pools went from 22 hand frames to 121, minimum eight per category. Eight
is pinned by a law test, because the guarantee only holds while the pool
outlasts the horses reaching into it.

## 2. A sentence named a street the hand never reached

`{hole} on {board} and the whole thing went in on the river` was offered to
any hand with a board - including one that ended on the flop. The
numbers-are-the-ledger's rule covers streets too: "it went in on the river"
is a claim about the hand as surely as a pot size is. Frames now declare the
furthest street they name and are only offered to a hand that got there.

## 3. Every hand brief was judged junk, and the damage compounded

`post_briefs` is the summary a horse reads before commenting. Phase 3 writes
one per grounded post at confidence 1.00, because it is built from a settled
row - there is nothing about it we are unsure of.

`loadBrief()` re-applies the title-quality test on the way out, so a brief
cached before a rule tightened cannot make the engine dumber than deriving
fresh would. That test was written for SCRAPED media titles and counts words
longer than two letters. A hand title is `AA on Qc 8s Qs 9c 9d`: every token
is one or two characters. Zero informative words, junk, clamped to 0.35 - and
the comment path then wrote the clamped copy BACK, so the downgrade was
permanent and would clamp again on the next read.

**33 of 67 hand briefs were sitting at 0.35 within a day.** Exactly the ones
a horse had commented on.

Two fixes, because there were two mistakes. The media-title test is no longer
applied to a brief this engine wrote itself - there is no scraper between us
and a hand title, so there is nothing to distrust. And a brief LOADED from
the table is never written back: a read-time sanitisation that gets persisted
is a cache that degrades every time it is used. Repaired in the World Hub by
`20260906103000_a_hand_brief_keeps_its_own_confidence.sql`.

## 4. Comments used the internal category label as English

```
How often is the big win actually the right call there?
What does the grind look like a street earlier?
Hard to argue with any of that... the river aggression is the whole story
```

Ten of those reached the feed. `briefForHand` puts the HandCategory enum into
`concepts`, and the Phase 2 comment frames - written for clips, where a
concept is a word like "bluff" - substituted it where a noun phrase belongs.
A label is a column value. It is not something a person says.

A near miss in the same shape: `anchorOf()` falls back to the brief's key
phrase, which for a hand is the hole cards, and the anchored frames read
`what does {anchor} do there`. A four-card holding was one PLO post away from
being addressed like a person.

Hands now have their own comment pools, per category, written as poker -
reactions, questions a reader would actually ask, and lines that name the
board or the holding the post already stated. The river-naming questions are
gated on a five-card board, same rule as the post frames. Nothing derived
from a label reaches a sentence.

## Verification

- 222 tests green (7 new law pins), tsc clean, eslint 0 errors, build ok.
- Offline over 90 horses and 7 categories: 84 posts, 84 distinct skeletons,
  maximum reuse 1; zero river sentences on a flop-only hand; comments that
  read as poker.
- The migration is applied: 67 of 67 hand briefs back at confidence 1.00.

## What the four have in common

Nothing here was caught by a test, and nothing here could have been. Each one
produced output that was accurate, grammatical and passed every gate; each
one was only visible to somebody reading a feed the way a player would. The
law pins were written afterwards, from the live strings, and that is the
right order - a pin is how a defect is stopped from coming back, not how it
is found.
