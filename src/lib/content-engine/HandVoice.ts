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
 * "AA" -> "pocket aces". "AKs" -> "ace-king suited". "72o" ->
 * "seven-deuce offsuit".
 * A four-card holding is not spelled out at all - "a big Omaha hand" is what
 * a player says, because reciting four cards is what a chip counter does.
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
 * `netBb` is exact and useless to a reader. What a player conveys is scale:
 * a nice pot, most of a stack, the one that decided the session.
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
  /** A claim that requires more than the presence of a spoken field. */
  when?: (facts: HandFacts) => boolean;
}

const LINES: Record<string, Line[]> = {
  big_win: [
    { t: 'Won {money} with {holding}. I will take that every time.', needs: ['money', 'holding'] },
    { t: '{holding} held up on {board}. Nice when the simple plan works.', needs: ['holding', 'board'] },
    { t: 'Finally dragged a real one with {holding}.', needs: ['holding'] },
    { t: '{holding} got through {street}. That one felt good.', needs: ['holding', 'street'] },
    { t: 'Nothing fancy: {holding}, a clean result, and {money}.', needs: ['holding', 'money'] },
    { t: 'That was {money}. The bankroll can breathe again.', needs: ['money'] },
    { t: '{money} with {holding}. No complaints from this seat.', needs: ['money', 'holding'] },
    { t: '{board} made it interesting, but {holding} got home.', needs: ['board', 'holding'] },
    { t: 'One of those pots where {holding} does exactly what you hoped.', needs: ['holding'] },
    { t: 'Good start, good finish. {holding} for {money}.', needs: ['holding', 'money'] },
    { t: '{holding}, {money}, and no need to overthink it.', needs: ['holding', 'money'] },
    { t: '{board} never made this comfortable. Won it anyway.', needs: ['board'] },
  ],
  bad_beat: [
    { t: 'Dropped {money} with {holding}. Closing the hand history for a minute.', needs: ['money', 'holding'] },
    { t: '{holding} on {board}. That one is going to linger.', needs: ['holding', 'board'] },
    { t: 'The hand ended {street}. I did not enjoy the ending.', needs: ['street'] },
    { t: '{money}. No speech, just the next hand.', needs: ['money'] },
    { t: '{board} did not cooperate with {holding}.', needs: ['board', 'holding'] },
    { t: 'Some pots stay with you longer than they should. That was one.', needs: [] },
    { t: '{holding} looked a lot better before the last card.', needs: ['holding'], when: (f) => f.street === 'river' },
    { t: '{board}, {holding}, and the kind of result you walk off.', needs: ['board', 'holding'] },
    { t: 'That was {money}. Give me a lap before the next deal.', needs: ['money'] },
    { t: 'Still replaying the decision with {holding}.', needs: ['holding'] },
    { t: 'The river was not kind. That is all I have for this one.', needs: [], when: (f) => f.street === 'river' },
    { t: 'Tough one with {holding}. Back to work.', needs: ['holding'] },
  ],
  cooler: [
    { t: '{holding} on {board}. Sometimes the second-best hand costs the most.', needs: ['holding', 'board'] },
    { t: 'That felt unavoidable. It still cost {money}.', needs: ['money'] },
    { t: 'A strong hand, a stronger one somewhere else, and a long walk back.', needs: [] },
    { t: '{holding} was not enough on {board}. Nothing pretty about that.', needs: ['holding', 'board'] },
    { t: 'One of those spots that looks obvious only after it is over.', needs: [] },
    { t: '{money} in the wrong direction. Coolers do not ask permission.', needs: ['money'] },
    { t: '{board} turned a good hand into an expensive one.', needs: ['board'] },
    { t: '{holding}, second best, next hand.', needs: ['holding'] },
    { t: 'There are losses you study and losses you absorb. This felt like the second kind.', needs: [] },
    { t: '{board} and a hand that was too strong to feel cheap.', needs: ['board'] },
    { t: 'That was {money}. The cards had their own plan.', needs: ['money'] },
    { t: '{holding} ran into trouble. It happens fast in this game.', needs: ['holding'] },
  ],
  river_aggression: [
    { t: 'Kept the pressure on through the river and took it down.', needs: [], when: (f) => f.street === 'river' },
    { t: 'The last bet told the story. This time it worked.', needs: [], when: (f) => f.street === 'river' },
    { t: '{board}. One more bet, and the pot came my way.', needs: ['board'], when: (f) => f.street === 'river' },
    { t: 'River decisions are rarely comfortable. I pressed this one.', needs: [], when: (f) => f.street === 'river' },
    { t: 'Took the aggressive route on the river and won {money}.', needs: ['money'], when: (f) => f.street === 'river' && f.isWin },
    { t: 'The river gave me a decision. I chose pressure.', needs: [], when: (f) => f.street === 'river' },
    { t: 'Stayed on the gas through {board}. Got the result.', needs: ['board'], when: (f) => f.street === 'river' },
    { t: 'One last bet was enough, with {money} coming back.', needs: ['money'], when: (f) => f.street === 'river' },
    { t: 'The hand reached the river and I did not slow down.', needs: [], when: (f) => f.street === 'river' },
    { t: 'Put the river decision on the other side of the table.', needs: [], when: (f) => f.street === 'river' },
    { t: 'Made the river expensive and collected {money}.', needs: ['money'], when: (f) => f.street === 'river' },
    { t: 'Pressure was the plan on the last card. The plan held.', needs: [], when: (f) => f.street === 'river' },
  ],
  big_fold: [
    { t: 'Folded {holding}. The disciplined hands never make the highlight reel.', needs: ['holding'] },
    { t: 'Let it go on {board}. Quiet decisions still count.', needs: ['board'] },
    { t: 'A year ago I probably call there. Progress can look boring.', needs: [] },
    { t: 'The fold nobody claps for. {holding} in the muck.', needs: ['holding'] },
    { t: 'Passed on it and moved to the next hand.', needs: [] },
    { t: '{holding} was hard to release. Hard is not the same as wrong.', needs: ['holding'] },
    { t: 'Found the fold on {board}. That took longer than I want to admit.', needs: ['board'] },
    { t: 'Sometimes the best chip is the one you do not put in.', needs: [] },
    { t: 'The river asked an expensive question. I folded.', needs: [], when: (f) => f.street === 'river' },
    { t: '{holding} went into the muck. Onward.', needs: ['holding'] },
    { t: 'No trophy for that fold, but I will remember it.', needs: [] },
    { t: '{board} and enough warning signs. I listened.', needs: ['board'] },
  ],
  stackoff: [
    { t: 'Everything went in with {holding}. This time it held.', needs: ['holding'], when: (f) => f.isWin },
    { t: 'Everything went in with {holding}. This time it did not hold.', needs: ['holding'], when: (f) => !f.isWin },
    { t: 'The chips went in on {board}. Won {money}.', needs: ['board', 'money'], when: (f) => f.isWin },
    { t: 'The chips went in on {board}. Lost {money}.', needs: ['board', 'money'], when: (f) => !f.isWin },
    { t: 'Committed the stack {street}. There was no quiet ending after that.', needs: ['street'] },
    { t: '{holding}, the full stack, and a result I will take.', needs: ['holding'], when: (f) => f.isWin },
    { t: '{holding}, the full stack, and a result I could do without.', needs: ['holding'], when: (f) => !f.isWin },
    { t: 'Once the stack went in, all that was left was the runout.', needs: [] },
    { t: '{board} and every chip in play. Poker gets simple fast.', needs: ['board'] },
    { t: 'Full-stack pot with {holding}. Deep breath.', needs: ['holding'] },
    { t: 'No half measures in that one. {money} changed hands.', needs: ['money'] },
    { t: 'The whole stack found the middle. On to the next decision.', needs: [] },
  ],
  grind: [
    { t: 'Quiet one with {holding}. Most of the game looks like that.', needs: ['holding'] },
    { t: 'Small pot, clean decision, next hand.', needs: [] },
    { t: 'Wrapped that one up {street}. Nothing dramatic.', needs: ['street'] },
    { t: 'This is what most of a session looks like.', needs: [] },
    { t: '{holding}, no drama, moving on.', needs: ['holding'] },
    { t: '{board} and a routine result. They count too.', needs: ['board'] },
    { t: 'Not every hand needs a speech. This one did its job.', needs: [], when: (f) => f.isWin },
    { t: 'Lost a small one and kept the session moving.', needs: [], when: (f) => !f.isWin && Math.abs(f.netBb) < 40 },
    { t: 'Won a small one and kept the session moving.', needs: [], when: (f) => f.isWin && Math.abs(f.netBb) < 40 },
    { t: '{holding} on {board}. File it under ordinary poker.', needs: ['holding', 'board'] },
    { t: 'One more decision made, one more hand in the books.', needs: [] },
    { t: 'The unglamorous part of the grind still matters.', needs: [] },
  ],
};

const RAW_CARD_RUN = /[AKQJT2-9][hcds][AKQJT2-9][hcds][AKQJT2-9][hcds]/i;
const INLINE_BOARD = /([AKQJT2-9][hcds]\s+){4}[AKQJT2-9][hcds]/i;
const BARE_BIG_BLINDS = /\b\d+(?:\.\d+)?bb\b/i;

/** A final defensive check for claims the spoken form is not allowed to make. */
export function spokenLineMatches(text: string, facts: HandFacts): boolean {
  if (!text.trim() || text.includes('{') || text.includes('}')) return false;
  if (RAW_CARD_RUN.test(text) || INLINE_BOARD.test(text) || BARE_BIG_BLINDS.test(text)) return false;
  if (text.includes('—')) return false;
  if (/\briver\b/i.test(text) && facts.street !== 'river') return false;
  if (/\bwon\b|\bcollected\b/i.test(text) && !facts.isWin) return false;
  if (/\blost\b/i.test(text) && facts.isWin) return false;
  return true;
}

/**
 * One line about this hand, or null when nothing can be said without printing
 * a row. Returning null is a real answer: a horse with nothing to say should
 * say nothing.
 */
export function lineFor(f: HandFacts, seed: string, exclude?: ReadonlySet<string>): { text: string; key: string } | null {
  const spoken = speak(f);
  const pool = LINES[f.category] ?? LINES.grind!;
  const start = fleetHash(seed, 'voice');
  for (let i = 0; i < pool.length; i++) {
    const idx = (start + i) % pool.length;
    const line = pool[idx]!;
    if (line.needs.some((part) => !spoken[part])) continue;
    if (line.when && !line.when(f)) continue;

    let text = line.t;
    for (const part of ['holding', 'board', 'money', 'street'] as const) {
      text = text.replace(new RegExp(`\\{${part}\\}`, 'g'), spoken[part] ?? '');
    }
    if (text.includes('{')) continue;
    // A replacement can begin a new sentence inside the frame: for example,
    // "No half measures in that one. {money}." The spoken money phrase is a
    // noun phrase and deliberately lowercase everywhere else, so capitalise
    // only real sentence starts after interpolation.
    text = text.replace(/(^|[.!?]\s+)([a-z])/g, (_match, lead: string, letter: string) =>
      `${lead}${letter.toUpperCase()}`,
    );
    const key = `frame:voice:${f.category}:${idx}`;
    if (exclude?.has(key)) continue;
    if (!spokenLineMatches(text, f)) continue;
    return { text, key };
  }
  // Repeating an exhausted frame is not a fallback. Silence is better than
  // making two players sound like the same account in the same window.
  return null;
}
