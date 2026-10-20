/**
 * HandVoice - saying a hand out loud.
 *
 * WHAT THIS REPLACES. The first version of grounded posts printed the row:
 *
 *   "No hand, all narrative. Qh8c7d6sAd5c on 5s 4s Td 3c 6d. won 184bb"
 *   "nah QTs, board came 6c 7c 9c 9h 3s, won 149bb, right."
 *
 * Dan, seeing them on the feed: "THEY ARE PURE TRASH." He was right. Twelve
 * characters of run-together hole cards, a five-card board printed inline like
 * a query result, and "184bb" - a column name - where a person would say
 * something they felt. Every one of those posts was TRUE and passed eighteen
 * law tests, none of which asked whether anybody would want to read it.
 *
 * THE RULES THIS FILE KEEPS, and they are about the reader, not the data:
 *
 * 1. NEVER print notation. "kings", not "KhKs". "ace-queen offsuit", not
 *    "AQo". The cards get NAMED, the way they are named at a table.
 * 2. NEVER print the board. A player says "on a board that paired", not
 *    "6c 7c 9c 9h 3s". The board's SHAPE is the story; its cards are not.
 * 3. NEVER print big blinds, or any number. Money is felt in comparisons: a
 *    good pot, a big pot, a brutal one.
 * 4. A post is allowed to say LESS than the row knows. Most of what makes a
 *    hand worth telling is one established detail, not a full accounting.
 *
 * AND ONE RULE ABOUT THE TRUTH (2026-09-21 recertification, P3C-03..P3C-10).
 * The first HandVoice knew the board, the net and the tags, and not the
 * action, so it said "held up" about pots nobody called, "committed the stack
 * on the river" about a flop all-in (an all-in board is always dealt out to
 * five cards), "the full stack" about a hand that checked the turn and river,
 * and blamed river cards it had no way to judge. Every claim about what
 * happened in the hand now comes from `HandFacts.play`, which HandStory reads
 * from the action log:
 *
 *   - "held up", "at showdown" only when the hand reached a showdown;
 *   - a street is the street the hand was DECIDED on for this player (its
 *     fold, its all-in, or the last betting street), never the board length;
 *   - "the full stack", "shoved" only when its own stack went in; "got it all
 *     in" only when the pot went all in and was called;
 *   - no line ever says a card was good or bad luck: there is no evaluator;
 *   - small, quiet, ordinary only under forty big blinds, and never "a small
 *     pot" about a cooler, a stack-off or a big loss;
 *   - a board that was run more than once has no single board or river to
 *     describe, so neither is described;
 *   - no backstory: no bankroll, no "a year ago", no "finally".
 *
 * `spokenLineMatches` checks each of those again on the finished sentence, so
 * a future template that forgets its gate still cannot publish the claim.
 */
import type { HandFacts, Street } from './HandStory.js';
import type { PostBrief } from './PostBrief.js';
import { fleetHash } from './FleetScheduler.js';

const RANK_WORDS: Record<string, string> = {
  A: 'aces', K: 'kings', Q: 'queens', J: 'jacks', T: 'tens',
  '9': 'nines', '8': 'eights', '7': 'sevens', '6': 'sixes',
  '5': 'fives', '4': 'fours', '3': 'threes', '2': 'deuces',
};
const RANK_ONE: Record<string, string> = {
  A: 'ace', K: 'king', Q: 'queen', J: 'jack', T: 'ten',
  '9': 'nine', '8': 'eight', '7': 'seven', '6': 'six',
  '5': 'five', '4': 'four', '3': 'three', '2': 'deuce',
};

/**
 * The holding, said the way it is said at a table.
 *
 * "AA" -> "pocket aces". "AKs" -> "ace-king suited". "72o" ->
 * "seven-deuce offsuit".
 * A four-card holding is not spelled out at all - reciting four cards is what
 * a chip counter does, not a player.
 */
export function sayHolding(notation: string, variant: string): string | null {
  const n = (notation ?? '').trim().toUpperCase();
  if (!n) return null;
  if (variant && variant.toLowerCase().startsWith('plo')) return null;
  if (n.length > 4) return null;

  const pair = n.match(/^([AKQJT2-9])\1$/);
  if (pair) {
    const rank = RANK_WORDS[pair[1]!];
    return rank ? `pocket ${rank}` : null;
  }

  const two = n.match(/^([AKQJT2-9])([AKQJT2-9])([SO])?$/);
  if (!two) return null;
  const a = RANK_ONE[two[1]!];
  const b = RANK_ONE[two[2]!];
  if (!a || !b) return null;
  const suitedness = two[3] === 'S' ? ' suited' : two[3] === 'O' ? ' offsuit' : '';
  return `${a}-${b}${suitedness}`;
}

const CARDS_SEEN: Record<Street, number> = { preflop: 0, flop: 3, turn: 4, river: 5 };

/**
 * What the BOARD looked like when the hand was decided for this player -
 * never its cards, and never cards dealt after the fold or the all-in.
 *
 * Null when there was no board yet (a preflop decision) and when the board
 * was run more than once: the stored board is only the first runout, so it
 * is not the board the pot was decided on (P3C-09).
 */
export function sayBoard(f: HandFacts): string | null {
  if (f.play.runouts > 1) return null;
  const cards = (f.board ?? []).slice(0, CARDS_SEEN[f.play.decisiveStreet] ?? 0);
  if (cards.length < 3) return null;
  const ranks = cards.map((c) => c.rank);
  const suits = cards.map((c) => c.suit);

  const suitCounts = new Map<string, number>();
  for (const s of suits) suitCounts.set(s, (suitCounts.get(s) ?? 0) + 1);
  const flushy = Math.max(...suitCounts.values()) >= 3;

  const rankCounts = new Map<string, number>();
  for (const r of ranks) rankCounts.set(r, (rankCounts.get(r) ?? 0) + 1);
  const paired = Math.max(...rankCounts.values()) >= 2;

  const order = 'A23456789TJQKA';
  const idx = [...new Set(ranks)].map((r) => order.indexOf(r)).sort((x, y) => x - y);
  let connected = false;
  for (let i = 0; i + 2 < idx.length; i++) if (idx[i + 2]! - idx[i]! <= 4) connected = true;

  const high = ranks.some((r) => 'AKQ'.includes(r));

  // Short noun phrases. "a board that paired and got wet at the same time"
  // is accurate and unreadable dropped into the middle of a sentence.
  if (flushy && paired) return 'a wet, paired board';
  if (flushy) return 'a three-flush board';
  if (paired) return 'a paired board';
  if (connected) return 'a connected board';
  if (high) return 'a high-card board';
  return 'a dry board';
}

/**
 * The money, FELT rather than counted.
 *
 * `netBb` is exact and useless to a reader. What a player conveys is scale.
 * "A small pot" exists only below forty big blinds, and only the grind lines
 * may use it (P3C-07).
 */
export function sayMoney(f: HandFacts): string | null {
  const n = Math.abs(f.netBb ?? 0);
  if (!n) return null;
  // Noun phrases only. Every phrase must work after "won", "dropped", and
  // "that was" without changing grammatical shape.
  if (n >= 200) return f.isWin ? 'a monster pot' : 'a brutal pot';
  if (n >= 100) return 'a stack-sized pot';
  if (n >= 40) return f.isWin ? 'a solid pot' : 'a painful pot';
  return 'a small pot';
}

/** The street the hand was decided on for this player, said as a player says it. */
export function sayStreet(f: HandFacts): string | null {
  switch (f.play.decisiveStreet) {
    case 'preflop': return 'preflop';
    case 'flop': return 'on the flop';
    case 'turn': return 'on the turn';
    case 'river': return 'on the river';
    default: return null;
  }
}

/** How many times the board was run, when it was run more than once. */
export function sayRuns(f: HandFacts): string | null {
  if (f.play.runouts === 2) return 'twice';
  if (f.play.runouts === 3) return 'three times';
  return null;
}

export interface SpokenHand {
  holding: string | null;
  board: string | null;
  money: string | null;
  street: string | null;
  runs: string | null;
}

export function speak(f: HandFacts): SpokenHand {
  return {
    holding: sayHolding(f.holeNotation, f.variant),
    board: sayBoard(f),
    money: sayMoney(f),
    street: sayStreet(f),
    runs: sayRuns(f),
  };
}

type When = (f: HandFacts) => boolean;
const all = (...ws: When[]): When => (f) => ws.every((w) => w(f));
const not = (w: When): When => (f) => !w(f);
const won: When = (f) => f.isWin;
const lost: When = (f) => !f.isWin;
const showdown: When = (f) => f.play.showdown;
const small: When = (f) => Math.abs(f.netBb) < 40;
const notSmall: When = (f) => Math.abs(f.netBb) >= 40;
const riverDecided: When = (f) => f.play.decisiveStreet === 'river' && f.play.runouts === 1;
/** The pot went all in with this player in it (its own all-in, or a call of one). */
const allIn: When = (f) => f.play.allInStreet !== null;
/** Its own whole stack went in. */
const stackIn: When = (f) => f.play.stackInStreet !== null;
/** It moved all in as a bet or raise, and nobody called. */
const shoveTookIt: When = (f) =>
  f.isWin && !f.play.showdown && f.play.stackInStreet !== null && f.play.aggressionStreets.includes(f.play.stackInStreet);
/** The money went in before the river, got called, and one board was dealt out. */
const ranOut: When = (f) =>
  f.play.allInStreet !== null && f.play.allInStreet !== 'river' && f.play.showdown && f.play.runouts === 1;
const ranMore: When = (f) => f.play.runouts > 1;
/**
 * The pot was over on the street `sayStreet` names: nobody called, or the
 * betting ran to the river. After an earlier all-in it was decided at the
 * showdown, not on the street the money went in.
 */
const endedThere: When = (f) => !f.play.showdown || (f.play.decisiveStreet === 'river' && f.play.runouts === 1);
/** Its own stack went in on the street the hand was decided on. */
const stackInThere: When = (f) => f.play.stackInStreet !== null && f.play.stackInStreet === f.play.decisiveStreet;
/** It called somebody else's all-in and did not move in itself. */
const calledAllIn: When = (f) => f.play.allInStreet !== null && f.play.stackInStreet === null;
const pressedRiver: When = (f) => f.play.riverAggression;
const barrelled: When = (f) =>
  f.play.riverAggression && f.play.aggressionStreets.some((s) => s === 'flop' || s === 'turn');

/**
 * The sentences. Each one is a thing a player might actually say, and each
 * names at most a couple of the parts - a post that uses every field reads
 * like a form.
 *
 * `needs` lists the parts a line cannot do without, so a hand missing one is
 * never given a sentence with a hole in it. `when` is the fact the sentence
 * claims, checked against the action log.
 */
interface Line {
  t: string;
  needs: Array<keyof SpokenHand>;
  when?: When;
}

const LINES: Record<string, Line[]> = {
  big_win: [
    { t: 'Won {money} with {holding}.', needs: ['money', 'holding'] },
    { t: '{holding} held up at showdown.', needs: ['holding'], when: showdown },
    { t: 'Took it down with {holding} and never had to show.', needs: ['holding'], when: not(showdown) },
    { t: '{holding} brought in {money}.', needs: ['money', 'holding'] },
    { t: 'Won the pot with {holding}.', needs: ['holding'] },
    { t: 'Went to showdown with {holding} and dragged {money}.', needs: ['holding', 'money'], when: showdown },
    { t: 'Took down {money} {street} with {holding}.', needs: ['money', 'street', 'holding'], when: not(showdown) },
    { t: 'Shoved {street} with {holding} and got the fold.', needs: ['street', 'holding'], when: shoveTookIt },
    { t: 'Got it all in {street} with {holding} and it held.', needs: ['street', 'holding'], when: all(ranOut) },
    { t: '{holding} on {board}, and the pot came my way.', needs: ['holding', 'board'] },
    { t: 'Ran it {runs} with {holding} and came out ahead.', needs: ['runs', 'holding'], when: all(ranMore, allIn, showdown) },
    { t: 'Finished the hand with {holding} and a win.', needs: ['holding'] },
    // Omaha holdings are never spoken, so these carry an Omaha win.
    { t: 'Got it all in {street} and it held.', needs: ['street'], when: ranOut },
    { t: 'Dragged {money} at showdown.', needs: ['money'], when: showdown },
    { t: 'Collected {money} {street}.', needs: ['money', 'street'], when: not(showdown) },
    { t: 'Called it off {street} and it was good.', needs: ['street'], when: all(calledAllIn, showdown) },
  ],
  bad_beat: [
    // A big loss at showdown. Nothing here says the deck did it: there is
    // no evaluator to prove the player was ahead (P3C-04).
    { t: 'Dropped {money} with {holding}.', needs: ['money', 'holding'], when: notSmall },
    { t: '{holding} on {board}, and I lost the pot.', needs: ['holding', 'board'] },
    { t: 'Lost {money} at showdown with {holding}.', needs: ['money', 'holding'], when: all(showdown, notSmall) },
    { t: 'My stack went in {street}, and I lost at showdown.', needs: ['street'], when: all(stackInThere, showdown) },
    { t: 'The pot went the other way at showdown.', needs: [], when: showdown },
    { t: 'Played {holding} and lost the pot.', needs: ['holding'] },
    { t: 'Went all the way to the river with {holding} and came up short.', needs: ['holding'], when: all(riverDecided, showdown) },
    { t: 'The hand ended in a loss with {holding}.', needs: ['holding'] },
    { t: 'Got it all in {street} with {holding} and ended up on the wrong side.', needs: ['street', 'holding'], when: all(allIn, showdown) },
    { t: 'The whole stack went in {street} and didn\'t come back.', needs: ['street'], when: stackInThere },
    { t: 'Lost the hand with {holding}.', needs: ['holding'] },
    { t: 'Lost {money} with {holding}.', needs: ['money', 'holding'], when: notSmall },
    { t: 'Ran it {runs} and still came out behind.', needs: ['runs'], when: all(ranMore, allIn, showdown) },
  ],
  cooler: [
    { t: 'Lost {money} with {holding} on {board}.', needs: ['money', 'holding', 'board'], when: notSmall },
    { t: 'Reached showdown on {board} and lost the pot.', needs: ['board'], when: showdown },
    { t: 'Went to showdown and lost the pot.', needs: [], when: showdown },
    { t: '{holding} on {board}, and the result was a loss.', needs: ['holding', 'board'] },
    { t: 'The hand ended with {holding} and a loss.', needs: ['holding'] },
    { t: 'Lost at showdown on {board}.', needs: ['board'], when: showdown },
    { t: '{holding}, with the pot going the other way.', needs: ['holding'] },
    { t: 'Played the hand through to a loss at showdown.', needs: [], when: showdown },
    { t: 'Lost the pot holding {holding}.', needs: ['holding'] },
    { t: 'Showed down {holding} and lost the hand.', needs: ['holding'], when: showdown },
    { t: 'The pot went the other way on {board}.', needs: ['board'] },
    { t: 'Got it all in {street} and lost at showdown.', needs: ['street'], when: all(allIn, showdown) },
  ],
  tough_spot: [
    // Losses the reviewer tagged as the player's own kind of spot. Neutral:
    // no luck, no cooler, no deck to blame (P3C-08).
    { t: 'Played {holding} in a pot that went the other way.', needs: ['holding'] },
    { t: 'Lost {money} holding {holding}.', needs: ['money', 'holding'], when: notSmall },
    { t: 'The result with {holding} was a loss.', needs: ['holding'] },
    { t: '{holding} on {board}, and it went the other way.', needs: ['holding', 'board'] },
    { t: 'Dropped the pot with {holding}.', needs: ['holding'] },
    { t: 'Got it all in {street} and came out on the wrong side.', needs: ['street'], when: all(allIn, showdown) },
    { t: 'Went to the river with {holding} and came up short.', needs: ['holding'], when: all(riverDecided, showdown) },
    { t: 'The hand reached showdown on {board}. I lost the pot.', needs: ['board'], when: showdown },
    { t: 'Lost the pot after an all-in {street}.', needs: ['street'], when: all(allIn, showdown) },
    { t: 'The pot went the other way at showdown on {board}.', needs: ['board'], when: showdown },
    { t: 'Finished that hand with {holding} and a loss.', needs: ['holding'] },
    { t: 'Played a big pot with {holding} and lost it.', needs: ['holding'], when: notSmall },
  ],
  river_aggression: [
    { t: 'Kept the pressure on through the river and took it down.', needs: [], when: barrelled },
    { t: 'Put more chips in on the river and won the pot.', needs: [], when: pressedRiver },
    { t: '{board}. One more bet, and the pot came my way.', needs: ['board'], when: pressedRiver },
    { t: 'Pressed the river with {holding} and won.', needs: ['holding'], when: pressedRiver },
    { t: 'Fired the river with {holding} and got paid.', needs: ['holding'], when: all(pressedRiver, showdown) },
    { t: 'Bet the river and got the fold.', needs: [], when: all(pressedRiver, not(showdown)) },
    { t: 'Put chips in on the river and collected the pot.', needs: [], when: pressedRiver },
    { t: 'Stayed on the gas through {board}. Got the result.', needs: ['board'], when: barrelled },
    { t: 'Made one more bet on the river and dragged {money}.', needs: ['money'], when: pressedRiver },
    { t: 'The hand reached the river, where I put more chips in.', needs: [], when: pressedRiver },
    { t: 'Made a river bet with {holding} and won the pot.', needs: ['holding'], when: pressedRiver },
    { t: 'Made the river expensive and collected {money}.', needs: ['money'], when: pressedRiver },
    { t: 'Pressed on the last card and took the pot.', needs: [], when: pressedRiver },
  ],
  big_fold: [
    { t: 'Folded {holding} {street}.', needs: ['holding', 'street'] },
    { t: 'Let it go {street}.', needs: ['street'] },
    { t: 'Put {holding} in the muck.', needs: ['holding'] },
    { t: 'My fold came {street}, before showdown.', needs: ['street'] },
    { t: 'Let {holding} go {street}.', needs: ['holding', 'street'] },
    { t: 'Found the fold on {board}.', needs: ['board'] },
    { t: 'I folded {street}.', needs: ['street'] },
    { t: 'Folded on the river.', needs: [], when: riverDecided },
    { t: '{holding} went into the muck {street}.', needs: ['holding', 'street'] },
    { t: 'My part in the hand ended when I folded {holding}.', needs: ['holding'] },
    { t: 'Put a lot in with {holding} and still let it go {street}.', needs: ['holding', 'street'], when: notSmall },
  ],
  stackoff: [
    { t: 'Everything went in with {holding}. This time it held.', needs: ['holding'], when: all(won, ranOut) },
    { t: 'Got it all in {street} and the pot came my way.', needs: ['street'], when: all(won, allIn, showdown) },
    { t: 'The chips went in on {board}. Won {money}.', needs: ['board', 'money'], when: all(won, allIn, showdown, notSmall) },
    { t: 'Committed the stack {street} and got the result.', needs: ['street'], when: all(won, stackInThere) },
    { t: 'Put the whole stack in with {holding} and it paid off.', needs: ['holding'], when: all(won, stackIn) },
    { t: 'Once the money went in, all that was left was the runout.', needs: [], when: ranOut },
    { t: 'Put the whole stack in on {board} and went to showdown.', needs: ['board'], when: all(stackIn, showdown) },
    { t: 'Full-stack pot with {holding} at showdown.', needs: ['holding'], when: all(stackIn, showdown) },
    { t: 'Got it all in and went to showdown.', needs: [], when: all(allIn, showdown, notSmall) },
    { t: 'Shoved {street} with {holding} and nobody wanted it.', needs: ['street', 'holding'], when: shoveTookIt },
    { t: 'Ran it {runs} for the whole stack and came out ahead.', needs: ['runs'], when: all(won, ranMore, stackIn, showdown) },
    { t: 'Everything went in with {holding} and it went the wrong way.', needs: ['holding'], when: all(lost, allIn, showdown) },
    { t: 'Whole stack in the middle with {holding}, and I won the pot.', needs: ['holding'], when: all(won, stackIn, showdown) },
  ],
  grind: [
    { t: 'Played a small pot with {holding}.', needs: ['holding'], when: all(small, not(stackIn)) },
    { t: 'A small pot with {holding} on {board}.', needs: ['holding','board'], when: all(small, not(stackIn)) },
    { t: 'Wrapped that one up {street}. Nothing dramatic.', needs: ['street'], when: all(won, small, endedThere, not(stackIn)) },
    { t: 'The hand ended with a small pot.', needs: [], when: all(small, not(stackIn)) },
    // A small pot can still be a shove that got through.
    { t: 'Shoved {street} with {holding} and got the fold.', needs: ['street', 'holding'], when: shoveTookIt },
    { t: '{holding} in a small pot.', needs: ['holding'], when: all(small, not(stackIn)) },
    { t: 'Played a small pot on {board}.', needs: ['board'], when: small },
    { t: 'Won the hand with {holding}.', needs: ['holding'], when: won },
    { t: 'Lost a small pot with {holding}.', needs: ['holding'], when: all(lost, small) },
    { t: 'Won a small pot with {holding}.', needs: ['holding'], when: all(won, small) },
    { t: '{holding} on {board}, in a small pot.', needs: ['holding', 'board'], when: small },
    { t: 'The hand was played with {holding}.', needs: ['holding'] },
    { t: 'A small pot decided {street}.', needs: ['street'], when: all(small, endedThere, not(stackIn)) },
    { t: 'Picked up {money} with {holding}.', needs: ['money', 'holding'], when: all(won, notSmall) },
    { t: 'Dropped {money} with {holding}.', needs: ['money', 'holding'], when: all(lost, notSmall) },
    { t: 'Took down {money} {street}.', needs: ['money', 'street'], when: all(won, not(showdown)) },
    { t: 'Won {money} {street}.', needs: ['money', 'street'], when: all(won, notSmall, not(showdown)) },
    { t: 'Ran it {runs} and came out ahead.', needs: ['runs'], when: all(won, ranMore, allIn, showdown) },
    { t: 'Dropped {money} {street}.', needs: ['money', 'street'], when: all(lost, notSmall, riverDecided) },
  ],
};

/**
 * Editorial equivalence, not another source identity or a new ledger key.
 * Different frame IDs can tell the same fact in almost the same way. The
 * observed river-bet/win and showdown/loss clusters did exactly that while
 * every exact-frame freshness check passed. Keep their existing keys, but
 * treat recent use of any member as use of that whole focus. Board, money or
 * holding wording does not make another river-bet/win frame a new focus.
 * The caller supplies the existing, bounded three-hour frame history across
 * categories; this function neither reads a ledger nor extends that window.
 */
const EQUIVALENT_FOCUS_FRAMES: readonly (readonly string[])[] = [
  [1,2,3,4,6,8,9,10,11,12].map(i=>`frame:voice:river_aggression:${i}`),
  [0,7].map(i=>`frame:voice:river_aggression:${i}`), // aggression on earlier streets too
  [
    'frame:voice:bad_beat:4',
    ...[1,2,5,7,9].map(i=>`frame:voice:cooler:${i}`),
    ...[7,9].map(i=>`frame:voice:tough_spot:${i}`),
  ],
];

/** Preserve unknown/exact keys and caller ownership; never mutate history. */
export function equivalentVoiceFrameKeys(recent: ReadonlySet<string>): Set<string> {
  const excluded=new Set(recent);
  for(const group of EQUIVALENT_FOCUS_FRAMES){
    if(group.some(key=>recent.has(key)))for(const key of group)excluded.add(key);
  }
  return excluded;
}

const RAW_CARD_RUN = /[AKQJT2-9][hcds][AKQJT2-9][hcds][AKQJT2-9][hcds]/i;
const INLINE_BOARD = /([AKQJT2-9][hcds]\s+){4}[AKQJT2-9][hcds]/i;
const BARE_BIG_BLINDS = /\b\d+(?:\.\d+)?bb\b/i;
/** One card in notation: "Kc", "Th". Case-sensitive so ordinary words pass. */
const ONE_CARD = /\b[AKQJT][hcds]\b/;
const SHORTHAND_HOLDING = /\b(?:[AKQJT][AKQJT2-9]|[2-9][AKQJT])[so]\b|\b([AKQJT])\1\b/;
const EMOJI = /\p{Extended_Pictographic}/u;
const DASHES = /[\u2013\u2014]/;
const BACKSTORY = /\b(?:a year ago|years?|finally|bankroll|breathe again|today|tonight|yesterday|last week|this week|months?)\b/i;
// A completed hand establishes actions and results, not private thoughts,
// intentions, remembered experience or another session. Leak tags likewise
// do not evaluate either player's cards or establish relative hand strength.
const UNSUPPORTED_EXPERIENCE = /\b(?:remember\w*|replay\w*|review\w*|stud(?:y|ied|ying)|think(?:ing)?|thought|plan\w*|hope\w*|want\w*|glad|complaints?|felt|feel\w*|unavoidable|linger\w*|stay with you|session|most of (?:the game|a session)|every time|next (?:one|hand)|onward|moving on|back to work|deep breath|going to|i['’]ll|i will|worth a second look|look at that one again)\b/i;
const UNVERIFIED_STRENGTH = /\b(?:second[- ]best|stronger|better hand|strong hand|big hand|bigger (?:one|hand))\b/i;
const FILLER_OPENER = /^(?:look|nah|okay|ok|well|honestly|so|yeah|lol|ngl|fair enough|for me|one thing|the thing is|what gets me|on another watch|the interesting part|the part i keep|the detail worth|i keep coming back)\b/i;

/**
 * A final check of the finished sentence against the facts, so a template
 * that forgets its gate still cannot publish the claim.
 */
export function spokenLineMatches(text: string, facts: HandFacts): boolean {
  if (!text.trim() || text.includes('{') || text.includes('}')) return false;
  if (RAW_CARD_RUN.test(text) || INLINE_BOARD.test(text) || BARE_BIG_BLINDS.test(text)) return false;
  if (ONE_CARD.test(text) || SHORTHAND_HOLDING.test(text)) return false;
  if (/\d/.test(text) || /\bbb\b|big blinds?/i.test(text)) return false;
  if (EMOJI.test(text) || DASHES.test(text)) return false;
  if (BACKSTORY.test(text) || FILLER_OPENER.test(text)) return false;
  if (UNSUPPORTED_EXPERIENCE.test(text) || UNVERIFIED_STRENGTH.test(text)) return false;
  if (/\bended the hand with a fold\b|(?:^|[.!?]\s+)the hand ended when i folded/i.test(text)) return false;

  const t = text.toLowerCase();
  const p = facts.play;
  if (!p) return false;
  if (p.foldStreet && /\bit was decided\b/i.test(text)) return false;

  // The result.
  if (/\b(?:won|collected|took it down|took down|came my way|dragged|picked up|paid off|got paid|came out ahead|went my way|got the result|it held|wrapped that one up)\b/.test(t) && !facts.isWin) return false;
  if (/\b(?:lost|dropped|came up short|wrong side|wrong direction|wrong way|second best|didn't come back|went the other way|came out behind|cost)\b/.test(t) && facts.isWin) return false;

  // The street. River wording only when the river is where it was decided,
  // and never for a board that was run more than once.
  const riverOk = p.decisiveStreet === 'river' && p.runouts === 1;
  if (/\b(?:river|last card)\b/.test(t) && !riverOk) return false;
  if (/\bpreflop\b/.test(t) && p.decisiveStreet !== 'preflop') return false;
  if (/\bon the flop\b/.test(t) && p.decisiveStreet !== 'flop') return false;
  if (/\bon the turn\b/.test(t) && p.decisiveStreet !== 'turn') return false;
  // A pot that went to showdown was not won or lost on the street the money
  // went in: it was settled after the board was dealt out.
  if (p.showdown && /\b(?:won|dropped|took down|wrapped that one up)\b[^.]*\b(?:preflop|on the flop|on the turn)\b/.test(t)) return false;
  if (p.showdown && /\bdecided (?:preflop|on the flop|on the turn)\b/.test(t)) return false;
  if (/\b(?:board|runout)\b/.test(t) && p.runouts > 1) return false;
  if (/\brunout\b/.test(t) && !(p.allInStreet && p.allInStreet !== 'river' && p.showdown)) return false;
  if (/\bran it twice\b/.test(t) && p.runouts !== 2) return false;
  if (/\bran it three times\b/.test(t) && p.runouts !== 3) return false;

  // Showdown.
  if (/\b(?:held up|it held|got home)\b/.test(t) && !(facts.isWin && p.showdown)) return false;
  // Nothing is left to "hold" through when the money went in on the river.
  if (/\bit held\b/.test(t) && p.allInStreet === 'river') return false;
  if (/\b(?:at showdown|showed down|went to showdown|got paid|showed up)\b/.test(t) && !p.showdown) return false;
  if (/\b(?:without a showdown|never had to show|got the fold|nobody wanted it)\b/.test(t) && !(facts.isWin && !p.showdown)) return false;

  // The stack.
  if (/\b(?:full stack|full-stack|whole stack|every chip|committed the stack|shoved)\b/.test(t) && !p.stackInStreet) return false;
  if (/\bshoved\b/.test(t) && !(p.stackInStreet && p.aggressionStreets.includes(p.stackInStreet))) return false;
  // A street named next to the stack is the street the stack went in.
  if (/\b(?:whole stack|committed the stack|shoved)\b[^.]*\b(?:preflop|on the flop|on the turn|on the river)\b/.test(t) && p.stackInStreet !== p.decisiveStreet) return false;
  if (/\b(?:all in|went in)\b/.test(t) && !p.allInStreet) return false;
  if (/\bgot it all in\b/.test(t) && !(p.allInStreet && p.showdown)) return false;

  // The player's own fold (a fold it GOT is the other side's).
  const ownWords = t.replace(/got the fold|nobody wanted it/g, '');
  if (/\b(?:fold|folded|muck|let it go|let go|passed on it)\b/.test(ownWords) && !p.foldStreet) return false;

  // River aggression.
  if (/\b(?:pressure|pressed|on the gas|slow down|fired|one more bet|last bet|made the river expensive|bet the river)\b/.test(t) && !p.riverAggression) return false;
  if (/\b(?:through the river|on the gas through)\b/.test(t) && !p.aggressionStreets.some((s) => s === 'flop' || s === 'turn')) return false;

  // Size.
  if (/\b(?:small|quiet|ordinary|routine|unglamorous|no drama|nothing dramatic)\b/.test(t) && Math.abs(facts.netBb) >= 40) return false;
  // A small net result does not establish a small pot (split/side pots).
  if (/\b(?:small pot|quiet|ordinary|routine|unglamorous|no drama|nothing dramatic)\b/.test(t)
    && (!Number.isFinite(facts.potBb) || facts.potBb <= 0 || facts.potBb >= 40)) return false;
  // A hand its own stack went into was not quiet, whatever it won.
  if (/\b(?:quiet|no drama|nothing dramatic)\b/.test(t) && p.stackInStreet) return false;
  if (/\ba small pot\b/.test(t) && facts.category !== 'grind') return false;
  if (/\bbig pot\b/.test(t) && Math.abs(facts.netBb) < 40) return false;
  return true;
}

const OWN_ACTION_WORDS = {check:'checked',call:'called',bet:'bet',raise:'raised',fold:'folded',all_in:'went all in'} as const;
const ACTION_STREETS = ['preflop','flop','turn','river'] as const;

/**
 * A canonical literal own-decision story, not a result template with cards
 * swapped in. Identical own actions MUST produce identical caption bytes:
 * the existing atomic programme phrase reservation then owns focus reuse.
 * No author wording, outcome, holding, board, amount or source ID can make
 * the same action story appear fresh. An unusable full projection is silence.
 */
function canonicalOwnActionNarrative(f: HandFacts): string|null {
  const actions=f?.play?.ownActions;
  if(!Array.isArray(actions)||actions.length<2||actions.length>8)return null;
  const groups:Array<{street:typeof ACTION_STREETS[number];verbs:string[]}>=[];
  let previous=-1,ended=false;
  for(const step of actions){
    if(!step||typeof step!=='object'||!Object.hasOwn(OWN_ACTION_WORDS,step.action))return null;
    const index=ACTION_STREETS.indexOf(step.street);
    if(index<0||index<previous||ended)return null;
    previous=index;
    let group=groups.at(-1);
    if(!group||group.street!==step.street){group={street:step.street,verbs:[]};groups.push(group);}
    const word=OWN_ACTION_WORDS[step.action];
    group.verbs.push(group.verbs.some(verb=>verb===word||verb===`${word} again`)?`${word} again`:word);
    ended=step.action==='fold'||step.action==='all_in';
  }
  if(groups.length<2)return null;
  const clauses=groups.map(({street,verbs})=>{
    if(verbs.length===1){
      const verb=verbs[0]!;
      return street==='preflop'?`${verb} preflop`
        :verb==='checked'||verb==='bet'?`${verb} the ${street}`:`${verb} on the ${street}`;
    }
    const ordered=verbs.length===2?verbs.join(' and then '):`${verbs.slice(0,-1).join(', ')} and then ${verbs.at(-1)}`;
    return `${ordered}${street==='preflop'?' preflop':` on the ${street}`}`;
  });
  return `I ${clauses.length===2?clauses.join(' and '):`${clauses.slice(0,-1).join(', ')} and ${clauses.at(-1)}`}.`;
}

/** New narrative validation is exact; historical result guards stay intact. */
export function ownActionLineMatches(text:string,f:HandFacts):boolean {
  const canonical=canonicalOwnActionNarrative(f);
  return canonical!==null&&text===canonical;
}

/**
 * Production hand voice. Existing category frame IDs remain exact three-hour
 * reservations, with their existing source predicates. The index is only a
 * reservation slot, never an extra fact or a way to vary this canonical text.
 * Legacy lineFor below remains available solely for historical reconstruction.
 */
export function ownActionLineFor(f:HandFacts,seed:string,exclude?:ReadonlySet<string>):{text:string;key:string}|null {
  const text=canonicalOwnActionNarrative(f),pool=LINES[f?.category];
  if(!text||!pool||!f.play)return null;
  const start=fleetHash(seed,'voice');
  for(let i=0;i<pool.length;i++){
    const idx=(start+i)%pool.length,line=pool[idx]!;
    if(line.when&&!line.when(f))continue;
    const key=`frame:voice:${f.category}:${idx}`;
    if(exclude?.has(key))continue;
    return {text,key};
  }
  return null;
}

/**
 * One line about this hand, or null when nothing can be said without printing
 * a row or claiming something the action log does not show. Returning null is
 * a real answer: a horse with nothing true to say should say nothing.
 */
export function lineFor(f: HandFacts, seed: string, exclude?: ReadonlySet<string>): { text: string; key: string } | null {
  if (!f.play) return null;
  const spoken = speak(f);
  const pool = LINES[f.category] ?? LINES.grind!;
  const start = fleetHash(seed, 'voice');
  const excluded=exclude?equivalentVoiceFrameKeys(exclude):undefined;
  for (let i = 0; i < pool.length; i++) {
    const idx = (start + i) % pool.length;
    const line = pool[idx]!;
    if (line.needs.some((part) => !spoken[part])) continue;
    if (line.when && !line.when(f)) continue;

    let text = line.t;
    for (const part of ['holding', 'board', 'money', 'street', 'runs'] as const) {
      text = text.replace(new RegExp(`\\{${part}\\}`, 'g'), spoken[part] ?? '');
    }
    if (text.includes('{')) continue;
    // Generic reactions caused the production exact-text clusters. Preserve
    // their useful voice variety, but make a source-backed poker fact audible
    // instead of relying on hidden metadata to call the sentence grounded.
    if (line.needs.length === 0) {
      if (spoken.holding) text += ` The hand was ${spoken.holding}.`;
      else if (spoken.street && /\b(?:preflop|flop|turn|river|last card)\b/i.test(text)) { /* The base already states the source street. */ }
      else if (spoken.board && !/\b(?:board|runout)\b/i.test(text)) text += ` The board was ${spoken.board}.`;
      else if (spoken.street && f.play.allInStreet && !/\b(?:all in|went in)\b/i.test(text)) text += ` There was an all-in ${spoken.street}.`;
      else if (spoken.runs) text += ` We ran it ${spoken.runs}.`;
      // A showdown already establishes the terminal outcome. Appending
      // "It was decided on the river" supplied a shared tail, not a distinct
      // action or insight. No unsupported substitute and no money synonym
      // rescue: without a usable holding/board/action, refuse this frame.
      else continue;
    }
    // A replacement can begin a new sentence inside the frame: for example,
    // "No half measures in that one. {money}." The spoken money phrase is a
    // noun phrase and deliberately lowercase everywhere else, so capitalise
    // only real sentence starts after interpolation.
    text = text.replace(/(^|[.!?]\s+)([a-z])/g, (_match, lead: string, letter: string) =>
      `${lead}${letter.toUpperCase()}`,
    );
    const key = `frame:voice:${f.category}:${idx}`;
    if (excluded?.has(key)) continue;
    if (!spokenLineMatches(text, f)) continue;
    return { text, key };
  }
  // Repeating an exhausted frame is not a fallback. Silence is better than
  // making two players sound like the same account in the same window.
  return null;
}

/**
 * The brief recorded for a spoken hand post, for post_briefs and commenters.
 *
 * Deliberately carries no notation and no big blinds: a commenter builds its
 * sentence from the brief, and the old brief ("AKo on Kc 7s Js 4c 2s", "40bb")
 * would have put the rejected voice straight back into the replies.
 */
export function briefForSpokenHand(f: HandFacts): PostBrief {
  return {
    kind: 'hand',
    domain: 'poker',
    title: 'a hand from the tables',
    source: 'club arena',
    people: [],
    teams: [],
    concepts: [f.category, ...f.leaks.slice(0, 2)],
    amounts: [],
    keyPhrase: undefined,
    topic: undefined,
    tone: f.isWin ? 'admiring' : 'analytical',
    isQuestion: false,
    confidence: 1,
    builtFrom: ['horse_hand_reviews'],
  };
}
