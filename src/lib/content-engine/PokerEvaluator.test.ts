/**
 * PokerEvaluator: fixed vectors for every category and tie order, best of
 * seven, and "the nuts" on the three boards the Phase 7 research verified
 * (out/nuts-sample.out.json, out/nuts-real-nlh.out.json) plus boards whose
 * nuts are derived by hand below.
 */
import { describe, it, expect } from 'vitest';
import {
  EVALUATOR_VERSION,
  LABEL_VOCABULARY,
  bestOfSeven,
  cardFromRow,
  cardKey,
  cardToken,
  cardsFromNotation,
  cardsFromRow,
  cardsLine,
  categoryOf,
  evaluate5,
  nutsOnBoard,
  rankDigits,
  type Card,
  type HandCategory,
} from './PokerEvaluator.js';

const cards = (s: string): Card[] => {
  const out = cardsFromNotation(s);
  if (!out) throw new Error(`bad notation ${s}`);
  return out;
};
const score = (s: string): number => evaluate5(cards(s)).score;
const cat = (s: string): HandCategory => evaluate5(cards(s)).category;

describe('cards from a horse_hand_reviews row', () => {
  it('reads word suits and letter suits, and refuses everything else', () => {
    expect(cardFromRow({ rank: 'K', suit: 'clubs' })).toEqual({ rank: 'K', suit: 'c' });
    expect(cardFromRow({ rank: 'T', suit: 'Diamonds' })).toEqual({ rank: 'T', suit: 'd' });
    expect(cardFromRow({ rank: 'A', suit: 'h' })).toEqual({ rank: 'A', suit: 'h' });
    for (const bad of [null, undefined, 'Ks', 7, {}, { rank: '10', suit: 'spades' }, { rank: 'K', suit: 'club' }, { rank: 'k', suit: 'clubs' }, { rank: 'X', suit: 'clubs' }, { rank: 'K' }, { suit: 'clubs' }]) {
      expect(cardFromRow(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('reads a whole array or nothing, and refuses a repeated card', () => {
    expect(cardsFromRow([{ rank: '2', suit: 'clubs' }, { rank: '7', suit: 'clubs' }])).toEqual([{ rank: '2', suit: 'c' }, { rank: '7', suit: 'c' }]);
    expect(cardsFromRow([{ rank: '2', suit: 'clubs' }, { rank: 'zz', suit: 'clubs' }])).toBeNull();
    expect(cardsFromRow([{ rank: '2', suit: 'clubs' }, { rank: '2', suit: 'c' }])).toBeNull();
    expect(cardsFromRow('nope')).toBeNull();
    expect(cardsFromRow([])).toEqual([]);
  });

  it('writes the Phase 5 feed token and the formatPokerCards lines', () => {
    expect(cardToken({ rank: 'A', suit: 'c' })).toBe('[[sp-card:Ac]]');
    expect(cardsLine('Hand', cards('Kc7d'))).toBe('Hand [[sp-card:Kc]][[sp-card:7d]]');
    expect(cardsLine('Board', cards('2c7cAcQc2d'))).toBe('Board [[sp-card:2c]][[sp-card:7c]][[sp-card:Ac]][[sp-card:Qc]][[sp-card:2d]]');
    expect(cardKey({ rank: '2', suit: 'h' })).toBe('2h');
  });
});

describe('evaluate5: every category, in order', () => {
  const ladder: Array<[string, HandCategory]> = [
    ['Ac7d5h3s2c', 'high_card'],
    ['AcAd5h3s2c', 'pair'],
    ['AcAd5h5s2c', 'two_pair'],
    ['AcAdAh5s2c', 'trips'],
    ['5c4d3h2sAc', 'straight'],
    ['Kc9c7c4c2c', 'flush'],
    ['2c2d2hAsAc', 'full_house'],
    ['2c2d2h2sAc', 'quads'],
    ['9h8h7h6h5h', 'straight_flush'],
  ];

  it('names each category and ranks the categories in the standard order', () => {
    for (let i = 0; i < ladder.length; i++) {
      const [hand, expected] = ladder[i]!;
      expect(cat(hand), hand).toBe(expected);
      expect(categoryOf(score(hand))).toBe(expected);
      if (i > 0) expect(score(hand), `${hand} beats ${ladder[i - 1]![0]}`).toBeGreaterThan(score(ladder[i - 1]![0]));
    }
    expect(() => evaluate5(cards('AcKc'))).toThrow();
  });

  it('orders straights: wheel lowest, ace high highest, and the wheel is not ace high', () => {
    expect(cat('5c4d3h2sAc')).toBe('straight');
    expect(score('5c4d3h2sAc')).toBeLessThan(score('6c5d4h3s2c'));
    expect(score('6c5d4h3s2c')).toBeLessThan(score('9c8d7h6s5c'));
    expect(score('9c8d7h6s5c')).toBeLessThan(score('AcKdQhJsTc'));
    expect(rankDigits(score('5c4d3h2sAc'))[0]).toBe(3); // five high
    expect(rankDigits(score('AcKdQhJsTc'))[0]).toBe(12); // ace high
    // K Q J T A is not a straight: A 2 3 4 5 is the only wrap.
    expect(cat('KcQdJhTs9c')).toBe('straight');
    expect(cat('QcJdTh9s7c')).toBe('high_card');
  });

  it('orders flushes by every kicker, and equal hands score equal', () => {
    expect(score('AcKcQcJc9c')).toBeGreaterThan(score('AcKcQcTc9c'));
    expect(score('AcKcQcTc9c')).toBeGreaterThan(score('AcKcJcTc9c'));
    expect(score('Ac9c7c5c3c')).toBeGreaterThan(score('Ac9c7c5c2c'));
    expect(score('Ac9c7c5c2c')).toBe(score('Ah9h7h5h2h'));
    expect(score('Kc9c7c4c2c')).toBeGreaterThan(score('AcKdQhJs9c')); // any flush beats any high card
  });

  it('orders full houses by the trips first, then the pair', () => {
    expect(score('AcAdAh2s2c')).toBeGreaterThan(score('KcKdKhAsAc'));
    expect(score('KcKdKhAsAc')).toBeGreaterThan(score('KcKdKhQsQc'));
    expect(score('3c3d3h2s2c')).toBeGreaterThan(score('2c2d2hAsAc'));
  });

  it('orders quads by the quads, then the kicker', () => {
    expect(score('2c2d2h2sAc')).toBeGreaterThan(score('2c2d2h2sKc'));
    expect(score('3c3d3h3s2c')).toBeGreaterThan(score('2c2d2h2sAc'));
    expect(score('9h8h7h6h5h')).toBeGreaterThan(score('AcAdAhAsKc')); // a straight flush beats quad aces
    expect(score('AhKhQhJhTh')).toBeGreaterThan(score('9h8h7h6h5h'));
  });

  it('orders pairs, two pair and trips by rank then kickers', () => {
    expect(score('AcAd5h3s2c')).toBeGreaterThan(score('KcKdAh3s2c'));
    expect(score('AcAdKh3s2c')).toBeGreaterThan(score('AcAdQh3s2c'));
    expect(score('AcAd5h5s2c')).toBeGreaterThan(score('KcKdQhQs2c'));
    expect(score('AcAd5h5sKc')).toBeGreaterThan(score('AcAd5h5s2c'));
    expect(score('AcAd3h3s2c')).toBeGreaterThan(score('KcKdQhQsAc'));
    expect(score('2c2d2hAsKc')).toBeGreaterThan(score('AcAd5h5sKc')); // trips beat two pair
    expect(score('3c3d3h2s4c')).toBeGreaterThan(score('2c2d2hAsKc'));
    expect(score('2c2d2hAsKc')).toBeGreaterThan(score('2c2d2hAsQc'));
  });
});

describe('bestOfSeven', () => {
  it('finds the best five of seven, six or five cards', () => {
    // Board with a straight and a flush available: the flush wins.
    expect(bestOfSeven(cards('9c8c7c6dKc2c')).category).toBe('flush');
    expect(bestOfSeven(cards('9c8c7c6cKc2dTc')).category).toBe('straight_flush');
    expect(bestOfSeven(cards('9c8c7c6dKc2cTc')).category).toBe('flush'); // the six is not a club
    expect(bestOfSeven(cards('AcAd5h3s2c7d9h')).category).toBe('pair');
    expect(bestOfSeven(cards('AcAd5h3s2c'))).toEqual(evaluate5(cards('AcAd5h3s2c')));
    // Two pair among seven with the best kicker chosen.
    const v = bestOfSeven(cards('AcAd5h5s2c9dKc'));
    expect(v.category).toBe('two_pair');
    expect(rankDigits(v.score)).toEqual([12, 12, 3, 3, 11]);
    expect(() => bestOfSeven(cards('AcAd5h3s'))).toThrow();
    expect(() => bestOfSeven(cards('AcAd5h3s2c7d9hKs'))).toThrow();
  });
});

describe('nutsOnBoard: the three verified boards', () => {
  it('7h Ks 5c 6h 2c: a nine high straight, 16 holdings of nine eight (sample out)', () => {
    const r = nutsOnBoard(cards('7hKs5c6h2c'));
    expect(r.enumerated).toBe(1081);
    const best = r.classes[0]!;
    expect(best.category).toBe('straight');
    expect(best.holdings).toHaveLength(16);
    expect(best.holdings.every((h) => /^9[cdhs]8[cdhs]$/.test(h))).toBe(true);
    expect(best.label).toBe('any nine eight, for a nine high straight');
    expect(best.exactLabel).toBe(true);
  });

  it('Td Js Kh 7c 6c: an ace high straight with ace queen (sample out)', () => {
    const best = nutsOnBoard(cards('TdJsKh7c6c')).classes[0]!;
    expect(best.category).toBe('straight');
    expect(best.holdings).toHaveLength(16);
    expect(best.holdings.every((h) => /^A[cdhs]Q[cdhs]$/.test(h))).toBe(true);
    expect(best.label).toBe('any ace queen, for an ace high straight');
  });

  it('2c 7c Ac Qc 2d: quads with pocket deuces, 2h2s only (real NLH row 829413)', () => {
    const r = nutsOnBoard(cards('2c7cAcQc2d'));
    const [best, second] = r.classes;
    expect(best!.category).toBe('quads');
    expect(best!.holdings).toEqual(['2h2s']);
    expect(best!.label).toBe('pocket deuces, for quads');
    expect(second!.label).toBe('pocket aces, for aces full of deuces');
    expect(second!.holdings).toEqual(['AdAh', 'AdAs', 'AhAs']);
  });
});

describe('nutsOnBoard: boards derived by hand', () => {
  it('9h 8h 7h 7d 2c, a paired board with straight flushes: the jack ten of hearts, then ten six, six five, then quad sevens', () => {
    const c = nutsOnBoard(cards('9h8h7h7d2c')).classes;
    expect(c.slice(0, 4).map((x) => x.label)).toEqual([
      'the jack ten of hearts, for a jack high straight flush',
      'the ten six of hearts, for a ten high straight flush',
      'the six five of hearts, for a nine high straight flush',
      'pocket sevens, for quads',
    ]);
    expect(c.slice(0, 4).map((x) => x.holdings)).toEqual([['JhTh'], ['Th6h'], ['6h5h'], ['7c7s']]);
  });

  it('9h 8h 6h 3h 2h, a monotone board: ten seven for a ten high straight flush, then the seven five, five four, then the nut flush', () => {
    const c = nutsOnBoard(cards('9h8h6h3h2h')).classes;
    expect(c.slice(0, 4).map((x) => x.label)).toEqual([
      'the ten seven of hearts, for a ten high straight flush',
      'the seven five of hearts, for a nine high straight flush',
      'the five four of hearts, for a six high straight flush',
      'the ace king of hearts, for the nut flush',
    ]);
    expect(c[4]!.label).toBe('the ace queen of hearts, for the second nut flush');
    // Everyone has at least the board flush: no class below flush exists.
    expect(c.every((x) => x.category === 'flush' || x.category === 'straight_flush')).toBe(true);
  });

  it('a full house is never the nuts in hold em (a paired board always allows the pocket pair for quads), so it is the runner up here', () => {
    const c = nutsOnBoard(cards('KhKd7c7s2h')).classes;
    expect(c.slice(0, 5).map((x) => x.label)).toEqual([
      'pocket kings, for quads',
      'pocket sevens, for quads',
      'any king, for kings full of sevens',
      'any seven, for sevens full of kings',
      'pocket deuces, for deuces full of kings',
    ]);
    // 91 holdings hold a king; one of them (KcKs) makes quads instead.
    expect(c[2]!.holdings).toHaveLength(90);
    expect(c[0]!.holdings).toEqual(['KcKs']);
  });

  it('2c 2d 2h 2s Ah, quads with the ace on board: every holding ties in one class', () => {
    const r = nutsOnBoard(cards('2c2d2h2sAh'));
    expect(r.classes).toHaveLength(1);
    expect(r.classes[0]!.holdings).toHaveLength(1081);
    expect(r.classes[0]!.label).toBe('any two cards, for quad deuces with an ace kicker');
  });

  it('7h 7d 7s Kc 2h, trips on board: the kicker separates the quads classes', () => {
    const c = nutsOnBoard(cards('7h7d7sKc2h')).classes;
    expect(c[0]!.label).toBe('any ace seven, for quads with an ace kicker');
    expect(c[0]!.holdings).toEqual(['Ac7c', 'Ad7c', 'Ah7c', 'As7c']);
    expect(c[1]!.label).toBe('any seven, for quads with a king kicker');
    expect(c[1]!.holdings).toHaveLength(42);
    expect(c[2]!.label).toBe('pocket kings, for kings full of sevens');
  });

  it('Kd 7c 2s 3h 9c, a rainbow board with no pair and no straight: sets, best rank first', () => {
    const c = nutsOnBoard(cards('Kd7c2s3h9c')).classes;
    expect(c.slice(0, 5).map((x) => x.label)).toEqual([
      'pocket kings, for a set of kings',
      'pocket nines, for a set of nines',
      'pocket sevens, for a set of sevens',
      'pocket threes, for a set of threes',
      'pocket deuces, for a set of deuces',
    ]);
    expect(c[0]!.holdings).toEqual(['KcKh', 'KcKs', 'KhKs']);
  });

  it('5c 6d 7h 8s Kc, four to a straight on board: ten nine, then any nine, then any four', () => {
    const c = nutsOnBoard(cards('5c6d7h8sKc')).classes;
    expect(c.slice(0, 3).map((x) => [x.label, x.holdings.length])).toEqual([
      ['any ten nine, for a ten high straight', 16],
      ['any nine, for a nine high straight', 162],
      ['any four, for an eight high straight', 162],
    ]);
  });

  it('9h 8h 7h 6h 2c, four to a straight flush on board: one card classes', () => {
    const c = nutsOnBoard(cards('9h8h7h6h2c')).classes;
    expect(c.slice(0, 3).map((x) => [x.label, x.holdings.length])).toEqual([
      ['the jack ten of hearts, for a jack high straight flush', 1],
      ['the ten of hearts with any card, for a ten high straight flush', 45],
      ['the five of hearts with any card, for a nine high straight flush', 45],
    ]);
  });

  it('Ac 7c 2c Qd 9s, three to a flush: nut, second, third and fourth nut flush are exact two card classes', () => {
    const c = nutsOnBoard(cards('Ac7c2cQd9s')).classes;
    expect(c.slice(0, 4).map((x) => x.label)).toEqual([
      'the king queen of clubs, for the nut flush',
      'the king jack of clubs, for the second nut flush',
      'the king ten of clubs, for the third nut flush',
      'the king nine of clubs, for the fourth nut flush',
    ]);
  });
});

describe('nutsOnBoard: invariants on every board above', () => {
  const BOARDS = ['7hKs5c6h2c', 'TdJsKh7c6c', '2c7cAcQc2d', '9h8h7h7d2c', '9h8h6h3h2h', 'KhKd7c7s2h', '2c2d2h2sAh', '7h7d7sKc2h', 'Kd7c2s3h9c', '5c6d7h8sKc', '9h8h7h6h2c', 'Ac7c2cQd9s'];

  it('partitions all 1081 holdings into classes strictly ordered best first, every holding canonical and sorted', () => {
    for (const b of BOARDS) {
      const r = nutsOnBoard(cards(b));
      expect(r.enumerated, b).toBe(1081);
      expect(r.classes.reduce((n, c) => n + c.holdings.length, 0), b).toBe(1081);
      const all = new Set<string>();
      for (let i = 0; i < r.classes.length; i++) {
        const c = r.classes[i]!;
        if (i > 0) expect(c.score, b).toBeLessThan(r.classes[i - 1]!.score);
        expect(categoryOf(c.score), b).toBe(c.category);
        for (const h of c.holdings) {
          expect(h, b).toMatch(/^[2-9TJQKA][cdhs][2-9TJQKA][cdhs]$/);
          expect(all.has(h), `${b} repeats ${h}`).toBe(false);
          all.add(h);
        }
        expect(c.label, b).toContain(', for ');
      }
    }
  });

  it('labels the top four classes of every board exactly, from the fixed vocabulary, with no emoji, dashes, at signs or names', () => {
    const vocabulary = new Set(LABEL_VOCABULARY);
    for (const b of BOARDS) {
      const top = nutsOnBoard(cards(b)).classes.slice(0, 4);
      expect(new Set(top.map((c) => c.label)).size, b).toBe(top.length);
      for (const c of top) {
        expect(c.exactLabel, `${b}: ${c.label}`).toBe(true);
        expect(c.label).not.toMatch(/\p{Extended_Pictographic}/u);
        expect(c.label).not.toMatch(/[–—@]/);
        expect(c.label).toBe(c.label.toLowerCase());
        for (const word of c.label.match(/[a-z]+/g) ?? []) {
          expect(vocabulary.has(word), `${b}: word "${word}" in "${c.label}"`).toBe(true);
        }
      }
    }
  });

  it('refuses a board that is not five distinct cards and carries a fixed version', () => {
    expect(() => nutsOnBoard(cards('2c7cAcQc'))).toThrow();
    expect(() => nutsOnBoard(cards('2c7cAcQc2c'))).toThrow();
    expect(EVALUATOR_VERSION).toBe('p7-nlh-1');
  });
});
