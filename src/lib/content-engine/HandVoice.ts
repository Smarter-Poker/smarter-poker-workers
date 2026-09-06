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
 * 2. NEVER print the board. A player says "when the flush came in" or "on a
 *    board that paired", not "6c 7c 9c 9h 3s". The board's SHAPE is the story;
 *    its five specific cards are not.
 * 3. NEVER print big blinds. "184bb" means nothing to a reader mid-scroll.
 *    Money is felt in comparisons: a good pot, most of a stack, the biggest
 *    one of the night.
 * 4. A post is allowed to say LESS than the row knows. Most of what makes a
 *    hand worth telling is one detail and a feeling, not a full accounting.
 *
 * The result is a post that could not be reconstructed into the original hand,
 * and that is correct: a person telling you about a hand does not give you
 * enough to replay it either.
 */
import type { HandFacts } from './HandStory.js';
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
 * "AA" -> "aces". "AKs" -> "ace-king suited". "72o" -> "seven-deuce".
 * A four-card holding is not spelled out at all - "a big Omaha hand" is what
 * a player says, because reciting four cards is what a chip counter does.
 */
export function sayHolding(notation: string, variant: string): string | null {
  const n = (notation ?? '').trim();
  if (!n) return null;
  if (variant && variant.toLowerCase().startsWith('plo')) return null;
  if (n.length > 4) return null;

  const pair = n.match(/^([AKQJT2-9])\1$/);
  if (pair) return RANK_WORDS[pair[1]!] ?? null;

  const two = n.match(/^([AKQJT2-9])([AKQJT2-9])([so])?$/);
  if (!two) return null;
  const a = RANK_ONE[two[1]!];
  const b = RANK_ONE[two[2]!];
  if (!a || !b) return null;
  const suited = two[3] === 's' ? ' suited' : '';
  return `${a}-${b}${suited}`;
}

/**
 * What the BOARD did, in one phrase - never its cards.
 *
 * A hand is remembered by the thing the board did to it: it paired, a flush
 * came in, it bricked out. Reading the texture from the five cards is the
 * whole difference between telling a story and reading out a row.
 */
export function sayBoard(f: HandFacts): string | null {
  const cards = f.board ?? [];
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
  if (flushy && paired) return 'a wet paired board';
  if (flushy) return 'a board the flush got there on';
  if (paired) return 'a paired board';
  if (connected) return 'a connected board';
  if (high) return 'a big card board';
  return 'a dry board';
}

/**
 * The money, FELT rather than counted.
 *
 * `netBb` is exact and useless to a reader. What a player conveys is scale:
 * a nice pot, most of a stack, the one that decided the session.
 */
export function sayMoney(f: HandFacts): string | null {
  const n = Math.abs(f.netBb ?? 0);
  if (!n) return null;
  // NOUN PHRASES, always. These land in slots like "that was {money}", and a
  // phrase written as a clause ("the biggest pot I have won in a while")
  // produced "lost the worst one I have lost in a while with the best hand" -
  // a sentence with two pasts in it and no shape.
  if (n >= 200) return f.isWin ? 'the biggest pot of my night' : 'about as bad as it gets';
  if (n >= 100) return f.isWin ? 'most of a stack' : 'a whole stack';
  if (n >= 40) return f.isWin ? 'a good pot' : 'a real chunk';
  return f.isWin ? 'a small one' : 'not much, but it stung';
}

/** Where the hand ended, said as a player says it. */
export function sayStreet(f: HandFacts): string | null {
  switch (f.street) {
    case 'preflop': return 'before a flop';
    case 'flop': return 'on the flop';
    case 'turn': return 'on the turn';
    case 'river': return 'on the river';
    default: return null;
  }
}

export interface SpokenHand {
  holding: string | null;
  board: string | null;
  money: string | null;
  street: string | null;
}

export function speak(f: HandFacts): SpokenHand {
  return {
    holding: sayHolding(f.holeNotation, f.variant),
    board: sayBoard(f),
    money: sayMoney(f),
    street: sayStreet(f),
  };
}

/**
 * The sentences. Each one is a thing a player might actually say, and each
 * names at most a couple of the parts - a post that uses every field reads
 * like a form.
 *
 * `needs` lists the parts a line cannot do without, so a hand missing one is
 * never given a sentence with a hole in it.
 */
interface Line {
  t: string;
  needs: Array<keyof SpokenHand>;
}

const LINES: Record<string, Line[]> = {
  big_win: [
    { t: 'got there with {holding} and it held. {money}', needs: ['holding', 'money'] },
    { t: '{holding} on {board}. do not get those every night', needs: ['holding', 'board'] },
    { t: 'finally won one. {holding}, all the way', needs: ['holding'] },
    { t: '{holding} held up {street}. taking that one home', needs: ['holding', 'street'] },
    { t: 'nothing clever, just {holding} and someone who did not believe me', needs: ['holding'] },
    { t: 'that was {money}, and I did not have to do anything smart', needs: ['money'] },
    { t: 'won {money} with {holding}. I will take it', needs: ['money', 'holding'] },
  ],
  bad_beat: [
    { t: 'had {holding} and lost it {street}. that is poker apparently', needs: ['holding', 'street'] },
    { t: '{holding} into {board}. no way to fold, no way to win', needs: ['holding', 'board'] },
    { t: 'ahead the whole way with {holding} until the last card', needs: ['holding'] },
    { t: 'had the best hand and lost {money}. still thinking about it', needs: ['money'] },
    { t: '{holding} on {board} and it still found a way to lose', needs: ['holding', 'board'] },
    { t: 'do that a hundred times and I win most of them. not tonight', needs: [] },
    { t: 'lost {money} there and I would play it exactly the same', needs: ['money'] },
  ],
  cooler: [
    { t: '{holding} into the one hand that beats it. nothing to learn there', needs: ['holding'] },
    { t: 'both of us were getting it in on {board}. mine was second best', needs: ['board'] },
    { t: 'you can play {holding} perfectly and still lose the stack', needs: ['holding'] },
    { t: 'that was the deck, not me. {money} either way', needs: ['money'] },
    { t: 'no fold exists there and anyone who says otherwise is lying', needs: [] },
    { t: 'set up from the flop. {holding}, second best the whole time', needs: ['holding'] },
  ],
  river_aggression: [
    { t: 'fired the last one with nothing and got the fold. {money}', needs: ['money'] },
    { t: 'told the story all the way to the end on {board}. they believed it', needs: ['board'] },
    { t: 'no hand at all. sometimes the bet is the hand', needs: [] },
    { t: 'took it {street} without the best of it', needs: ['street'] },
    { t: 'you either fire that one or you spend all night wondering', needs: [] },
    { t: 'won {money} with the worst hand at the table', needs: ['money'] },
  ],
  big_fold: [
    { t: 'folded {holding} and I am still sure it was right', needs: ['holding'] },
    { t: 'let it go on {board}. nobody makes a clip about a fold', needs: ['board'] },
    { t: 'a year ago that is a call. saved {money}', needs: ['money'] },
    { t: 'the fold nobody claps for. {holding} in the muck', needs: ['holding'] },
    { t: 'passed on it and slept fine', needs: [] },
    { t: 'folding {holding} there saved more than most pots I win', needs: ['holding'] },
  ],
  stackoff: [
    { t: 'whole stack in with {holding}. neither of us was folding', needs: ['holding'] },
    { t: 'once {board} landed the rest was arithmetic', needs: ['board'] },
    { t: 'stacks in {street}. that is {money}', needs: ['street', 'money'] },
    { t: 'no way to play {holding} for less than everything', needs: ['holding'] },
    { t: 'all of it in on {board} and I was not folding either', needs: ['board'] },
  ],
  grind: [
    { t: 'quiet one with {holding}. most of the game looks like that', needs: ['holding'] },
    { t: 'small pot, clean line, next hand', needs: [] },
    { t: 'took it {street}. nothing to write home about', needs: ['street'] },
    { t: 'these are the ones that actually pay. {money}', needs: ['money'] },
    { t: 'nobody wanted to fight for that one', needs: [] },
    { t: '{holding}, no drama, moving on', needs: ['holding'] },
  ],
};

/**
 * One line about this hand, or null when nothing can be said without printing
 * a row. Returning null is a real answer: a horse with nothing to say should
 * say nothing.
 */
export function lineFor(f: HandFacts, seed: string, exclude?: ReadonlySet<string>): { text: string; key: string } | null {
  const spoken = speak(f);
  const pool = LINES[f.category] ?? LINES.grind!;
  const start = fleetHash(seed, 'voice');
  let fallback: { text: string; key: string } | null = null;

  for (let i = 0; i < pool.length; i++) {
    const idx = (start + i) % pool.length;
    const line = pool[idx]!;
    if (line.needs.some((part) => !spoken[part])) continue;

    let text = line.t;
    for (const part of ['holding', 'board', 'money', 'street'] as const) {
      text = text.replace(new RegExp(`\\{${part}\\}`, 'g'), spoken[part] ?? '');
    }
    if (text.includes('{')) continue;
    const key = `frame:voice:${f.category}:${idx}`;
    if (!fallback) fallback = { text, key };
    if (!exclude?.has(key)) return { text, key };
  }
  return fallback;
}
