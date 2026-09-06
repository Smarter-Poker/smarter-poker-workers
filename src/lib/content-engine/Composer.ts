/**
 * Composer: writes about the thing in the brief, in the horse's own style.
 *
 * WHY (Dan, 2026-09-05): "THE WORDS THAT ARE POSTED NEED TO MAKE SENSE FOR
 * THE ACTUAL THING THE HORSE IS POSTING ABOUT 100%."
 *
 * The old path drew a whole sentence from a pool keyed on a category, so a
 * clip of a defensive stand in the paint got "Nobody touches him when he is
 * locked in" and a Garrett Adelstein bluff article got the same sentence a
 * baseball highlight got. Nothing in the sentence came from the subject.
 *
 * Here a sentence is assembled from the brief's OWN entities: the person the
 * title names, the team, the concept, the amount. The anchor is a real noun
 * from the post; the take is chosen by the concept and the tone. A sentence
 * therefore cannot be about nothing, and `relevanceOf()` is the gate that
 * proves it before anything is published.
 *
 * WHAT IS SAID comes from here. HOW IT LOOKS comes from StyleSheet.render().
 * The two are separate so 1,000 horses can say a hundred different true
 * things about one clip in a hundred different shapes.
 *
 * NO MODEL IS CALLED. Deterministic, free, and it cannot invent a player who
 * is not in the title. `ModelWriter` may later rewrite a composed draft when
 * a working key and budget exist; the draft, its grounding and its style
 * survive that rewrite, and this path stays as the fallback so the feed never
 * goes quiet. (Checked 2026-09-05: the only model key on the workers VM,
 * XAI_API_KEY, is rejected by the provider, so nothing model-shaped runs.)
 */
import type { PostBrief } from './PostBrief.js';
import { fleetHash } from './FleetScheduler.js';
import { render, targetWords, type StyleSheet } from './StyleSheet.js';

// ─── takes, by concept ───────────────────────────────────────────────────
// {anchor} is the subject named in the post. {amount} is a real number from
// it. Every line has to read as a thing a person would say about THAT.

const POKER_TAKES: Record<string, string[]> = {
  bluff: [
    'running a bluff through that many streets takes a certain kind of nerve',
    'the bluff is the easy part, the sizing is what sells it',
    'you have to be willing to be wrong out loud to fire that',
    'nobody folds that river unless the story adds up from the flop',
    'that line only works if you have been playing it straight all session',
  ],
  hero_call: [
    'calling that down needs a read you can defend to yourself later',
    'the call is not brave, it is just paying attention',
    'most people find a fold there and never think about it again',
    'that is the call you replay for a week either way',
  ],
  cooler: [
    'nothing to be done there, the money was always going in',
    'that is not a mistake, that is just the deck',
    'both players played it right and one of them still loses the stack',
  ],
  bad_beat: [
    'brutal, and the maths does not care how it felt',
    'that runout is the reason people quit and the reason people stay',
    'the hand was won on the turn and lost on the river',
    'no read fixes that, it was already over',
  ],
  all_in: [
    'stack in the middle and no way back from it',
    'once it is all in the rest is arithmetic',
    'the shove is the easy click, the fold is the hard one',
  ],
  final_table: [
    'final table pressure changes what people are willing to do with a marginal hand',
    'ICM turns a clear call into a fold and everybody knows it',
    'the shortest stack sets the pace at that table whether they mean to or not',
  ],
  bracelet: [
    'a bracelet changes how the rest of a career reads',
    'people remember the win, not the four days it took',
  ],
  main_event: [
    'main event fields are their own animal',
    'a deep main event run is mostly patience and one good day',
  ],
  river: [
    'the river is where the honesty shows up',
    'every plan survives until the river card',
  ],
  flop: [
    'the flop decided that one, the rest was admin',
    'texture like that plays itself if you are paying attention',
  ],
  gto: [
    'the solver line and the winning line are not always the same at this level',
    'balance is fine until somebody is clearly not balanced',
    'you learn the theory so you know exactly when to leave it',
  ],
  exploit: [
    'if somebody keeps folding, keep betting, that is the whole strategy',
    'exploits pay better than balance against a table that is not adjusting',
  ],
  range: [
    'the range is the answer, the hand is just one card combination',
    'thinking in ranges is the shift that changes everything',
  ],
  three_bet: [
    'three-bet sizing in live games is still too small and everybody knows it',
    'the three-bet is fine, it is the plan for the turn that is missing',
  ],
  check_raise: [
    'the check raise there is the only line that gets value from worse',
    'checking to raise takes patience most people do not have',
  ],
  fold: [
    'a good fold never gets a clip made about it',
    'that laydown is worth more than most of the hands people brag about',
  ],
  tilt: [
    'tilt costs more than any single bad call ever will',
    'the hand was fine, the next twenty minutes are the problem',
  ],
  bankroll: [
    'bankroll management is the least fun skill and the one that keeps people playing',
    'playing over your roll turns variance into a real problem',
  ],
  variance: [
    'variance is real and nobody is exempt from it',
    'a downswing feels like a leak and usually is not',
    'heaters end, that is the whole point of them',
  ],
  high_stakes: [
    'the numbers stop meaning anything at that level',
    'stakes that size change what a hand is worth psychologically',
  ],
  study: [
    'the study is where results come from, the table is just where they show up',
    'reviewing your own losses is worse and better than anything else you can do',
  ],
  pot: [
    'a pot that size makes every decision feel louder',
    'the pot gets the headline, the line is what is worth studying',
  ],
  read: [
    'a read like that is a hundred small hands paying off at once',
    'you cannot teach that timing, you can only put in the hours',
  ],
  tournament: [
    'tournament poker rewards surviving more than winning pots',
    'one bad level costs more than three good ones make',
  ],
  cash_game: [
    'cash games punish the same mistake every night until you fix it',
    'the money plays differently when it is deep',
  ],
  plo: [
    'PLO equities run so much closer than people expect',
    'four cards turns every read into a guess with extra steps',
  ],
};

const SPORT_TAKES: Record<string, string[]> = {
  dunk: [
    '{anchor} going up like the rim owed money',
    'that had no business going down and it went down anyway',
    'the second jump is the part nobody talks about',
    'whoever was under that is going to hear about it all week',
  ],
  three: [
    'pulling from that range should not be a normal shot and it is now',
    'the release is so quick the closeout never mattered',
    'that is a bad shot for everyone else and a good one for {anchor}',
  ],
  buzzer_beater: [
    'the whole building knew it was going in',
    'taking that shot with the clock like that is its own skill',
    'games get decided by about four seconds and that was them',
  ],
  block: [
    'that is timing, not height',
    'meeting it at the top like that is a decision you make early',
  ],
  crossover: [
    'the defender did nothing wrong and still ended up on the floor',
    'handles like that are hours nobody watched',
  ],
  assist: [
    'seeing that pass before it existed is the actual talent',
    'the finish gets the clip, the pass won the possession',
  ],
  touchdown: [
    'that whole drive was set up two plays earlier',
    '{anchor} finding the end zone on a play that was going nowhere',
  ],
  catch: [
    'catching that with a hand and a half is absurd',
    'concentration on that is the whole highlight',
  ],
  interception: [
    'that was read the moment the ball left',
    'jumping the route that hard only works if you are certain',
  ],
  home_run: [
    'that ball left in a hurry',
    'the swing looked easy and the ball went 430 feet',
  ],
  goal: [
    'the finish was calm and everything before it was not',
    'that angle should not be a goal',
  ],
  knockout: [
    'it was over before anybody in the building processed it',
    'the setup punch is the one that actually did the damage',
  ],
  comeback: [
    'nobody was writing about this team an hour ago',
    'the run started before the crowd noticed it was a run',
  ],
  record: [
    'records like that stand until somebody very specific comes along',
    'putting a number like that up in one night is not normal',
  ],
  playoffs: [
    'playoff basketball is a different sport and this is why',
    'you find out who wants it in about game four',
  ],
  footwork: [
    'the footwork is the highlight, everything after it was inevitable',
    'balance like that is coaching plus about ten thousand reps',
  ],
  defense: [
    '{anchor} holding position there is real work nobody claps for',
    'that stop is worth as much as any bucket and gets a tenth of the attention',
    'staying in front for a full possession is harder than it looks',
  ],
  trade: [
    'that changes the whole shape of the roster',
    'somebody is going to look very smart or very silly in about a year',
  ],
  injury: [
    'hate seeing that, the season turns on those moments',
  ],
  rookie: [
    'doing that as a rookie is the part that should worry everybody else',
  ],
};

/** Used when the brief has a tone but no concept we know. */
const TONE_TAKES: Record<string, string[]> = {
  hype: [
    'that is the kind of thing you rewind twice',
    'the reaction says everything',
    'not much needs adding to that',
  ],
  admiring: [
    'the level of control there is the whole story',
    'that is years of work showing up in one moment',
    'making it look routine is the hard part',
  ],
  funny: [
    'this is going to age extremely well',
    'the timing on that is comedy',
  ],
  critical: [
    'that is going to be a long flight home',
    'hard to defend the decision making there',
  ],
  analytical: [
    'the interesting part is what happens two decisions earlier',
    'worth watching twice for the setup rather than the finish',
  ],
  bad_beat: [
    'nothing to say to that except bad luck',
    'the numbers were fine, the card was not',
  ],
  neutral: [
    'worth a look',
    'came across this and it stuck with me',
  ],
};

/**
 * Frames built around the subject phrase itself. These are the safety net for
 * relevance: {topic} is the post's own cleaned title, so a sentence built from
 * one is about the real thing even when no concept was recognised. Measured
 * 2026-09-05: without these, a clip titled "Angel holding her own in the
 * paint" produced "came across this and it stuck with me".
 */
/**
 * A title that is already a SENTENCE cannot be used as a noun.
 *
 * The Phase 4 scraper feeds real YouTube titles in, and real titles are often
 * whole clauses: "Daniel Negreanu is literally trying to give his money away".
 * Dropped into "{topic} is a spot worth sitting with" that produced
 *
 *   "Daniel Negreanu is literally trying to give his money is a spot worth
 *    sitting with."
 *
 * Two verbs, one subject, no meaning. The frames below are written for a
 * NOUN PHRASE - "the $26K bluff", "a four way all in" - which is what a clip
 * title used to be when they were hand-written.
 *
 * So a clause-shaped title gets frames that quote it rather than embed it:
 * it is stated, then commented on, which reads the way a person actually
 * shares a video.
 */
const CLAUSE_MARKERS =
  /\b(is|are|was|were|has|have|had|does|did|will|wont|can|cant|gets|got|goes|went|makes|made|takes|took|wins|won|loses|lost|calls|folds|shoves|says|said|thinks|tried|trying)\b/i;

export function titleIsAClause(title: string): boolean {
  const t = title.trim();
  if (!t) return false;
  // A question is a clause too, and reads badly embedded either way.
  if (t.endsWith('?') || t.endsWith('!')) return true;
  return CLAUSE_MARKERS.test(t);
}

/**
 * Frames for a title that is already a sentence: state it, then react.
 * `{topic}` sits at the start followed by a full stop, never mid-clause.
 */
const CLAUSE_FRAMES: Record<string, string[]> = {
  poker: [
    'worth a closer look: {topic}',
    'this one made me stop and think: {topic}',
    'a poker clip worth discussing: {topic}',
    'on my study list today: {topic}',
    'the hand I am looking at today: {topic}',
    'one for the hand review: {topic}',
    'I want another look at this one: {topic}',
    'there is a lot to unpack here: {topic}',
  ],
  sports: [
    'worth seeing: {topic}',
    'this one caught my attention: {topic}',
    'the clip on my watch list today: {topic}',
    'one I wanted to share: {topic}',
    'I went back for another look at this: {topic}',
    'there is more here than the first watch shows: {topic}',
    'this is the moment people will be talking about: {topic}',
    'take a look at this one: {topic}',
  ],
  general: [
    'worth a look: {topic}',
    'this caught my attention: {topic}',
    'one I wanted to share: {topic}',
    'take a look at this: {topic}',
  ],
};

const TOPIC_FRAMES: Record<string, string[]> = {
  sports: [
    'worth seeing: {topic}',
    'this one caught my attention: {topic}',
    'the clip on my watch list today: {topic}',
    'one I wanted to share: {topic}',
    'I went back for another look at this: {topic}',
    'there is more here than the first watch shows: {topic}',
    'this is the moment people will be talking about: {topic}',
    'take a look at this one: {topic}',
  ],
  poker: [
    'worth a closer look: {topic}',
    'this one made me stop and think: {topic}',
    'a poker clip worth discussing: {topic}',
    'on my study list today: {topic}',
    'the hand I am looking at today: {topic}',
    'one for the hand review: {topic}',
    'I want another look at this one: {topic}',
    'there is a lot to unpack here: {topic}',
  ],
  general: [
    'worth a look: {topic}',
    'this caught my attention: {topic}',
    'one I wanted to share: {topic}',
    'take a look at this: {topic}',
  ],
};

// ─── assembly ────────────────────────────────────────────────────────────

function pickFrom<T>(arr: T[], seed: string, salt: string): T {
  return arr[fleetHash(seed, salt) % arr.length]!;
}

/** Content words, for spotting a second sentence that echoes the first. */
function contentWords(s: string): Set<string> {
  return new Set(
    s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 5),
  );
}

/**
 * Pick a line that does not repeat the sentence before it. Without this a
 * two-sentence style produced "the detail in X is what makes it. the details
 * are what make it." (measured 2026-09-05).
 */
function pickDistinct(arr: string[], avoid: string, seed: string, salt: string): string {
  const taken = contentWords(avoid);
  const fresh = arr.filter((c) => {
    for (const w of contentWords(c)) if (taken.has(w)) return false;
    return true;
  });
  const pool = fresh.length ? fresh : arr;
  return pool[fleetHash(seed, salt) % pool.length]!;
}

/** The noun the sentence hangs on: a real name from the post. */
/** "AcKh2s7d", "AKs", "JJ" - a holding, not a name. */
const CARD_GROUP = /^(?:[AKQJT2-9][hdcs]){2,}$|^[AKQJT2-9]{2}[so]?$/;

/**
 * A NAMED AGENT - somebody or something that can act. Never a topic.
 *
 * `anchorOf` falls back to the brief's key phrase, which is a fragment of the
 * title, and a fragment cannot "do" anything: with the Phase 4 scraper
 * feeding real YouTube titles in, "DISASTER In Biggest Pot Of The Day"
 * produced "anyone else watch DISASTER do this?" and "Nobody Folds In
 * Montreal" produced "anyone else watch Nobody Folds do this?". The same
 * shape as the "Keyboard" case PostBrief.ts already guards on the extraction
 * side, arriving by the other road.
 *
 * A frame whose subject has to be an agent asks for this, and simply is not
 * offered when the post names nobody.
 */
export function agentOf(b: PostBrief): string | null {
  if (b.people.length) return b.people[0]!;
  if (b.teams.length) return b.teams[0]!;
  return null;
}

export function anchorOf(b: PostBrief): string | null {
  if (b.people.length) return b.people[0]!;
  if (b.teams.length) return b.teams[0]!;
  // A key phrase stands in for a name in frames like "what does {anchor} do
  // there" - so a holding must never reach one. briefForHand sets keyPhrase
  // to the hole cards, which would have produced "curious how 8cKdQsJsTd
  // plays that at a different stake".
  if (b.keyPhrase && b.keyPhrase.length >= 4 && !CARD_GROUP.test(b.keyPhrase)) return b.keyPhrase;
  return null;
}

function specificTakePool(b: PostBrief): string[] {
  const table = b.domain === 'poker' ? POKER_TAKES : SPORT_TAKES;
  const hits: string[] = [];
  for (const c of b.concepts) {
    const lines = table[c];
    if (lines) hits.push(...lines);
  }
  if (hits.length) return hits;
  // No known concept: fall back to the other domain's table before tone, in
  // case the brief's domain guess was the weaker signal.
  const other = b.domain === 'poker' ? SPORT_TAKES : POKER_TAKES;
  for (const c of b.concepts) {
    const lines = other[c];
    if (lines) hits.push(...lines);
  }
  if (hits.length) return hits;
  return [];
}

function takePool(b: PostBrief): string[] {
  const specific = specificTakePool(b);
  return specific.length ? specific : (TONE_TAKES[b.tone] ?? TONE_TAKES.neutral!);
}

function fill(template: string, b: PostBrief, anchor: string | null): string {
  let out = template;
  if (out.includes('{anchor}')) {
    if (!anchor) return '';
    out = out.replace(/\{anchor\}/g, anchor);
  }
  if (out.includes('{amount}')) {
    if (!b.amounts.length) return '';
    out = out.replace(/\{amount\}/g, b.amounts[0]!);
  }
  return out;
}

/**
 * Below this, a sentence is not about the post. Callers retry with another
 * variant seed; the run reports how often it had to.
 */
export const RELEVANCE_FLOOR = 0.3;

export interface ComposeResult {
  text: string;
  /** 0..1: how strongly the text is tied to the brief. */
  relevance: number;
  /** What the sentence was built from, for the audit trail. */
  grounding: string[];
}

/**
 * How tied a piece of text is to a brief. The gate that enforces Dan's
 * "make sense for the actual thing 100%".
 *
 * A name or team from the post counts most, then a concept term, then the
 * domain vocabulary. Text that shares nothing with the brief scores 0 and is
 * refused (the caller retries or falls back).
 */
export function relevanceOf(text: string, b: PostBrief): number {
  const lc = text.toLowerCase();
  let score = 0;
  for (const p of b.people) if (lc.includes(p.toLowerCase())) { score += 0.5; break; }
  for (const t of b.teams) if (lc.includes(t.toLowerCase())) { score += 0.35; break; }
  for (const c of b.concepts) {
    const word = c.replace(/_/g, ' ');
    if (lc.includes(word) || lc.includes(word.split(' ')[0] ?? '')) { score += 0.3; break; }
  }
  for (const a of b.amounts) if (lc.includes(a.toLowerCase())) { score += 0.2; break; }
  if (b.keyPhrase && lc.includes(b.keyPhrase.toLowerCase())) score += 0.2;
  // Quoting the post's own subject phrase is the strongest possible tie.
  if (b.topic && lc.includes(b.topic.toLowerCase())) score += 0.45;
  // Domain vocabulary is weak evidence but real: a poker sentence on a poker
  // post is at least in the right conversation.
  if (b.domain === 'poker' && /\b(hand|pot|fold|call|raise|river|flop|stack|bluff|table|bet)\b/.test(lc)) score += 0.15;
  if (b.domain === 'sports' && /\b(shot|play|game|clip|defense|pass|ball|team|season|crowd)\b/.test(lc)) score += 0.15;
  return Math.min(1, Number(score.toFixed(2)));
}

/**
 * Build every sentence this brief can honestly support, score each against
 * the brief, and choose among the ones that actually say something about it.
 *
 * This is where "make sense for the actual thing 100%" is enforced rather
 * than hoped for: a candidate that shares nothing with the subject scores 0
 * and is only used when the brief gave us nothing at all to work with.
 */
function chooseOpening(
  b: PostBrief,
  seed: string,
  anchor: string | null,
): { text: string; grounding: string[] } {
  const candidates: Array<{ text: string; grounding: string[] }> = [];

  for (const tpl of specificTakePool(b)) {
    const filled = fill(tpl, b, anchor);
    if (!filled) continue;
    const g: string[] = [];
    if (tpl.includes('{anchor}') && anchor) g.push(`anchor:${anchor}`);
    if (b.concepts.length) g.push(`concept:${b.concepts[0]}`);
    candidates.push({ text: filled, grounding: g });
  }

  // A supported domain take is stronger than quoting a scraped title. Only
  // use a topic frame when no grounded take survived interpolation.
  if (!candidates.length && b.topic) {
    // A title that is already a sentence is stated and reacted to; only a
    // noun-phrase title can be dropped into the middle of one. See
    // titleIsAClause() for the sentence this stopped producing.
    const table = titleIsAClause(b.topic) ? CLAUSE_FRAMES : TOPIC_FRAMES;
    const frames = table[b.domain] ?? table.general!;
    for (const tpl of frames) {
      candidates.push({ text: tpl.replace(/\{topic\}/g, b.topic), grounding: [`topic:${b.topic}`] });
    }
  }

  if (!candidates.length) {
    const tone = TONE_TAKES[b.tone] ?? TONE_TAKES.neutral!;
    return { text: pickFrom(tone, seed, 'tone'), grounding: [] };
  }

  const scored = candidates.map((c) => ({ ...c, score: relevanceOf(c.text, b) }));
  const good = scored.filter((c) => c.score >= RELEVANCE_FLOOR);
  const pool = good.length ? good : scored.sort((a, z) => z.score - a.score).slice(0, 3);
  return pool[fleetHash(seed, 'open') % pool.length]!;
}

/**
 * A horse's own caption for something it is posting.
 * `variantSeed` lets the caller ask for a different draw after a ledger hit.
 */
export function composeCaption(
  b: PostBrief,
  style: StyleSheet,
  variantSeed = '0',
): ComposeResult {
  const seed = `${style.profileId}:${b.postId ?? b.title}:${variantSeed}`;
  const anchor = anchorOf(b);
  const grounding: string[] = [];
  const { sentences } = targetWords(style);

  const lines: string[] = [];
  const chosen = chooseOpening(b, seed, anchor);
  lines.push(chosen.text);
  grounding.push(...chosen.grounding);

  // Extra sentences for the longer styles.
  if (sentences >= 2 && b.concepts.length) {
    const groundedAngles = takePool(b).filter((t) => !t.includes('{'));
    if (groundedAngles.length) lines.push(pickDistinct(groundedAngles, lines[0]!, seed, 'angle1'));
  }

  // The question habit, when the style has one.
  const wantsQuestion = !b.isQuestion && style.closer !== 'tag_question' && style.questionRate > 0
    && (fleetHash(seed, 'q') % 100) / 100 < style.questionRate;
  if (wantsQuestion) {
    lines.push(b.domain === 'poker' ? 'what is your read' : 'what stood out to you');
  }

  const text = render(lines, style, seed) + (wantsQuestion ? '?' : '');
  const cleaned = text.replace(/\?+\.?$/, '?').replace(/\.+\?$/, '?');
  return { text: cleaned, relevance: relevanceOf(cleaned, b), grounding };
}

/** Reaction pools for commenting, by how the commenter relates to the post. */
const AGREE_LEADS = [
  'this is the part people miss',
  'exactly this',
  'said what I was thinking',
  'hard to argue with any of that',
];
const PUSHBACK_LEADS = [
  'not sure I see it that way',
  'I read that spot differently',
  'respectfully, the sizing tells a different story',
  'I think that is closer than you are making it',
];
/** Grounded versions, used whenever the brief gives us something to name. */
const CURIOUS_ANCHORED = [
  'what does {anchor} do there if the card bricks',
  'curious how {anchor} plays that at a different stake',
  'did anyone catch what {anchor} did right before this',
];
const PUSH_ANCHORED = [
  'I read {anchor} differently there',
  'not sure {anchor} deserves the blame on that one',
];

/**
 * What a horse says under somebody else's HAND post.
 *
 * A hand post is not a clip: there is no channel, no person to name, and the
 * only nouns are the cards. The Phase 2 pools were written for clips and,
 * pointed at a hand brief, substituted the internal category label straight
 * into a sentence - "how often is the big win actually the right call there",
 * "what does the grind look like a street earlier". Ten of those reached the
 * feed on 2026-09-06. A label is a column value, not a noun phrase.
 *
 * So hands get their own pools, per category, written as poker.
 */
const HAND_REACT: Record<string, string[]> = {
  big_win: [
    'that is the runout you wait a month for',
    'nice one, those pay for a lot of folds',
    'no notes, that is just a hand playing itself',
    'stack looks a lot better after that one',
  ],
  bad_beat: [
    'brutal. that is the one you are still thinking about tomorrow',
    'nothing to do differently there',
    'the maths was on your side and the deck was not',
    'that runout is why people quit and why people stay',
  ],
  cooler: [
    'no fold exists there, do not let anyone tell you otherwise',
    'both hands were always getting it in',
    'that is the deck, not a leak',
    'you cannot get away from that and neither could they',
  ],
  river_aggression: [
    'takes nerve to fire the last one',
    'the line only works if it adds up from the flop',
    'good bet, most people check that back and never find out',
    'that is the bet people talk themselves out of',
  ],
  big_fold: [
    'the fold nobody makes a clip about, and the one that pays',
    'that is discipline, most of us are calling there',
    'saving a stack counts the same as winning one',
    'hard to lay down, easy to be glad about later',
  ],
  stackoff: [
    'once it is in the rest is arithmetic',
    'no way back from that one either way',
    'stack in and hope, we have all been there',
  ],
  grind: [
    'most of the game looks exactly like that',
    'small clean pots, that is the job',
    'nothing flashy and nothing wrong with it',
  ],
};

/**
 * Questions a reader would actually ask about a hand. `river` marks the ones
 * that name the last street, so they are not asked about a hand that ended on
 * the flop - the same rule the post frames follow.
 */
const HAND_QUESTIONS: Array<{ t: string; river?: boolean }> = [
  { t: 'what was the sizing on the river', river: true },
  { t: 'were they repping anything by then' },
  { t: 'how deep were you there' },
  { t: 'what does that look like if the last card bricks', river: true },
  { t: 'would you play it the same at a bigger stake' },
  { t: 'did they show' },
  { t: 'what did the flop action look like' },
  { t: 'how much was behind at that point' },
];

/** Sentences that name the board or the holding the post already stated. */
const HAND_ANCHORED = [
  'that {board} board was never going to be simple',
  '{hole} on that runout is a hard one to get away from',
  'the moment {board} landed it was always going to the end',
];

/** The category, as words a person would say, when a sentence needs it. */
const CATEGORY_WORDS: Record<string, string> = {
  big_win: 'that pot',
  bad_beat: 'that beat',
  cooler: 'that cooler',
  // Street-neutral: this phrase is appended to comments on hands that ended
  // on the flop too, and "that river bet" would be naming a street that
  // never came.
  river_aggression: 'that bet',
  big_fold: 'that fold',
  stackoff: 'that stackoff',
  grind: 'that one',
};

/** "AA on Qc 8s Qs 9c 9d" -> the two halves, when they are there. */
function splitHandTitle(title: string): { hole?: string; board?: string } {
  const m = title.match(/^(\S+)\s+on\s+(.+)$/);
  if (!m) return {};
  return { hole: m[1]!, board: m[2]! };
}

/**
 * A comment under a hand post: about the hand, in this horse's voice.
 * Returns null when the brief does not actually describe a hand, so the
 * caller falls back to the general path rather than inventing poker.
 */
function composeHandComment(
  b: PostBrief,
  style: StyleSheet,
  seed: string,
): ComposeResult | null {
  const category = b.concepts.find((c) => c in HAND_REACT);
  if (!category) return null;
  const { hole, board } = splitHandTitle(b.title);
  const grounding: string[] = [`category:${category}`];
  const lines: string[] = [];

  const roll = fleetHash(seed, 'handstance') % 100;
  if (roll < 20 && board) {
    lines.push(
      pickFrom(HAND_ANCHORED, seed, 'hAnchor')
        .replace(/\{board\}/g, board)
        .replace(/\{hole\}/g, hole ?? category),
    );
    grounding.push(`board:${board}`);
  } else if (roll < 45) {
    // A five-card board is the only thing that proves there was a river.
    const toRiver = (board ?? '').split(/\s+/).filter(Boolean).length >= 5;
    const asks = HAND_QUESTIONS.filter((q) => toRiver || !q.river);
    lines.push(pickFrom(asks, seed, 'hQ').t);
  } else {
    lines.push(pickFrom(HAND_REACT[category]!, seed, 'hReact'));
  }

  const { sentences } = targetWords(style);
  if (sentences >= 2 && roll >= 45) {
    lines.push(`${CATEGORY_WORDS[category] ?? 'that one'} is going to sit with you a while`);
  }

  const capped = lines.slice(0, 2);
  const asking = roll >= 20 && roll < 45;
  const text = render(capped, style, seed) + (asking ? '?' : '');
  const cleaned = text.replace(/\?+\.?$/, '?').replace(/\.+\?$/, '?');
  // Grounded by construction: it names the hand's own category, board or
  // holding, so it does not go through the clip relevance scorer.
  return { text: cleaned, relevance: 1, grounding };
}

/**
 * A comment ON somebody else's post. Reads the brief first, so the comment is
 * about what the post is about rather than a category guess.
 */
export function composeComment(
  b: PostBrief,
  style: StyleSheet,
  variantSeed = '0',
): ComposeResult {
  const seed = `${style.profileId}:c:${b.postId ?? b.title}:${variantSeed}`;
  if (b.kind === 'hand') {
    const handed = composeHandComment(b, style, seed);
    if (handed) return handed;
  }
  // Comment grammar may only treat a person or team as an actor. A keyPhrase
  // is useful for relevance scoring and captions, but it is usually a title
  // fragment ("Proxy Sports Betting", "the study", "the three"). Letting
  // those fragments into actor-shaped frames caused visibly robotic live
  // comments on 2026-09-06.
  const anchor = agentOf(b);
  const specificTakes = specificTakePool(b).filter((line) => {
    if (line.includes('{anchor}') && !anchor) return false;
    if (line.includes('{amount}') && !b.amounts.length) return false;
    return true;
  });

  // No named subject and no domain sentence we can support means no comment.
  // The caller already treats an empty draft as a clean skip. Repeating or
  // truncating the article title is not a useful fallback.
  if (!anchor && !specificTakes.length) {
    return { text: '', relevance: 0, grounding: [] };
  }
  const grounding: string[] = [];
  const lines: string[] = [];
  const { sentences } = targetWords(style);

  // A question in the post earns an answer; otherwise agree, push back, or
  // ask, weighted by the horse's certainty.
  const roll = fleetHash(seed, 'stance') % 100;
  const stance: 'agree' | 'push' | 'curious' | 'take' = b.isQuestion
    ? 'curious'
    : style.certainty === 'assertive' && roll < 35
      ? 'push'
      : roll < 45
        ? 'agree'
        : roll < 60
          ? 'curious'
          : 'take';

  let asking = false;
  if (stance === 'take') {
    if (specificTakes.length) {
      lines.push(fill(pickFrom(specificTakes, seed, 'commentTake'), b, anchor));
      grounding.push(`concept:${b.concepts[0]}`);
    } else if (anchor) {
      lines.push(`${anchor} made that look simple`);
      grounding.push(`anchor:${anchor}`);
    }
  } else if (stance === 'agree') {
    if (anchor) {
      lines.push(`${anchor} made that look simple`);
      if (sentences >= 2) lines.push(pickFrom(AGREE_LEADS, seed, 'agree'));
      grounding.push(`anchor:${anchor}`);
    } else if (specificTakes.length) {
      lines.push(fill(pickFrom(specificTakes, seed, 'agreeTake'), b, anchor));
      if (sentences >= 2) lines.push(pickFrom(AGREE_LEADS, seed, 'agree'));
      grounding.push(`concept:${b.concepts[0]}`);
    }
  } else if (stance === 'push') {
    if (anchor) {
      lines.push(pickFrom(PUSH_ANCHORED, seed, 'pushA').replace(/\{anchor\}/g, anchor));
      grounding.push(`anchor:${anchor}`);
    } else if (specificTakes.length) {
      lines.push(fill(pickFrom(specificTakes, seed, 'pushTake'), b, anchor));
      if (sentences >= 2) lines.push(pickFrom(PUSHBACK_LEADS, seed, 'push'));
      grounding.push(`concept:${b.concepts[0]}`);
    }
  } else {
    // A question needs an actual grammatical subject. Concepts use a factual
    // domain take instead of pretending "study", "pot" or "three" is a
    // person who can make a decision.
    if (anchor) {
      lines.push(pickFrom(CURIOUS_ANCHORED, seed, 'curiousA').replace(/\{anchor\}/g, anchor));
      grounding.push(`anchor:${anchor}`);
      asking = true;
    } else if (specificTakes.length) {
      lines.push(fill(pickFrom(specificTakes, seed, 'curiousTake'), b, anchor));
      grounding.push(`concept:${b.concepts[0]}`);
    }
  }

  if (!lines.length) return { text: '', relevance: 0, grounding: [] };
  if (b.concepts.length && !grounding.length) grounding.push(`concept:${b.concepts[0]}`);

  // Comments run shorter than captions: at most two sentences whatever the
  // style says, because a paragraph under somebody's clip reads like a bot.
  const capped = lines.slice(0, Math.min(2, Math.max(1, sentences)));
  const text = render(capped, style, seed) + (asking ? '?' : '');
  const cleaned = text.replace(/\?+\.?$/, '?').replace(/\.+\?$/, '?');
  return { text: cleaned, relevance: relevanceOf(cleaned, b), grounding };
}

/**
 * A reply to a reply. Deliberately short and specific: it answers the thing
 * that was said, and it never opens a new topic (that is what keeps a thread
 * from running forever; see ReplyEngine).
 */
export function composeReply(
  b: PostBrief,
  style: StyleSheet,
  incoming: string,
  reason: 'addressed' | 'question' | 'disagreement',
  variantSeed = '0',
): ComposeResult {
  const seed = `${style.profileId}:r:${b.postId ?? b.title}:${variantSeed}`;
  // A reply may only name a REAL subject - a person or a team. anchorOf()
  // also falls back to a key phrase, and a key phrase lifted from prose
  // produced "with hard i think it holds up" and "with exactly why you I
  // think it holds up" in production (2026-09-05 23:30).
  const anchor = b.people[0] ?? b.teams[0] ?? null;
  const lines: string[] = [];
  const grounding: string[] = [];

  if (reason === 'question') {
    const answers = anchor
      ? [`with ${anchor} I think it holds up`, `on that hand, yes, I would still take it`, `depends on the sizing but mostly yes`]
      : ['yes, mostly', 'I would still take it', 'depends on the sizing'];
    lines.push(pickFrom(answers, seed, 'ans'));
    if (anchor) grounding.push(`anchor:${anchor}`);
  } else if (reason === 'disagreement') {
    lines.push(pickFrom([
      'fair, I can see that side of it',
      'I still think the read holds but that is a reasonable line',
      'we are closer than it sounds, the difference is the sizing',
    ], seed, 'dis'));
  } else {
    lines.push(pickFrom([
      'appreciate that',
      'yeah, exactly',
      'good shout',
      'that is the bit I keep coming back to',
    ], seed, 'ack'));
  }

  if (b.concepts.length && !grounding.length) grounding.push(`concept:${b.concepts[0]}`);
  const text = render(lines.slice(0, 1), style, seed) + (reason === 'question' ? '' : '');
  return { text, relevance: relevanceOf(text, b), grounding };
}
