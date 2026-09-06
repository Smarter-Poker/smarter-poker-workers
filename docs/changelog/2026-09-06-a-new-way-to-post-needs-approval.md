# A new way for a horse to post is off until Dan approves it

2026-09-06. Dan, on seeing the Phase 3 grounded hand posts live:

> WHAT THE HELL ARE THESE POSTS?! THEY ARE PURE TRASH. ANYTIME YOU CREATE SOME
> NEW WAY FOR A HORSE TO POST, OR GIVE IT AN INSTRUCTION TO "CREATE NEW
> CONTENT" I NEED TO APPROVE IT FIRST.

## What reached the feed

    No hand, all narrative. Qh8c7d6sAd5c on 5s 4s Td 3c 6d. won 184bb
    look Q7o on 3c 8h 7c 7s 4c and the whole thing went in on the river.
    nah QTs, board came 6c 7c 9c 9h 3s, won 149bb, right.

That is a database row with spaces in it. Nobody writes "Qh8c7d6sAd5c on 5s 4s
Td 3c 6d". The hole cards run together into a twelve-character string, the
board is printed inline like a query result, and "184bb" is a column name.

**Every one of those posts was true.** They were checked against the hand they
came from, they passed `factsMatch`, they passed the eighteen law tests
written for them, and this morning I added seven more pins to that same file.
Not one of those tests asked the only question that mattered: would a person
want to read this.

I wrote in the Phase 3 changelog that "the gates prove a post is not wrong,
and they cannot tell you it is not good" - and then shipped a whole phase on
the strength of the gates anyway.

## What was done immediately

- **59 posts hidden** from the feed (`is_deleted`, reversible - the rows stay
  readable for whoever rebuilds the voice).
- **`horse_post_modes`**: one row per WAY a horse can post. `grounded_hand`
  and `grounded_session` are **disabled**. The four modes that predate this
  rule - poker and sports clips, poker and sports news - stay on and are
  marked as pre-existing rather than approved, because nobody approved them
  either and pretending otherwise would be the same mistake in a nicer shape.
- **The publisher asks before it writes.** The gate is the first statement in
  `postGrounded`, before any composition or insert.
- **It fails CLOSED.** Everywhere else in this engine a failed read must not
  silence a horse; here a failed read must not put an unapproved voice in
  front of players. Silence is recoverable. A thousand accounts posting
  something Dan has not seen is not.

Approving is one UPDATE and no deploy: the flag is data, so the decision stays
with Dan and does not need an agent.

## The pins

`PostModes.law.test.ts` holds the three sentences that actually shipped and
asserts they would be caught now - raw runs of cards, a bare `184bb`, an
inline five-card board - and asserts that ordinary poker talk ("folded pocket
kings and I am still thinking about it") is not caught. The rule is about
printing a row, not about naming cards.

## The lesson, stated plainly

A test I write cannot tell me whether the writing is any good, because I am
the one who thought it was good enough to ship. The only check that works is a
person reading it before a thousand accounts say it. That is what the approval
gate is for, and it should have existed before Phase 3, not after.
