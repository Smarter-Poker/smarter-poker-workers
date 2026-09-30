/**
 * PokerEvaluator: pure no-limit hold'em hand evaluation and "what is the nuts"
 * enumeration for the Phase 7 puzzles.
 *
 * WHY THIS EXISTS: the workers repo had no hand evaluator (Phase 7 research,
 * design section 3.2), and a puzzle whose answer is graded by a model or a
 * guess is a puzzle a player can catch. Everything here is arithmetic over
 * the cards: a five-card evaluator with a total order, the best five of
 * seven, and an enumeration of every one of the C(47,2) = 1,081 two-card
 * holdings against a river board, grouped into hand classes and labelled in
 * player words from a fixed table.
 *
 * NO SUPABASE, NO NETWORK, NO RANDOMNESS. Same board in, same classes and
 * labels out, forever; `EVALUATOR_VERSION` is stored with every proof so a
 * change here is visible in the ledger.
 *
 * The verified sample this replaces (research out/nuts-sample.mjs) agreed
 * with the three boards pinned in PokerEvaluator.test.ts; this module adds
 * the rank-pair normalisation ("98" and "89" are one class), letter suits,
 * and the label table.
 */

export const EVALUATOR_VERSION = 'p7-nlh-1';

export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';
export type Suit = 'c' | 'd' | 'h' | 's';
export type Card = { rank: Rank; suit: Suit };

export type HandCategory =
  | 'high_card'
  | 'pair'
  | 'two_pair'
  | 'trips'
  | 'straight'
  | 'flush'
  | 'full_house'
  | 'quads'
  | 'straight_flush';

export const RANKS: readonly Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const SUITS: readonly Suit[] = ['c', 'd', 'h', 's'];

const CATEGORIES: readonly HandCategory[] = [
  'high_card',
  'pair',
  'two_pair',
  'trips',
  'straight',
  'flush',
  'full_house',
  'quads',
  'straight_flush',
];

const RANK_INDEX: Record<Rank, number> = {
  '2': 0, '3': 1, '4': 2, '5': 3, '6': 4, '7': 5, '8': 6, '9': 7, 'T': 8, 'J': 9, 'Q': 10, 'K': 11, 'A': 12,
};

/** horse_hand_reviews stores suits as words; social_puzzles.board stores letters. Both read. */
const SUIT_FROM_ROW: Record<string, Suit> = {
  clubs: 'c', diamonds: 'd', hearts: 'h', spades: 's', c: 'c', d: 'd', h: 'h', s: 's',
};

/** Score space: category * 13^5 + five base-13 rank digits. Total order, equal hands equal. */
const CATEGORY_WEIGHT = 13 ** 5;

/* ------------------------------------------------------------------------ */
/* Cards                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * A card from a `horse_hand_reviews` row (`{"rank":"K","suit":"clubs"}`) or
 * from a stored board (`{"rank":"K","suit":"c"}`). Null for anything else:
 * an unreadable card is never guessed at.
 */
export function cardFromRow(c: unknown): Card | null {
  if (!c || typeof c !== 'object') return null;
  const rank = (c as { rank?: unknown }).rank;
  const suit = (c as { suit?: unknown }).suit;
  if (typeof rank !== 'string' || typeof suit !== 'string') return null;
  if (!(RANKS as readonly string[]).includes(rank)) return null;
  const s = SUIT_FROM_ROW[suit.toLowerCase()];
  if (!s) return null;
  return { rank: rank as Rank, suit: s };
}

/** Every card of a row array, or null when any entry is unreadable or repeated. */
export function cardsFromRow(v: unknown): Card[] | null {
  if (!Array.isArray(v)) return null;
  const out: Card[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    const c = cardFromRow(raw);
    if (!c) return null;
    const key = cardKey(c);
    if (seen.has(key)) return null;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** '2h', 'As': the two-character notation players write. */
export function cardKey(c: Card): string {
  return `${c.rank}${c.suit}`;
}

/** The Phase 5 feed token the World Hub PokerCardText renderer draws as Club Arena artwork. */
export function cardToken(c: Card): string {
  return `[[sp-card:${c.rank}${c.suit}]]`;
}

/** "Hand [[sp-card:Kc]][[sp-card:7d]]" or "Board [[sp-card:2c]]...": the pokerCardMarkup.js formatPokerCards shape. */
export function cardsLine(label: 'Hand' | 'Board', cards: Card[]): string {
  return `${label} ${cards.map(cardToken).join('')}`;
}

/* ------------------------------------------------------------------------ */
/* Evaluation                                                                */
/* ------------------------------------------------------------------------ */

export interface HandValue {
  category: HandCategory;
  /** Total order: a higher score is a better hand, equal hands have equal scores. */
  score: number;
}

function pack(ranks: number[]): number {
  let s = 0;
  for (let i = 0; i < 5; i++) s = s * 13 + (ranks[i] ?? 0);
  return s;
}

/**
 * The five ranks a score was packed from, most significant first: for a
 * straight only the high card is set (the rest are zero), for everything
 * else the ranks in the order that decides the hand (pair first, then
 * kickers; trips then pair for a full house; and so on).
 */
export function rankDigits(score: number): number[] {
  let rest = score % CATEGORY_WEIGHT;
  const digits: number[] = [];
  for (let i = 0; i < 5; i++) {
    digits.unshift(rest % 13);
    rest = Math.floor(rest / 13);
  }
  return digits;
}

export function categoryOf(score: number): HandCategory {
  return CATEGORIES[Math.floor(score / CATEGORY_WEIGHT)] ?? 'high_card';
}

/** Exactly five cards to one hand value. */
export function evaluate5(cards: Card[]): HandValue {
  if (cards.length !== 5) throw new Error(`evaluate5 needs exactly five cards, got ${cards.length}`);
  const ranks = cards.map((c) => RANK_INDEX[c.rank]).sort((a, b) => b - a);
  const first = cards[0]!;
  const flush = cards.every((c) => c.suit === first.suit);

  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  // Groups by size, then by rank: [[rank, count], ...]
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  let straightHigh = -1;
  if (groups.length === 5) {
    if (ranks[0]! - ranks[4]! === 4) straightHigh = ranks[0]!;
    else if (ranks[0] === 12 && ranks[1] === 3 && ranks[2] === 2 && ranks[3] === 1 && ranks[4] === 0) straightHigh = 3; // the wheel
  }

  const ordered: number[] = [];
  for (const [rank, count] of groups) for (let i = 0; i < count; i++) ordered.push(rank);

  let category: HandCategory;
  let digits: number[];
  const shape = `${groups[0]![1]}${groups[1]?.[1] ?? 0}`;
  if (straightHigh >= 0 && flush) {
    category = 'straight_flush';
    digits = [straightHigh];
  } else if (shape === '41') {
    category = 'quads';
    digits = ordered;
  } else if (shape === '32') {
    category = 'full_house';
    digits = ordered;
  } else if (flush) {
    category = 'flush';
    digits = ranks;
  } else if (straightHigh >= 0) {
    category = 'straight';
    digits = [straightHigh];
  } else if (shape === '31') {
    category = 'trips';
    digits = ordered;
  } else if (shape === '22') {
    category = 'two_pair';
    digits = ordered;
  } else if (shape === '21') {
    category = 'pair';
    digits = ordered;
  } else {
    category = 'high_card';
    digits = ranks;
  }
  return { category, score: CATEGORIES.indexOf(category) * CATEGORY_WEIGHT + pack(digits) };
}

function* choose<T>(items: T[], k: number, start = 0, acc: T[] = []): Generator<T[]> {
  if (acc.length === k) {
    yield acc;
    return;
  }
  for (let i = start; i <= items.length - (k - acc.length); i++) {
    yield* choose(items, k, i + 1, [...acc, items[i]!]);
  }
}

/** The best five-card hand among five to seven cards. */
export function bestOfSeven(cards: Card[]): HandValue {
  if (cards.length < 5 || cards.length > 7) throw new Error(`bestOfSeven needs five to seven cards, got ${cards.length}`);
  if (cards.length === 5) return evaluate5(cards);
  let best: HandValue | null = null;
  for (const five of choose(cards, 5)) {
    const v = evaluate5(five);
    if (!best || v.score > best.score) best = v;
  }
  return best!;
}

/* ------------------------------------------------------------------------ */
/* Label table (fixed; never a model)                                        */
/* ------------------------------------------------------------------------ */

const RANK_WORD: Record<Rank, string> = {
  '2': 'deuce', '3': 'three', '4': 'four', '5': 'five', '6': 'six', '7': 'seven', '8': 'eight',
  '9': 'nine', 'T': 'ten', 'J': 'jack', 'Q': 'queen', 'K': 'king', 'A': 'ace',
};
const RANK_PLURAL: Record<Rank, string> = {
  '2': 'deuces', '3': 'threes', '4': 'fours', '5': 'fives', '6': 'sixes', '7': 'sevens', '8': 'eights',
  '9': 'nines', 'T': 'tens', 'J': 'jacks', 'Q': 'queens', 'K': 'kings', 'A': 'aces',
};
const SUIT_WORD: Record<Suit, string> = { c: 'club', d: 'diamond', h: 'heart', s: 'spade' };
const SUIT_PLURAL: Record<Suit, string> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
const ORDINAL = ['', 'nut', 'second nut', 'third nut', 'fourth nut'];

/** Every fixed word the labels are built from, for the law test. */
export const LABEL_VOCABULARY: readonly string[] = [
  ...Object.values(RANK_WORD),
  ...Object.values(RANK_PLURAL),
  ...Object.values(SUIT_WORD),
  ...Object.values(SUIT_PLURAL),
  'pocket', 'any', 'the', 'of', 'with', 'card', 'cards', 'two', 'suited', 'or', 'for', 'a', 'an',
  'high', 'pair', 'set', 'trip', 'straight', 'flush', 'full', 'quad', 'quads', 'royal', 'kicker',
  'nut', 'second', 'third', 'fourth', 'and', 'anything', 'else',
];

export const rankWord = (r: Rank): string => RANK_WORD[r];
export const rankPlural = (r: Rank): string => RANK_PLURAL[r];

function article(word: string): string {
  return /^[aeiou]/.test(word) ? 'an' : 'a';
}

const rankAt = (i: number): Rank => RANKS[i]!;

/**
 * The hand a class makes, in player words. `flushOrdinal` is the class's
 * rank among the flush classes of its board (1 = the nut flush), and
 * `boardQuads` is set when the four of a kind sits on the board so only the
 * kicker separates the classes.
 */
function handPhrase(category: HandCategory, score: number, ctx: { flushOrdinal: number; kickerMatters: boolean; holdingWords: string }): string {
  const d = rankDigits(score);
  const r0 = rankAt(d[0]!);
  switch (category) {
    case 'high_card':
      return `${rankWord(r0)} high`;
    case 'pair':
      return `a pair of ${rankPlural(r0)}`;
    case 'two_pair':
      return `two pair, ${rankPlural(r0)} and ${rankPlural(rankAt(d[2]!))}`;
    case 'trips':
      return ctx.holdingWords.startsWith('pocket ') ? `a set of ${rankPlural(r0)}` : `trip ${rankPlural(r0)}`;
    case 'straight': {
      const w = rankWord(r0);
      return `${article(w)} ${w} high straight`;
    }
    case 'flush': {
      const ord = ORDINAL[ctx.flushOrdinal];
      if (ord) return `the ${ord} flush`;
      const w = rankWord(r0);
      return `${article(w)} ${w} high flush`;
    }
    case 'full_house':
      return `${rankPlural(r0)} full of ${rankPlural(rankAt(d[3]!))}`;
    case 'quads': {
      const named = ctx.holdingWords.includes(rankWord(r0)) || ctx.holdingWords.includes(rankPlural(r0));
      const base = named ? 'quads' : `quad ${rankPlural(r0)}`;
      const kicker = rankWord(rankAt(d[4]!));
      return ctx.kickerMatters ? `${base} with ${article(kicker)} ${kicker} kicker` : base;
    }
    case 'straight_flush': {
      if (r0 === 'A') return 'a royal flush';
      const w = rankWord(r0);
      return `${article(w)} ${w} high straight flush`;
    }
  }
}

/* ------------------------------------------------------------------------ */
/* The nuts                                                                  */
/* ------------------------------------------------------------------------ */

export interface NutsClass {
  category: HandCategory;
  score: number;
  /**
   * Player words naming exactly the hole cards needed and the hand made:
   * 'pocket deuces, for quads', 'any nine eight, for a nine high straight',
   * 'the queen jack of clubs, for the nut flush'. For a class below the
   * nuts, "any" means every combination of those ranks that is not in a
   * better class.
   */
  label: string;
  /** Two-card holdings as 'AhKc' (higher rank first, suits c d h s), sorted best first. */
  holdings: string[];
  /**
   * False when the holdings did not fit any shape of the label table and
   * the label lists them instead. The composer never publishes an inexact
   * label as the correct answer.
   */
  exactLabel: boolean;
}

interface Holding {
  a: Card;
  b: Card;
  key: string;
}

function holdingOf(x: Card, y: Card): Holding {
  const ix = RANK_INDEX[x.rank];
  const iy = RANK_INDEX[y.rank];
  const xFirst = ix > iy || (ix === iy && SUITS.indexOf(x.suit) < SUITS.indexOf(y.suit));
  const a = xFirst ? x : y;
  const b = xFirst ? y : x;
  return { a, b, key: `${cardKey(a)}${cardKey(b)}` };
}

function compareHoldings(p: Holding, q: Holding): number {
  return (
    RANK_INDEX[q.a.rank] - RANK_INDEX[p.a.rank] ||
    RANK_INDEX[q.b.rank] - RANK_INDEX[p.b.rank] ||
    SUITS.indexOf(p.a.suit) - SUITS.indexOf(q.a.suit) ||
    SUITS.indexOf(p.b.suit) - SUITS.indexOf(q.b.suit)
  );
}

/**
 * The hole cards a class needs, in player words, from the fixed table.
 * `better` holds every holding of a better class, so "any king queen" is
 * read as "every king queen that does not make something better".
 */
function holdingPhrase(members: Holding[], better: Set<string>, universe: Holding[]): { text: string; exact: boolean } {
  const inClass = new Set(members.map((h) => h.key));
  const covers = (candidates: Holding[]): boolean => {
    const candidateKeys = new Set(candidates.map((h) => h.key));
    return candidates.every((h) => inClass.has(h.key) || better.has(h.key)) && members.every((h) => candidateKeys.has(h.key));
  };

  const pairKeys = new Set(members.map((h) => `${h.a.rank}${h.b.rank}`));
  const first = members[0]!;

  if (pairKeys.size === 1) {
    const r1 = first.a.rank;
    const r2 = first.b.rank;
    const sameRanks = universe.filter((h) => h.a.rank === r1 && h.b.rank === r2);
    if (r1 === r2) {
      if (covers(sameRanks)) return { text: `pocket ${rankPlural(r1)}`, exact: true };
      const common = commonCard(members);
      if (common && covers(sameRanks.filter((h) => h.a.suit === common.suit || h.b.suit === common.suit))) {
        return { text: `pocket ${rankPlural(r1)} with the ${rankWord(r1)} of ${SUIT_PLURAL[common.suit]}`, exact: true };
      }
      return listed(members);
    }
    if (covers(sameRanks)) return { text: `any ${rankWord(r1)} ${rankWord(r2)}`, exact: true };
    const suited = members.every((h) => h.a.suit === h.b.suit);
    if (suited) {
      const suits = new Set(members.map((h) => h.a.suit));
      if (suits.size === 1 && covers(sameRanks.filter((h) => h.a.suit === first.a.suit && h.b.suit === first.a.suit))) {
        return { text: `the ${rankWord(r1)} ${rankWord(r2)} of ${SUIT_PLURAL[first.a.suit]}`, exact: true };
      }
      if (covers(sameRanks.filter((h) => h.a.suit === h.b.suit))) return { text: `${rankWord(r1)} ${rankWord(r2)} suited`, exact: true };
    }
    const common = commonCard(members);
    if (common) {
      const other = common.rank === r1 ? r2 : r1;
      const withCommon = sameRanks.filter((h) => holds(h, common));
      if (covers(withCommon)) {
        return { text: `the ${rankWord(common.rank)} of ${SUIT_PLURAL[common.suit]} with any ${rankWord(other)}`, exact: true };
      }
    }
    return listed(members);
  }

  // More than one rank pair: a single rank, a single card, or the whole deck.
  const commonRank = commonRankOf(members);
  if (commonRank) {
    const withRank = universe.filter((h) => h.a.rank === commonRank || h.b.rank === commonRank);
    if (covers(withRank)) return { text: `any ${rankWord(commonRank)}`, exact: true };
  }
  const common = commonCard(members);
  if (common) {
    const withCommon = universe.filter((h) => holds(h, common));
    if (covers(withCommon)) return { text: `the ${rankWord(common.rank)} of ${SUIT_PLURAL[common.suit]} with any card`, exact: true };
    const otherSuits = new Set(members.map((h) => otherCard(h, common).suit));
    if (otherSuits.size === 1) {
      const s = [...otherSuits][0]!;
      if (covers(withCommon.filter((h) => otherCard(h, common).suit === s))) {
        return { text: `the ${rankWord(common.rank)} of ${SUIT_PLURAL[common.suit]} with any ${SUIT_WORD[s]}`, exact: true };
      }
    }
  }
  if (covers(universe)) return { text: 'any two cards', exact: true };
  return listed(members);
}

/** Whether a holding contains a specific card. */
function holds(h: Holding, c: Card): boolean {
  const key = cardKey(c);
  return cardKey(h.a) === key || cardKey(h.b) === key;
}

/** The card of a holding that is not `c`. */
function otherCard(h: Holding, c: Card): Card {
  return cardKey(h.a) === cardKey(c) ? h.b : h.a;
}

function commonCard(members: Holding[]): Card | null {
  const first = members[0]!;
  for (const c of [first.a, first.b]) {
    const key = cardKey(c);
    if (members.every((h) => cardKey(h.a) === key || cardKey(h.b) === key)) return c;
  }
  return null;
}

function commonRankOf(members: Holding[]): Rank | null {
  const first = members[0]!;
  for (const r of [first.a.rank, first.b.rank]) {
    if (members.every((h) => h.a.rank === r || h.b.rank === r)) return r;
  }
  return null;
}

/** The fallback: the holdings themselves, in the notation players write. Exact only when short. */
function listed(members: Holding[]): { text: string; exact: boolean } {
  const keys = members.map((h) => h.key);
  if (keys.length <= 3) {
    const text = keys.length === 1 ? keys[0]! : `${keys.slice(0, -1).join(', ')} or ${keys[keys.length - 1]}`;
    return { text, exact: true };
  }
  return { text: `${keys.slice(0, 3).join(', ')} or ${keys.length - 3} more combos`, exact: false };
}

/**
 * Every two-card holding against a five-card board, grouped by the hand it
 * makes (category and score), best class first, each labelled. The first
 * class is the nuts. Enumerates all C(47,2) = 1,081 holdings.
 */
export function nutsOnBoard(board: Card[]): { enumerated: number; classes: NutsClass[] } {
  if (board.length !== 5) throw new Error(`nutsOnBoard needs a five-card board, got ${board.length}`);
  const seen = new Set(board.map(cardKey));
  if (seen.size !== 5) throw new Error('nutsOnBoard needs five distinct cards');

  const deck: Card[] = [];
  for (const suit of SUITS) for (const rank of RANKS) if (!seen.has(`${rank}${suit}`)) deck.push({ rank, suit });

  const universe: Holding[] = [];
  const byScore = new Map<number, { category: HandCategory; members: Holding[] }>();
  for (let i = 0; i < deck.length; i++) {
    for (let j = i + 1; j < deck.length; j++) {
      const h = holdingOf(deck[i]!, deck[j]!);
      universe.push(h);
      const v = bestOfSeven([...board, h.a, h.b]);
      const group = byScore.get(v.score);
      if (group) group.members.push(h);
      else byScore.set(v.score, { category: v.category, members: [h] });
    }
  }

  // Three or four of a rank on the board: the quads are mostly the board's
  // and only the kicker separates the classes, so the label names it.
  const boardRankCount = new Map<Rank, number>();
  for (const c of board) boardRankCount.set(c.rank, (boardRankCount.get(c.rank) ?? 0) + 1);
  const scores = [...byScore.keys()].sort((a, b) => b - a);
  const better = new Set<string>();
  let flushesSeen = 0;
  const classes: NutsClass[] = [];
  for (const score of scores) {
    const group = byScore.get(score)!;
    group.members.sort(compareHoldings);
    const holding = holdingPhrase(group.members, better, universe);
    if (group.category === 'flush') flushesSeen += 1;
    const quadsRank = group.category === 'quads' ? rankAt(rankDigits(score)[0]!) : null;
    const hand = handPhrase(group.category, score, {
      flushOrdinal: group.category === 'flush' ? flushesSeen : 0,
      kickerMatters: quadsRank !== null && (boardRankCount.get(quadsRank) ?? 0) >= 3,
      holdingWords: holding.text,
    });
    classes.push({
      category: group.category,
      score,
      label: `${holding.text}, for ${hand}`,
      holdings: group.members.map((h) => h.key),
      exactLabel: holding.exact,
    });
    for (const h of group.members) better.add(h.key);
  }
  return { enumerated: universe.length, classes };
}

/** Parse 'AhKc' style notation (as in test vectors); null when unreadable. */
export function cardsFromNotation(text: string): Card[] | null {
  const out: Card[] = [];
  for (const m of text.trim().split(/\s+/).join('').match(/.{2}/g) ?? []) {
    const c = cardFromRow({ rank: m[0], suit: m[1] });
    if (!c) return null;
    out.push(c);
  }
  return out.length ? out : null;
}
