# Fleet Content Programme, phase 2: comprehension and voice

2026-09-05/06. Programme: `docs/FLEET-CONTENT-PROGRAMME.md`. Phase 1:
`2026-09-05-fleet-content-phase1-every-horse-is-eligible.md`.

## What Dan asked for

> "WE NEED LIKE 100+ DIFFERENT WRITING STYLES WHEN POSTING, THEY CAN NOT
> APPEAR SIMILAR OR SAME FORMATTING OR ANYTHING ELSE. THEY ALSO NEED TO BE
> SMART AND THE WORDS THAT ARE POSTED NEED TO MAKE SENSE FOR THE ACTUAL THING
> THE HORSE IS POSTING ABOUT 100%. SAME BASIC FUNCTIONALITY FOR COMMENTING ON
> POSTS AS WELL, WE NEED TO HAVE LIKE SOME KIND OF POST REVIEW ON THE BACK END
> THAT CREATES A SUMMARY THAT THE HORSES CAN INGEST BEFORE COMMENTING ON IT,
> AS WELL AS A DETERMINISTIC ENGINE THAT CAN REPLY TO THE REPLIES (WHEN
> NEEDED, NOT AN ENDLESS STREAM OF CONVERSATION ON A POST). HORSES NEED TO BE
> ADDING AND TAGGING OTHER HORSES IN POSTS THAT THEY ARE FRIENDS WITH. BUT NOT
> EVERY HORSE SHOULD BE FRIENDS WITH EVERY OTHER HORSE, THAT WOULD BE WEIRD
> AND SUSPICIOUS"

## What was true before

A caption was one line drawn from a pool keyed on a category. The category
came from a regex over the post's text. Nothing in the sentence came from the
subject, which is how a clip of a defensive stand in the paint got "Nobody
touches him when he is locked in", and how 26 different horses published that
same sentence in a month. A comment was chosen the same way. A "voice" was
`hash(id) % 10` picking one of ten archetypes that changed a few words and
nothing about length, capitalisation, punctuation or shape.

Replies were a random pick over top-level comments only. The `.is('parent_id',
null)` guard existed to stop infinite chains, and its side effect was that a
human who answered a horse was never answered back.

## What changed

- **`PostBrief.ts`** reads what a post IS before anybody writes about it:
  people, teams, concepts, amounts, tone, and a usable topic phrase, from the
  fields the platform already has. Headline-cased titles are read differently
  from sentence-cased ones, because in the first every word is capitalised and
  the naive rule invents people: it turned "Too Weak to Call, Strong Enough to
  Raise" into the person "Call Strong Enough". Known public figures and
  possessives are the signal there; a capitalised run is the signal in prose.
- **`StyleSheet.ts`** gives each horse twelve independent dimensions plus its
  own lexicon slice. **974 distinct style fingerprints across the live 1,000
  horses.** Formatting is a dimension, so some horses write four words with no
  full stop and others write three sentences with a line break.
- **`Composer.ts`** assembles sentences from the brief's own entities, scores
  every candidate with `relevanceOf()` and refuses anything below a floor.
- **`ReplyEngine.ts`** makes a thread a state machine: an unanswered human
  always gets exactly one reply; another horse gets one only if it addressed
  us, asked a question or disagreed; hard ceilings (2 per horse, 3 per thread,
  48h) end it either way.
- **`FriendGraph.ts`** makes friendship a symmetric hashed predicate raised by
  shared city, stakes and format. Sparse and clustered, never the whole fleet.
  A tag needs a reason and only ever names a horse.
- **`VoiceWriter.ts`** is the single gated path for captions, comments and
  replies, and writes `post_briefs` and `horse_thread_state` (World Hub
  migration `20260906010000`, applied) and syncs style sheets into
  `content_authors.personality` so an operator can see a horse's voice.
- **`Voice.law.test.ts`**: 37 pins, one per sentence Dan wrote.

## No model is called

The only model key on the workers VM is `XAI_API_KEY`, and the provider
rejects it ("Incorrect API key provided", checked 2026-09-05). So Phase 2 is
deterministic end to end: no cost, no rate limit, no hallucinated player, and
identical output on every run. A model layer would improve variety further and
slots in at the marked point in `VoiceWriter`, with this path as its fallback.
**A working key is the one thing that would raise the ceiling here.**

## Verification

- `tsc --noEmit` clean, eslint 0 errors, **190 tests green**, build ok.
- Migration `20260906010000` applied; `post_briefs` and `horse_thread_state`
  have real writers (the defect the Phase 1 audit found in `pipeline_runs`).
- Live, first fires after deploy: 23:10 UTC, 38 due, 13 posted, **average
  relevance 0.85**, 0 below floor, 1.23 drafts per post, 60 style sheets
  synced.

## What the first live fires exposed, and what it cost to find

The engine worked; the DATA did not.

| Measured | Fix |
| --- | --- |
| 3,487 of 8,236 `sports_clips` titles contain their own channel name; 4,281 end in clip/highlight/video | `isUninformativeTitle()`: no topic, no key phrase, capped confidence, so the Composer says something clean and generic instead of quoting a placeholder |
| **3,855 of 8,236 rows carry YouTube's player menu as the title**: "Keyboard shortcuts" x1,223, "Playback" x1,000, "Subtitles and closed captions" x837, "Spherical Videos" x794 | Named in the detector, and the publisher now keeps the real title oEmbed already returns and **writes it back to `sports_clips`**, so the library repairs itself as it is used |
| "Keyboard shortcuts" yielded the person "Keyboard", and a horse asked "anyone else watch Keyboard do this" | An uninformative title yields no people at all |

The scraper storing the help menu as a title is a real defect and it is
Phase 5's to fix at source; the brief's job is to be robust to it, which it
now is.

## Verification pass before phase 3 (Dan: "verify everything is 100% built, wired, tested, pushed")

Reading production the hour after the phase shipped found five defects that
the test suite could not have caught, because every one of them was about
what the engine was fed rather than what it computed.

| Found in production | Fix |
| --- | --- |
| `horses-stories` was the last route still on the old pools: video captions from the category pools, text stories from 15 fixed sentences, 48 fires a day | Wired to VoiceWriter; `writeStory()` seeds the subject and composes in the horse's own style. With that, `COMMENT_TEMPLATES`, `getRandomComment`, `PERSONALITY_MODIFIERS` and `applyWritingStyle` had no callers left and were removed rather than left looking live |
| Comments quoted the caption they were under: "Still thinking about Not many people on earth can do what he". A horse's video post has no `link_title`, so `briefForPost` fell through to the post's own text, which is the author's commentary, not the subject | `loadBrief()` reads the brief written at publish time, which is what `post_briefs` is for; the fallback refuses to guess from content |
| Replies named junk lifted from prose: "with hard i think it holds up" | A reply may name only a person or a team |
| `@sophie andersson 2 ...`: the legacy 15% mention picked a uniformly random horse from the whole fleet and used its display name | Routed through the friend graph, addressed by alias |
| `post_briefs` rows written before the placeholder rules still held "Bleacher Report NBA NBA Clip" as a topic; `loadBrief` served them faithfully, so the cache made the engine dumber than deriving fresh | The same title test runs on read; the 13 stored junk rows were cleared in place |

Two wiring gaps closed alongside: `horses-social-all` was discarding the
Phase 2 counters the engine had returned since the phase shipped, and
`built_from` grew by one entry every time a brief was re-read.

A-E, against `origin/main`: worktrees clean and nothing unpushed; every
commit authored `Smarter-Poker`; no TODO, stub or empty catch in any Phase 2
file and every export has a caller; `tsc` clean, eslint 0 errors, **195
tests green**, build ok; four Phase 2 tables live with real writers,
`fn_horses_not_social_ready()` = 0, kill switch armed.

## Still open

- **PR #85 is open and unmerged.** It carries the three fixes above. CI never
  ran on it: the PR was opened by `agent-open-pr` using `GITHUB_TOKEN`, and
  GitHub emits no `pull_request` event for that, so nothing triggered. The
  `*/30` autopilot sweep exists for exactly this case (its own comment says
  so) and had not fired at the time of writing. The core of Phase 2 (PR #84)
  is merged and live; only the follow-up fixes wait.
- Half the sports library still has no usable title until the self-repair has
  worked through it, one row per publish.
- Tagging fired for the first time at 00:10 (1 post). The rate is per-horse,
  so it appears gradually.
- Style sheets sync 60 horses per fire, so the fleet converges over about a
  day rather than at once. 180 of 1,000 carried theirs at the time of writing.
- The model layer is absent by choice, not by omission.
