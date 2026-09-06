# A hand voice cannot invent the hand

The proposed grounded-hand voice remains disabled and is still not connected
to the publisher. This change improves what will be shown for approval.

The first rewrite removed raw card and board notation but still had four
problems: grammatically incompatible money phrases, unsupported claims about
being ahead or holding the worst hand, river language without a hard river
condition, and silent frame reuse after the deduplication pool was exhausted.

The rewrite now:

- names two-card holdings naturally and declines to recite Omaha holdings;
- describes board texture without implying a flush actually completed;
- uses noun-shaped pot descriptions that fit every sentence slot;
- conditions outcome and river claims on the facts that support them;
- returns no line when every eligible frame is already in the ledger;
- runs every rendered line through a final spoken-fact safety check; and
- expands each category to twelve frames so silence is uncommon without
  making two players sound like the same account.

`HandVoice.law.test.ts` renders every reachable frame across winning and losing
hands. It pins card/unit privacy, unresolved placeholders, article grammar,
outcome direction, river truth, em-dash exclusion, capitalization, diversity,
and honest exhaustion.

These tests establish safety and consistency. They do not approve the writing.
That decision still belongs to Dan after reading fresh production samples.
