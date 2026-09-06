# A real title is not a noun

2026-09-06, found by reading the first captions written from the new supply.

Phase 4 replaced 150 hand-written clip titles with real ones scraped from
YouTube. The composer was built for the hand-written kind - short noun
phrases, "the $26K bluff", "a four way all in" - and real titles are often
whole sentences. Two defects followed, and both put words in a video's mouth.

## The frame collided with the title's own verb

    Daniel Negreanu is literally trying to give his money is a spot worth
    sitting with.

`{topic} is a spot worth sitting with` assumes `{topic}` is a noun. Given a
clause it produces two verbs, one subject, and no meaning. A title that is
already a sentence now gets frames that STATE it and then react - the way a
person actually shares a video - and only a noun-phrase title is dropped into
the middle of a sentence.

## The nine-word trim changed what the video said

`topicOf` cut every title to nine words. On a noun phrase that loses nothing.
On a sentence it produced

    "Daniel Negreanu is literally trying to give his money"

from a title that ended "...give his money **away**" - a different claim, and
the caption then stated it as fact. A clause now keeps its words up to a
generous cap, and past that the topic is DROPPED rather than misquoted. The
composer has other lines to reach for; none of them invents a claim.

## Why this is the same defect as the rest of the phase

Every Phase 4 defect has had the same shape: a component built for one kind of
input, quietly wrong when a truer input arrived. The category label used as
English, the title fragment used as a person, the slots channel in a poker
feed, the throttle read as a graveyard - and now the sentence used as a noun.
Better data does not make old assumptions safer; it exposes them.

## Verification

253 tests green (2 new pins), tsc clean, eslint 0 errors, build ok. Ten
horses' first captions from the live pool read correctly, with 0 emoji leaks
and 0 title fragments in the agent slot.
