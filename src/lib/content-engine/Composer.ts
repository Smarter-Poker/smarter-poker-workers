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
 * This composer remains deterministic, free, and unable to invent a player
 * who is not in the title. VoiceWriter may put one separately budgeted,
 * qualified ModelWriter candidate through the same gates first; this path is
 * the bounded fallback for every disabled, exhausted or unavailable outcome.
 */
import { briefForComment, isUninformativeTitle, publicFigureDomain, type PostBrief } from './PostBrief.js';
import { fleetHash } from './FleetScheduler.js';
import { render, targetWords, type StyleSheet } from './StyleSheet.js';
import { isDisagreement, isQuestion } from './ReplyEngine.js';

// ─── takes, by concept ───────────────────────────────────────────────────
// {anchor} is the subject named in the post. {amount} is a real number from
// it. Every line has to read as a thing a person would say about THAT.

const POKER_TAKES: Record<string, string[]> = {
  bluff: [
    'running a bluff through that many streets takes a certain kind of nerve',
    "the bluff's the easy part, the sizing is what sells it",
    "you've got to be willing to be wrong out loud to fire that",
    'nobody folds that river unless the story adds up from the flop',
    "that line only works if you've been playing it straight all session",
    "a bluff's only as good as the story it tells",
    'the best bluffs start with picking the right person to bluff',
    "bluffing is mostly about who's sitting across from you",
    'a bluff that gets caught still buys you calls later',
  ],
  hero_call: [
    'calling that down needs a read you can defend to yourself later',
    "the call isn't brave, it's just paying attention",
    'most people find a fold there and never think about it again',
    "that's the call you replay for a week either way",
    "hero calls only look heroic when they're right",
    'a hero call is just trusting the read over the nerves',
  ],
  cooler: [
    'nothing to be done there, the money was always going in',
    "that's not a mistake, that's just the deck",
    'both players played it right and one of them still loses the stack',
    "coolers are part of the deal, you can't fold those",
    "nobody's getting away from a cooler like that",
  ],
  pocket_aces: [
    'pocket aces are still one pair when the pot gets uncomfortable',
    'pocket aces make the first decision easy and every later street harder',
    'the discipline with pocket aces starts when the board stops cooperating',
    'pocket aces win plenty and still create some of the hardest folds',
  ],
  reaction: [
    'the reaction after a hand like that tells the whole story',
    'watching the reaction is half the reason this hand is worth replaying',
    'that reaction says exactly how unusual the decision was',
    'the hand ends, but the reaction is what stays with you',
  ],
  bad_beat: [
    "brutal, and the maths doesn't care how it felt",
    'that runout is the reason people quit and the reason people stay',
    'the hand was won on the turn and lost on the river',
    'no read fixes that, it was already over',
    "bad beats sting, but they're why the games stay good",
    'a bad beat is just the deck reminding everybody who is in charge',
  ],
  all_in: [
    'stack in the middle and no way back from it',
    "once it's all in the rest is arithmetic",
    'the shove is the easy click, the fold is the hard one',
    'all in is where you find out what people really have',
    'getting it all in good is the only part you control',
  ],
  final_table: [
    'final table pressure changes what people are willing to do with a marginal hand',
    'ICM turns a clear call into a fold and everybody knows it',
    'the shortest stack sets the pace at that table whether they mean to or not',
    'final tables are where the pay jumps start messing with people',
    'everybody tightens up at a final table and the good players know it',
  ],
  heads_up: [
    'heads-up poker strips the table down to pressure and adjustment',
    'with two players left, every tendency gets expensive quickly',
    'heads up rewards the player who adjusts first and keeps adjusting',
    'heads up is the purest test there is in poker',
  ],
  bracelet: [
    'a bracelet changes how the rest of a career reads',
    'people remember the win, not the four days it took',
    'winning a bracelet never gets old for anybody',
    "a bracelet's the one thing everybody in poker wants",
    'bracelets get the headlines, the grind behind them never does',
  ],
  main_event: [
    'main event fields are their own animal',
    'a deep main event run is mostly patience and one good day',
    'the main event is the one everybody circles on the calendar',
    'main event structure gives you time to actually play poker',
  ],
  river: [
    "the river's where the honesty shows up",
    'every plan survives until the river card',
    'the river is where most people give their hand away',
    'river decisions are where the real money moves',
  ],
  flop: [
    'the flop decided that one, the rest was admin',
    "texture like that plays itself if you're paying attention",
    'flop texture tells you most of what you need to know',
    'reading the flop right saves you a lot of trouble later',
  ],
  gto: [
    "the solver line and the winning line aren't always the same at this level",
    "balance is fine until somebody clearly isn't balanced",
    'you learn the theory so you know exactly when to leave it',
    'solvers are a map, not the territory',
    'GTO is the baseline, the money is in the adjustments',
  ],
  exploit: [
    "if somebody keeps folding, keep betting, that's the whole strategy",
    "exploits pay better than balance against a table that isn't adjusting",
    "exploiting a table that won't adjust is just good poker",
    "find what somebody won't do and lean on it",
    'the exploit is where the money actually comes from in most games',
  ],
  range: [
    'the range is the answer, the hand is just one card combination',
    'thinking in ranges is the shift that changes everything',
    'put them on a range, not a hand',
    'range thinking takes the guesswork out of most spots',
  ],
  three_bet: [
    'three-bet sizing in live games is still too small and everybody knows it',
    "the three-bet is fine, it's the plan for the turn that's missing",
    'a good three-bet range is the backbone of a winning game',
    'three-betting wider is the easiest leak to fix in most games',
  ],
  check_raise: [
    'the check raise there is the only line that gets value from worse',
    "checking to raise takes patience most people don't have",
    "a check raise says a lot, you'd better mean it",
    'nothing puts pressure on like a well-timed check raise',
  ],
  fold: [
    'a good fold never gets a clip made about it',
    'that laydown is worth more than most of the hands people brag about',
    "folding is a skill people don't give enough credit",
    'the folds you make are what keep you in the game',
  ],
  tilt: [
    'tilt costs more than any single bad call ever will',
    'the hand was fine, the next twenty minutes are the problem',
    "tilt's the most expensive leak there is",
    'walking away for ten minutes beats any tilt strategy',
  ],
  bankroll: [
    'bankroll management is the least fun skill and the one that keeps people playing',
    'playing over your roll turns variance into a real problem',
    'a real bankroll lets you play your best game without sweating every hand',
    'nobody plans to go broke, they just skip the bankroll part',
  ],
  variance: [
    "variance is real and nobody's exempt from it",
    "a downswing feels like a leak and usually isn't",
    "heaters end, that's the whole point of them",
    "variance doesn't care how well you played",
  ],
  high_stakes: [
    'the numbers stop meaning anything at that level',
    'stakes that size change what a hand is worth psychologically',
    'high stakes games are a different world',
    'watching high stakes poker never gets old',
  ],
  study: [
    "the study is where results come from, the table's just where they show up",
    'reviewing your own losses is worse and better than anything else you can do',
    'the study away from the table is what actually moves the needle',
    'study time is the least glamorous part and the most important',
  ],
  pot: [
    'a pot that size makes every decision feel louder',
    "the pot gets the headline, the line is what's worth studying",
    "big pots show who's comfortable under pressure",
    'pots like that are why people love this game',
  ],
  read: [
    'a read like that is a hundred small hands paying off at once',
    "you can't teach that timing, you can only put in the hours",
    'a good read beats a good hand more often than people think',
    "reads come from paying attention when you're not in the hand",
  ],
  tournament: [
    'tournament poker rewards surviving more than winning pots',
    'one bad level costs more than three good ones make',
    'tournament poker is a marathon, not a sprint',
    'surviving the long days is half of tournament poker',
    'the tournament grind is brutal and people still line up for it',
  ],
  cash_game: [
    'cash games punish the same mistake every night until you fix it',
    "the money plays differently when it's deep",
    'cash games reward patience more than anything',
    'the best cash players just keep making good decisions all night',
  ],
  plo: [
    'PLO equities run so much closer than people expect',
    'four cards turns every read into a guess with extra steps',
    'PLO swings are no joke',
    "in PLO you're drawing to something almost every hand",
  ],
  stack: [
    'stack depth changes every decision',
    'deep stacks reward the better player',
    'the stack sizes tell you most of the story',
  ],
  bounty: [
    'bounties change the math on every call',
    'bounty tournaments reward whoever is willing to put people to the test',
  ],
  satellite: [
    'satellites are the cheapest way into the big events',
    'satellite bubbles are a different game entirely',
  ],
  short_deck: [
    "short deck plays nothing like hold'em",
    'short deck makes every hand feel like a coin flip',
  ],
};

// No card, stake, pot, bluff or hand language here: these lines sit under
// sports clips, and "what does Lebron James do there if the card bricks"
// reached the harness output under a basketball clip (P2C-01).
const SPORT_TAKES: Record<string, string[]> = {
  dunk: [
    '{anchor} going up like the rim owed money',
    'that had no business going down and it went down anyway',
    'the second jump is the part nobody talks about',
    'whoever was under that is going to hear about it all week',
    'a dunk like that changes the whole mood of a game',
    "you don't see a dunk like that every night",
    'dunks like that are why people buy the expensive seats',
  ],
  three: [
    "pulling from that range shouldn't be a normal shot and it is now",
    'the release is so quick the closeout never mattered',
    "that's a bad shot for everyone else and a good one for {anchor}",
    'a three like that takes the air out of a building',
    'confidence on a three like that is half the shot',
  ],
  buzzer_beater: [
    'the whole building knew it was going in',
    'taking that shot with the clock like that is its own skill',
    'games get decided by about four seconds and that was them',
    'a buzzer beater is the best feeling in sports',
    'you practice the buzzer beater a thousand times for one night like this',
  ],
  block: [
    "that's timing, not height",
    'meeting it at the top like that is a decision you make early',
    'a block like that changes how a team attacks the rest of the night',
    'nothing kills a run like a clean block',
  ],
  crossover: [
    'the defender did nothing wrong and still ended up on the floor',
    'handles like that are hours nobody watched',
    'a crossover like that is years of work in half a second',
  ],
  assist: [
    'seeing that pass before it existed is the actual talent',
    'the finish gets the clip, the pass won the possession',
    'an assist like that makes everyone on the floor better',
  ],
  touchdown: [
    'that whole drive was set up two plays earlier',
    '{anchor} finding the end zone on a play that was going nowhere',
    "you can't coach the instinct on a touchdown like that",
    'a touchdown like that swings the whole game',
  ],
  catch: [
    'concentration on that is the whole highlight',
    'that catch is all concentration',
    'a catch like that is years of practice showing up at once',
  ],
  interception: [
    'that was read the moment the ball left',
    "jumping the route that hard only works if you're certain",
    'an interception like that flips the whole game',
  ],
  home_run: [
    'that ball left in a hurry',
    'a home run swing like that looks easy and never is',
    'nobody in the park had to wonder where that home run was going',
  ],
  strikeout: [
    'a good strikeout pitch is set up by the ones before it',
    'strikeouts like that are all about command',
  ],
  goal: [
    'the finish was calm and everything before it was not',
    "that angle shouldn't be a goal",
    'a goal like that is all composure',
    'you finish a goal like that on instinct',
  ],
  save: [
    'a save like that keeps a whole team in it',
    'the reflexes on that save are ridiculous',
  ],
  knockout: [
    'it was over before anybody in the building processed it',
    'the setup punch is the one that actually did the damage',
    'a knockout like that ends the conversation',
  ],
  comeback: [
    'nobody was writing about this team an hour ago',
    'the run started before the crowd noticed it was a run',
    'a comeback like that is all belief',
    'comebacks like that are why you never turn a game off',
  ],
  record: [
    'records like that stand until somebody very specific comes along',
    "putting a number like that up in one night isn't normal",
    'a record like that takes years to even get close to',
  ],
  playoffs: [
    'playoff games are a different sport and this is why',
    'the playoffs are where you find out who really wants it',
    'playoff pressure changes everything',
  ],
  footwork: [
    'the footwork is the highlight, everything after it was inevitable',
    'balance like that is coaching plus about ten thousand reps',
    'footwork like that is the part nobody practices enough',
  ],
  defense: [
    '{anchor} holding position there is real work nobody claps for',
    'that stop is worth as much as any bucket and gets a tenth of the attention',
    'staying in front for a full possession is harder than it looks',
    'defense like that wins games people forget about',
    'good defense never gets the replay it deserves',
  ],
  trade: [
    'that changes the whole shape of the roster',
    'somebody is going to look very smart or very silly in about a year',
    'trades like that get judged a year from now, not today',
  ],
  injury: [
    'hate seeing that, the season turns on those moments',
    'nobody wants to see an injury like that',
  ],
  rookie: [
    'doing that as a rookie is the part that should worry everybody else',
    "rookies aren't supposed to look this comfortable",
  ],
};

// ─── takes that assert an event ─────────────────────────────────────────
// A take like "people remember the win, not the four days it took" states that
// something HAPPENED. It was published for "I Played The WSOP Canada Main
// Event!! (Every Hand of Day 1)", which is not a win, and "running a bluff
// through that many streets" for an advice short that shows no streets at all
// (P2C-06). Each such line is allowed only when the title states that event.

type Need = (b: PostBrief) => boolean;
const says = (re: RegExp): Need => (b) => re.test(`${b.title} ${b.topic ?? ''}`);
const WIN = /\b(wins?|won|winning|winner|champion|champ|takes? down|took down|captures?|claims?|ships?|shipped|victory)\b/i;
const MULTI_STREET = /\b(triple[- ]barrel\w*|double[- ]barrel\w*|barrel\w*|three streets|every street|all three streets|multi[- ]?street)\b/i;
const RIVER_NAMED = /\briver\w*/i;
const SESSION = /\b(sessions?|vlog|livestream|stream|day \d+)\b/i;
const DEEP_RUN = /\b(deep run|final table|day [2-9]|bubble|itm|in the money|cashed|chip lead(er)?)\b/i;
const FLOPPED = /\b(flopped|on the flop)\b/i;
const TURN_THEN_RIVER = /\b(turn|turned)\b[\s\S]*\briver/i;
const SECOND_EFFORT = /\b(second jump|putback|put[- ]back|tip[- ]?in|follow[- ]?up)\b/i;
const DUNK_ON = /\b(poster\w*|dunk(s|ed)? on|over (him|the|a))\b/i;
const DRIVE = /\bdrive\b/i;
const BROKEN_PLAY = /\b(broken play|scrambl\w*|improvis\w*)\b/i;
const ONE_NIGHT = /\b(career[- ]high|\d+ (points|pts)|in one (game|night)|single[- ]game)\b/i;
const ANGLE = /\b(angle|tight|impossible|from the (corner|byline|line))\b/i;
const CHAOS = /\b(scramble|chaos|chaotic|pinball|scrappy)\b/i;
const SETUP_PUNCH = /\b(combo|combination|setup|set up|jab|body shot)\b/i;
const HOOPS: Need = (b) => b.sport === 'nba' || b.sport === 'ncaa';

/** Exported for the law test that keeps every key pointing at a real take. */
export const TAKE_NEEDS: Record<string, Need> = {
  'running a bluff through that many streets takes a certain kind of nerve': says(MULTI_STREET),
  'nobody folds that river unless the story adds up from the flop': says(RIVER_NAMED),
  "that line only works if you've been playing it straight all session": says(SESSION),
  'the hand was won on the turn and lost on the river': says(TURN_THEN_RIVER),
  'a bracelet changes how the rest of a career reads': says(WIN),
  'people remember the win, not the four days it took': says(WIN),
  'winning a bracelet never gets old for anybody': says(WIN),
  'a deep main event run is mostly patience and one good day': says(DEEP_RUN),
  'the flop decided that one, the rest was admin': says(FLOPPED),
  'the second jump is the part nobody talks about': says(SECOND_EFFORT),
  'whoever was under that is going to hear about it all week': says(DUNK_ON),
  'that whole drive was set up two plays earlier': says(DRIVE),
  '{anchor} finding the end zone on a play that was going nowhere': says(BROKEN_PLAY),
  "putting a number like that up in one night isn't normal": says(ONE_NIGHT),
  "that angle shouldn't be a goal": says(ANGLE),
  'the finish was calm and everything before it was not': says(CHAOS),
  'the setup punch is the one that actually did the damage': says(SETUP_PUNCH),
  'that stop is worth as much as any bucket and gets a tenth of the attention': HOOPS,
  'staying in front for a full possession is harder than it looks': HOOPS,
  '{anchor} holding position there is real work nobody claps for': HOOPS,
};

/** Every take line, for the law tests. */
export function allTakeLines(): string[] {
  return [...Object.values(POKER_TAKES), ...Object.values(SPORT_TAKES)].flat();
}

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

// Topic frames ("worth a closer look: {topic}") and tone lines ("came across
// this and it stuck with me") were removed on 2026-09-21 (voice-fix). They
// wrapped a scraped headline in a generic reaction whenever no grounded take
// survived, which is the "post it anyway" path the caption gate exists to
// close. No grounded take, no caption.

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
function pickDistinct(arr: string[], avoid: string, seed: string, salt: string): string | null {
  const taken = contentWords(avoid);
  const fresh = arr.filter((c) => {
    for (const w of contentWords(c)) if (taken.has(w)) return false;
    return true;
  });
  if (!fresh.length) return null;
  return fresh[fleetHash(seed, salt) % fresh.length]!;
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
  // Only a public figure of the post's own world. Never a team (the channel's
  // team became the actor: "Warriors going up like the rim owed money" for a
  // Porzingis dunk), never a capitalised word ("Suddenly", "Oct.",
  // "Streamer"), never a name we cannot identify, which might belong to a
  // member of this club (P2C-01, P2C-07, P2C-12).
  if (b.domain !== 'poker' && b.domain !== 'sports') return null;
  const src = (b.source ?? '').toLowerCase();
  for (const p of b.people) {
    if (publicFigureDomain(p) !== b.domain) continue;
    if (src && src.includes(p.toLowerCase())) continue;
    return p;
  }
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
  // Never cross domains. A stored poker brief containing a stale sports
  // concept once turned an EPT debut into "doing that as a rookie". General
  // briefs are intentionally unsupported until their domain is known.
  const table = b.domain === 'poker' ? POKER_TAKES : b.domain === 'sports' ? SPORT_TAKES : null;
  if (!table) return [];
  const hits: string[] = [];
  for (const c of b.concepts) {
    const lines = table[c];
    if (!lines) continue;
    for (const line of lines) {
      // A take that asserts an event only when the title states it (P2C-06).
      const need = TAKE_NEEDS[line];
      if (!need || need(b)) hits.push(line);
    }
  }
  return hits;
}

/** A caption is publishable only when its title supports a domain take. */
export function hasSpecificTake(b: PostBrief): boolean {
  return specificTakePool(b).length > 0;
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
  /** Unstyled meaning, used to prevent two styled copies on one post. */
  semanticKey?: string;
  /** Set when the composer refuses on purpose. The reason is reported, not retried. */
  skip?: 'reply_ungrounded';
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
): { text: string; grounding: string[] } | null {
  const candidates: Array<{ text: string; grounding: string[] }> = [];

  for (const tpl of specificTakePool(b)) {
    const filled = fill(tpl, b, anchor);
    if (!filled) continue;
    const g: string[] = [];
    if (tpl.includes('{anchor}') && anchor) g.push(`anchor:${anchor}`);
    if (b.concepts.length) g.push(`concept:${b.concepts[0]}`);
    candidates.push({ text: filled, grounding: g });
  }

  // No grounded take survived interpolation: say nothing. The old fallbacks
  // wrapped the scraped headline in "worth a closer look: {topic}" or a tone
  // line ("came across this and it stuck with me"), which is the "we did not
  // understand it, post it anyway" path the caption gate exists to close.
  if (!candidates.length) return null;

  const scored = candidates.map((c) => ({ ...c, score: relevanceOf(c.text, b) }));
  const good = scored.filter((c) => c.score >= RELEVANCE_FLOOR);
  const pool = good.length ? good : scored.sort((a, z) => z.score - a.score).slice(0, 3);
  return pool[fleetHash(seed, 'open') % pool.length]!;
}

/** What a caption asks, when this horse's style asks anything. */
const CAPTION_QUESTIONS: Record<'poker' | 'sports', string[]> = {
  poker: ["what's your read", 'anyone see it differently', 'would you change anything', 'is that a fair take'],
  sports: ['what stood out to you', 'what did you make of it', 'what was the best part for you', 'is that a fair take'],
};

/**
 * One namespace for what a line MEANS, whatever styling it wears and whether
 * it opened a caption or a comment. Captions used 'caption:' and comments
 * 'comment:', so a comment could restate the caption above it and the
 * same-post check never saw it (P2C-05).
 */
export function meaningKey(line: string): string {
  return `meaning:${line.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim()}`;
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
  // A title alone is not comprehension. The old fallback wrapped arbitrary
  // scraped text in "worth a look" and scored the repeated title as relevant,
  // allowing poker posts about aliens and sports clips with clipped captions.
  // Silence is recoverable; publishing something we did not understand is not.
  if (!hasSpecificTake(b)) return { text: '', relevance: 0, grounding: [] };

  const seed = `${style.profileId}:${b.postId ?? b.title}:${variantSeed}`;
  // Only a public figure of this post's own world can be the subject of a
  // sentence. anchorOf() also returns teams and title fragments, and through
  // it the Warriors CHANNEL went "up like the rim owed money" for a Porzingis
  // dunk and the fragment "Dunk DUNKMAN" did the same (P2C-01, P2C-07).
  const anchor = agentOf(b);
  const grounding: string[] = [];
  const { sentences } = targetWords(style);

  const lines: string[] = [];
  const chosen = chooseOpening(b, seed, anchor);
  if (!chosen) return { text: '', relevance: 0, grounding: [] };
  lines.push(chosen.text);
  grounding.push(...chosen.grounding);

  // Extra sentences for the longer styles.
  if (sentences >= 2 && b.concepts.length) {
    const groundedAngles = specificTakePool(b).filter((t) => !t.includes('{'));
    const angle = groundedAngles.length ? pickDistinct(groundedAngles, lines[0]!, seed, 'angle1') : null;
    if (angle) lines.push(angle);
  }

  // The question habit, when the style has one.
  const wantsQuestion = !b.isQuestion && style.closer !== 'tag_question' && style.questionRate > 0
    && (fleetHash(seed, 'q') % 100) / 100 < style.questionRate;
  const question = wantsQuestion
    ? pickFrom(CAPTION_QUESTIONS[b.domain === 'sports' ? 'sports' : 'poker'], seed, 'qline')
    : undefined;

  // The question is the last thing said, after any closer, and nothing else
  // ever ends in "?". Appending "?" after render() published "what is your
  // read. i keep coming back to that?" and "...what is your read...?" (P2C-10).
  const text = render(lines, style, seed, { question, varyCloser: true });
  return { text, relevance: relevanceOf(text, b), grounding, semanticKey: meaningKey(lines[0]!) };
}

/**
 * A renewable, factual news fallback for an article the opinion composer does
 * not understand well enough to discuss. It reports the publisher's own full
 * headline with explicit attribution and adds no horse-authored claim. Video
 * titles never use this path: a video still needs a supported domain take.
 */
const SOURCE_REPORT_FRAMES = [
  (source: string, title: string) => `${source} reports: ${title}`,
  (source: string, title: string) => `From ${source}: ${title}`,
  (source: string, title: string) => `${title}, according to ${source}`,
  (source: string, title: string) => `Reading from ${source}: ${title}`,
];
const CLIPPED_HEADLINE_END = /\b(?:a|an|and|are|at|but|by|do|does|for|from|in|is|of|on|or|the|to|was|were|with)\s*[.!?]*$/i;

export function composeSourceReportedNews(
  b: PostBrief,
  style: StyleSheet,
  variantSeed = '0',
): ComposeResult {
  if (b.kind !== 'link' || (b.domain !== 'poker' && b.domain !== 'sports')) {
    return { text: '', relevance: 0, grounding: [] };
  }
  const title = b.title.trim();
  const source = String(b.source ?? '').replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim();
  if (
    !source || source.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9 .&'/-]*$/.test(source)
    || title.length < 12 || title.length > 180
    || isUninformativeTitle(title, source)
    || /(?:\.\.\.|\u2026)/.test(title)
    || CLIPPED_HEADLINE_END.test(title)
  ) {
    return { text: '', relevance: 0, grounding: [] };
  }

  const seed = `${style.profileId}:source-report:${source}:${title}:${variantSeed}`;
  const frame = SOURCE_REPORT_FRAMES[fleetHash(seed, 'frame') % SOURCE_REPORT_FRAMES.length]!;
  const text = render([frame(source, title)], style, seed, { noOpener: true, noCloser: true });
  return {
    text,
    relevance: relevanceOf(text, b),
    grounding: [`source:${source}`, `headline:${title}`],
    semanticKey: meaningKey(`source report ${source} ${title}`),
  };
}

/**
 * Reaction pools for commenting, split by the post's world (P2C-01).
 *
 * "What does Lebron James do there if the card bricks" and "curious how
 * {anchor} plays that at a different stake" were published under basketball
 * clips, and "not sure Lebron James deserves the blame on that one" blamed a
 * player for something no title said happened (p2-voice-c, 2026-09-21). Card,
 * stake and bricks language lives in the poker pools only, and no line
 * assigns blame.
 */
interface CommentPools {
  agree: string[];
  pushback: string[];
  /** Questions about a named public figure, when the title names what they did. */
  curious: string[];
  /** Questions about a named public figure, when it names nothing more. */
  curiousGeneral: string[];
  pushAnchored: string[];
  /** Praise for a named public figure: only when the title says what they did. */
  praise: string[];
}

const COMMENT_POOLS: Record<'poker' | 'sports', CommentPools> = {
  poker: {
    agree: ['this is the part people miss', 'exactly this', 'said what I was thinking', 'hard to argue with any of that', "couldn't agree more"],
    pushback: ['not sure I see it that way', 'I read that spot differently', "I'd push back on that a bit", "I think it's closer than it looks"],
    curious: [
      'what does {anchor} do there if the card bricks',
      'curious how {anchor} plays that at a different stake',
      'would {anchor} play it the same way today',
      "what's {anchor} thinking there",
    ],
    curiousGeneral: ['how do you rate {anchor} these days', "what's the best thing you've picked up from {anchor}"],
    pushAnchored: ['I read {anchor} differently there', "not sure I'd copy {anchor} there"],
    praise: ['{anchor} made that look simple', 'good stuff from {anchor}', "that's why people watch {anchor}"],
  },
  sports: {
    agree: ['this is the part people miss', 'exactly this', 'said what I was thinking', 'hard to argue with any of that', "couldn't agree more"],
    pushback: ['not sure I see it that way', "I think it's closer than it looks", "I'd want to see it from another angle first"],
    curious: [
      'what do you make of {anchor} here',
      'where does {anchor} rank for you right now',
      'is this the best version of {anchor} we have seen',
    ],
    curiousGeneral: ['what do you make of {anchor} here', 'where does {anchor} rank for you right now'],
    pushAnchored: ['I read {anchor} differently here', "I'd want to see more from {anchor} before I buy it"],
    praise: ['{anchor} made that look easy', 'good stuff from {anchor}', "that's why people watch {anchor}"],
  },
};

function withAnchor(line: string, anchor: string): string {
  return line.replace(/\{anchor\}/g, anchor);
}

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
  // A question is rendered last and is the only thing that ends in "?"
  // (P2C-10). Appending "?" after render() had added a verdict closer
  // produced "...that is the part I noticed?".
  const text = asking ? render([], style, seed, { question: capped[0] }) : render(capped, style, seed);
  // Grounded by construction: it names the hand's own category, board or
  // holding, so it does not go through the clip relevance scorer.
  return { text, relevance: 1, grounding, semanticKey: meaningKey(lines[0]!) };
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
  // A comment speaks poker or sport, in that world's own words. A post we
  // cannot place gets silence, not card talk under a business interview
  // (P2C-01: fail closed when the domain is general).
  if (b.domain !== 'poker' && b.domain !== 'sports') return { text: '', relevance: 0, grounding: [] };
  const pools = COMMENT_POOLS[b.domain];
  // Only a public figure of this post's world may act in a sentence: never a
  // team, never the channel, never a capitalised word, never a name we cannot
  // identify (P2C-01, P2C-07, P2C-12). A key phrase is a title fragment
  // ("Proxy Sports Betting", "the study") and cannot act at all.
  const anchor = agentOf(b);
  const fillable = specificTakePool(b).filter((line) => {
    if (line.includes('{anchor}') && !anchor) return false;
    if (line.includes('{amount}') && !b.amounts.length) return false;
    return true;
  });
  // Prefer the lines that actually carry the subject; the rest can only be
  // drafted and thrown away by the relevance floor.
  const strong = fillable.filter((line) => relevanceOf(fill(line, b, anchor), b) >= RELEVANCE_FLOOR);
  const specificTakes = strong.length ? strong : fillable;

  // No named subject and no domain sentence we can support means no comment.
  // The caller already treats an empty draft as a clean skip. Repeating or
  // truncating the article title is not a useful fallback.
  if (!anchor && !specificTakes.length) {
    return { text: '', relevance: 0, grounding: [] };
  }
  const grounding: string[] = [];
  const lines: string[] = [];
  let lead: string | null = null;
  let question: string | undefined;
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

  const take = (salt: string): boolean => {
    if (!specificTakes.length) return false;
    lines.push(fill(pickFrom(specificTakes, seed, salt), b, anchor));
    grounding.push(`concept:${b.concepts[0]}`);
    return true;
  };
  const ask = (): boolean => {
    if (!anchor) return false;
    const pool = b.concepts.length ? pools.curious : pools.curiousGeneral;
    question = withAnchor(pickFrom(pool, seed, 'curiousA'), anchor);
    grounding.push(`anchor:${anchor}`);
    return true;
  };
  // Praise, or pushing back on a named player, needs the title to say what
  // they did: "Codie Sanchez made that look simple" sat under a business
  // interview, and "Oct. made that look simple" under a schedule post.
  const named = Boolean(anchor) && b.concepts.length > 0;

  if (stance === 'take') {
    if (!take('commentTake')) ask();
  } else if (stance === 'agree') {
    if (named) {
      lines.push(withAnchor(pickFrom(pools.praise, seed, 'praise'), anchor!));
      grounding.push(`anchor:${anchor}`);
    } else if (!take('agreeTake')) {
      ask();
    }
    if (lines.length && sentences >= 2) lead = pickFrom(pools.agree, seed, 'agree');
  } else if (stance === 'push') {
    if (named) {
      lines.push(withAnchor(pickFrom(pools.pushAnchored, seed, 'pushA'), anchor!));
      grounding.push(`anchor:${anchor}`);
    } else if (take('pushTake')) {
      if (sentences >= 2) lead = pickFrom(pools.pushback, seed, 'push');
    } else {
      ask();
    }
  } else if (!ask()) {
    take('curiousTake');
  }

  if (!lines.length && !question) return { text: '', relevance: 0, grounding: [] };
  if (b.concepts.length && !grounding.length) grounding.push(`concept:${b.concepts[0]}`);

  // Comments run shorter than captions: at most two sentences whatever the
  // style says, because a paragraph under somebody's clip reads like a bot. A
  // lead ("exactly this") goes first so the reaction reads as a reaction, and
  // any question is rendered last, after everything else (P2C-10).
  const said = lead ? [lead, ...lines] : lines;
  const capped = said.slice(0, Math.min(2, Math.max(1, sentences)));
  // A lead is itself an opener and a reaction, so the style's opener and
  // closer are not stacked around it: two sentences is a comment, three is
  // a paragraph.
  const text = render(capped, style, seed, { question, varyCloser: true, noOpener: capped[0] === lead, noCloser: Boolean(lead) });
  // The meaning is the substance, not the lead: two different takes that both
  // open "exactly this" are not the same comment.
  const core = lines[0] ?? question ?? '';
  return { text, relevance: relevanceOf(text, b), grounding, semanticKey: meaningKey(core) };
}

/**
 * A concept as the noun a reply can say back. Every phrase carries its key's
 * own words, so the relevance gate can see what the reply is about.
 */
const CONCEPT_PHRASE: Record<string, string> = {
  bluff: 'the bluff', hero_call: 'the hero call', cooler: 'the cooler', bad_beat: 'the bad beat',
  all_in: 'the all in', final_table: 'the final table', heads_up: 'the heads up play',
  bracelet: 'the bracelet', main_event: 'the main event', river: 'the river', turn: 'the turn',
  flop: 'the flop', gto: 'the GTO side', exploit: 'the exploit', range: 'the range',
  three_bet: 'the three bet', check_raise: 'the check raise', fold: 'the fold', pot: 'the pot',
  stack: 'the stack sizes', tilt: 'the tilt', bankroll: 'the bankroll side', variance: 'the variance',
  bounty: 'the bounty', satellite: 'the satellite', high_stakes: 'the high stakes side',
  cash_game: 'the cash game side', tournament: 'the tournament side', plo: 'the PLO side',
  short_deck: 'short deck', study: 'the study side', read: 'the read',
  call: 'the call', raise: 'the raise', bet: 'the bet',
  dunk: 'the dunk', three: 'the three', buzzer_beater: 'the buzzer beater', block: 'the block',
  crossover: 'the crossover', assist: 'the assist', touchdown: 'the touchdown', catch: 'the catch',
  interception: 'the interception', home_run: 'the home run', strikeout: 'the strikeout',
  goal: 'the goal', save: 'the save', knockout: 'the knockout', comeback: 'the comeback',
  rookie: 'the rookie', record: 'the record', playoffs: 'the playoffs', injury: 'the injury',
  trade: 'the trade', footwork: 'the footwork', defense: 'the defense',
  shot: 'the shot', pass: 'the pass', foul: 'the foul', refs: 'the refs',
};

type ReplyShape = 'question' | 'disagreement' | 'statement';

/** Answers about something the comment raised. {x} is that thing. */
const REPLY_LINES: Record<ReplyShape, string[]> = {
  question: [
    'for me {x} is the whole question there',
    "honestly {x} is close for me",
    'I keep going back and forth on {x}',
    "{x} is the part I'd want to see again before I answer",
    'tough one, {x} is closer than it looks',
    "good question, {x} is where I'd be thinking too",
  ],
  disagreement: [
    'fair, {x} is where we see it differently',
    'I hear you on {x}, I still lean the other way',
    "that's a fair read on {x}, I'm just not there yet",
    "we're closer than it sounds on {x}",
  ],
  statement: [
    'yeah, {x} is the part that stuck with me too',
    'agreed on {x}',
    'good point on {x}',
    'right, {x} is the bit I keep coming back to',
    'same, {x} caught my eye as well',
  ],
};

/** Answers about a public figure the comment named. {x} is that name. */
const REPLY_PERSON_LINES: Record<ReplyShape, string[]> = {
  question: ['with {x} I think it holds up', "I'd trust {x} there more than most", '{x} has earned the benefit of the doubt there'],
  disagreement: ['fair, I just read {x} differently', "I hear you, I'd still back {x} there"],
  statement: ['yeah, {x} is always worth watching', "can't argue with you on {x}"],
};

/**
 * A reply to a comment. Deliberately short and specific: it answers the thing
 * that was said, and it never opens a new topic (that is what keeps a thread
 * from running forever; see ReplyEngine).
 *
 * Everything a reply names comes out of the INCOMING comment, in this post's
 * world (P2C-02). This function used to ignore `incoming` entirely: a human's
 * comment became "appreciate that" or "good shout", which named nothing,
 * scored 0 against the relevance floor and was dropped without a trace, so 0
 * of 11 humans in the harness were ever answered. A comment that raises
 * nothing to ground an answer on (empty, generic or off-topic) now returns
 * the explicit skip 'reply_ungrounded' instead of filler.
 */
export function composeReply(
  b: PostBrief,
  style: StyleSheet,
  incoming: string,
  reason: 'addressed' | 'question' | 'disagreement',
  variantSeed = '0',
): ComposeResult {
  const seed = `${style.profileId}:r:${b.postId ?? b.title}:${variantSeed}`;
  const heard = incoming ?? '';
  // Only a public figure of the post's world can be named back: a human's
  // comment can carry anybody's name, a club member's included.
  const said = briefForComment(heard, b);
  const person = said.people[0] ?? null;
  const concept = said.concepts.find((c) => c in CONCEPT_PHRASE) ?? null;
  if (!person && !concept) {
    return { text: '', relevance: 0, grounding: [], skip: 'reply_ungrounded' };
  }
  // What was said decides the shape of the answer, whatever rule picked it.
  const shape: ReplyShape = isQuestion(heard)
    ? 'question'
    : isDisagreement(heard)
      ? 'disagreement'
      : reason === 'addressed'
        ? 'statement'
        : reason;
  const pool = person ? REPLY_PERSON_LINES[shape] : REPLY_LINES[shape];
  const subject = person ?? CONCEPT_PHRASE[concept!]!;
  const line = pickFrom(pool, seed, 'reply').replace(/\{x\}/g, subject);
  // A reply ends on what it said (no verdict, no tag question), and it opens
  // itself: "fair, ...", "agreed on ...". A style opener in front read as
  // "In fairness, right, the river is the bit I keep coming back to".
  const text = render([line], style, seed, { noCloser: true, noOpener: true });
  // Relevance is measured against the comment being answered, not only the
  // post: a reply that says nothing of what it answers is not an answer.
  return {
    text,
    relevance: relevanceOf(text, said),
    grounding: [person ? `incoming_person:${person}` : `incoming_concept:${concept}`],
  };
}
