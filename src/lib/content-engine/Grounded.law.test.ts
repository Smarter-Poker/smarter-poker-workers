/**
 * The Phase 3 law: a horse tells the truth about its own poker, and names
 * nobody.
 *
 * Two rules, and neither bends:
 *
 *   THE NUMBERS ARE THE LEDGER'S. Every figure a post states must be one the
 *   `horse_hand_reviews` row carries. This is the platform that reconciles
 *   chips to the cent; a horse that rounds a pot up into a better story is a
 *   horse a player can catch, and one caught horse discredits all thousand.
 *
 *   NOBODY IS NAMED. The action log carries every opponent's user id. A post
 *   says "the big blind" or "a reg", never a person. Programme invariant 3.
 *
 * Fixtures are real rows from production, 2026-09-05/06.
 */
import { describe, it, expect } from 'vitest';
import {
  categorise,
  holeText,
  boardText,
  cardText,
  variantName,
  type HandFacts,
  type SessionFacts,
} from './HandStory.js';
import {
  composeHandPost,
  composeSessionPost,
  factsMatch,
  briefForHand,
  briefForSession,
} from './GroundedComposer.js';
import { styleSheetFor } from './StyleSheet.js';
import { fleetHash } from './FleetScheduler.js';

function fleetIds(n = 200): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const h = fleetHash(String(i), 'g1').toString(16).padStart(8, '0');
    const g = fleetHash(String(i), 'g2').toString(16).padStart(8, '0');
    ids.push(`${h}-${g.slice(0, 4)}-4${g.slice(4, 7)}-8${h.slice(1, 4)}-${g}${h.slice(0, 4)}`);
  }
  return ids;
}

const C = (rank: string, suit: string) => ({ rank, suit });

/** Real hands, straight out of horse_hand_reviews. */
const HANDS: HandFacts[] = [
  {
    handId: '206540', playedAt: '2026-09-04T08:27:40Z', variant: 'plo5', format: 'cash', bigBlind: 5,
    hole: [C('Q', 'spades'), C('J', 'clubs'), C('9', 'clubs'), C('K', 'hearts'), C('3', 'hearts')],
    board: [C('Q', 'clubs'), C('3', 'clubs'), C('7', 'spades'), C('Q', 'hearts'), C('8', 'diamonds')],
    netBb: 292.21, potBb: 477.4, isWin: true, leaks: ['river_aggr_won', 'river_raise_war_won'],
    category: 'river_aggression', holeNotation: 'QsJc9cKh3h', boardNotation: 'Qc 3c 7s Qh 8d',
    street: 'river', stake: '2.5/5',
  },
  {
    handId: '250611', playedAt: '2026-09-05T09:34:39Z', variant: 'short_deck', format: 'hu_cash', bigBlind: 1,
    hole: [C('K', 'hearts'), C('A', 'clubs')],
    board: [C('8', 'clubs'), C('Q', 'clubs'), C('7', 'clubs'), C('9', 'spades'), C('K', 'diamonds')],
    netBb: -90.22, potBb: 180.4, isWin: false, leaks: ['river_aggr_lost', 'river_raise_paidoff'],
    category: 'bad_beat', holeNotation: 'AKo', boardNotation: '8c Qc 7c 9s Kd',
    street: 'river', stake: '0.5/1',
  },
  {
    handId: '239424', playedAt: '2026-09-05T01:03:52Z', variant: 'nlh', format: 'tournament', bigBlind: 1000,
    hole: [C('4', 'diamonds'), C('5', 'spades')],
    board: [C('4', 'spades'), C('2', 'diamonds'), C('4', 'clubs'), C('3', 'spades'), C('7', 'hearts')],
    netBb: 30.32, potBb: 61.3, isWin: true, leaks: [],
    category: 'grind', holeNotation: '54o', boardNotation: '4s 2d 4c 3s 7h',
    street: 'river',
  },
  {
    handId: '254664', playedAt: '2026-09-05T15:12:41Z', variant: 'nlh', format: 'cash', bigBlind: 0.25,
    hole: [C('J', 'diamonds'), C('K', 'hearts')],
    board: [C('Q', 'spades'), C('T', 'diamonds'), C('2', 'spades'), C('6', 'diamonds'), C('T', 'spades')],
    netBb: -142.56, potBb: 286.1, isWin: false, leaks: ['big_bet_fold', 'big_fold_river'],
    category: 'big_fold', holeNotation: 'KJo', boardNotation: 'Qs Td 2s 6d Ts',
    street: 'river',
  },
  {
    handId: '241703', playedAt: '2026-09-05T02:15:04Z', variant: 'nlh', format: 'cash', bigBlind: 2,
    hole: [C('A', 'diamonds'), C('K', 'clubs')],
    board: [C('3', 'diamonds'), C('5', 'hearts'), C('Q', 'diamonds'), C('J', 'spades'), C('T', 'diamonds')],
    netBb: 99.96, potBb: 105.8, isWin: true, leaks: [],
    category: 'big_win', holeNotation: 'AKo', boardNotation: '3d 5h Qd Js Td',
    street: 'river', stake: '1/2',
  },
  {
    handId: 'preflop-1', playedAt: '2026-09-05T12:00:00Z', variant: 'nlh', format: 'tournament', bigBlind: 100,
    hole: [C('A', 'spades'), C('A', 'hearts')], board: [],
    netBb: 88.5, potBb: 177, isWin: true, leaks: ['preflop_stackoff_won'],
    category: 'stackoff', holeNotation: 'AA', boardNotation: '',
    street: 'preflop',
  },
];

const SESSIONS: SessionFacts[] = [
  { day: '2026-09-05', variant: 'plo4', format: 'cash', hands: 441, netBb: 1958.2 },
  { day: '2026-09-05', variant: 'nlh', format: 'cash', hands: 212, netBb: -88.4 },
  { day: '2026-09-04', variant: 'nlh', format: 'cash', hands: 96, netBb: 1.2 },
];

describe('cards are written the way a player writes them', () => {
  it('formats a card as rank plus suit letter', () => {
    expect(cardText(C('K', 'clubs'))).toBe('Kc');
    expect(cardText(C('T', 'spades'))).toBe('Ts');
  });

  it('uses holdem shorthand for two cards and writes out four', () => {
    expect(holeText([C('J', 'hearts'), C('J', 'diamonds')])).toBe('JJ');
    expect(holeText([C('A', 'clubs'), C('K', 'clubs')])).toBe('AKs');
    expect(holeText([C('K', 'hearts'), C('A', 'clubs')])).toBe('AKo');
    expect(holeText([C('A', 'clubs'), C('K', 'hearts'), C('2', 'spades'), C('7', 'diamonds')]))
      .toBe('AcKh2s7d');
  });

  it('boards read left to right', () => {
    expect(boardText([C('Q', 'clubs'), C('3', 'clubs'), C('7', 'spades')])).toBe('Qc 3c 7s');
  });

  it('names the variant in words a player would use', () => {
    expect(variantName('nlh')).toBe('no limit holdem');
    expect(variantName('plo4')).toBe('PLO');
    expect(variantName('short_deck')).toBe('short deck');
  });
});

describe('the hand is categorised from the tags the reviewer assigned', () => {
  it('reads the real tag vocabulary', () => {
    expect(categorise(['river_aggr_won'], true, 51)).toBe('river_aggression');
    expect(categorise(['big_fold_river'], false, -142)).toBe('big_fold');
    expect(categorise(['dominated_straight_stackoff'], false, -80)).toBe('cooler');
    expect(categorise(['preflop_stackoff'], true, 40)).toBe('stackoff');
    expect(categorise([], false, -120)).toBe('bad_beat');
    expect(categorise([], true, 200)).toBe('big_win');
    expect(categorise([], true, 5)).toBe('grind');
  });
});

describe('a post never states a number the ledger does not carry', () => {
  const ids = fleetIds(120);

  it('every hand, every horse, passes the facts gate', () => {
    for (const f of HANDS) {
      for (const id of ids) {
        const r = composeHandPost(f, styleSheetFor(id));
        expect(r.text.length).toBeGreaterThan(3);
        expect(factsMatch(r.text, f)).toBe(true);
      }
    }
  });

  it('the gate actually catches an invented number', () => {
    const f = HANDS[0]!;
    expect(factsMatch('won 900bb on that one', f)).toBe(false);
    expect(factsMatch(`won ${Math.round(f.netBb)}bb on that one`, f)).toBe(true);
  });

  it('the gate catches invented cards', () => {
    const f = HANDS[1]!;
    expect(factsMatch('AKo on 2h3h4h5h6h', f)).toBe(false);
    expect(factsMatch(`${f.holeNotation} on ${f.boardNotation}`, f)).toBe(true);
  });

  it('card notation survives the numerals-as-words style', () => {
    // Measured 2026-09-06: that style turned "QsJc9cKh3h on Qc 3c 7s" into
    // "QsJcninecKhthreeh on Qc threec sevens", which no player can read.
    const f = HANDS[0]!;
    for (const id of ids) {
      const t = composeHandPost(f, styleSheetFor(id)).text;
      expect(t).not.toMatch(/nine[cdhs]|three[cdhs]|seven[cdhs]|two[cdhs]|eight[cdhs]/);
    }
  });

  it('a hand that never saw a flop is never given a board', () => {
    const f = HANDS[4]!;
    for (const id of ids) {
      const t = composeHandPost(f, styleSheetFor(id)).text.toLowerCase();
      expect(t).not.toContain(' on  ');
      expect(t).not.toMatch(/\bboard runs\b/);
      expect(factsMatch(t, f)).toBe(true);
    }
  });
});

describe('a session post states the day it actually had', () => {
  const ids = fleetIds(60);

  it('names the real hand count and the real result', () => {
    for (const s of SESSIONS) {
      for (const id of ids.slice(0, 25)) {
        const r = composeSessionPost(s, styleSheetFor(id));
        expect(r.text.length).toBeGreaterThan(3);
        expect(r.stated.hands).toBe(s.hands);
        expect(r.stated.netBb).toBe(s.netBb);
        // The hand count must appear, and no other stray count may.
        const nums = r.text.match(/\b\d{2,}\b/g) ?? [];
        for (const n of nums) {
          const v = Number(n);
          const ok = v === s.hands || Math.abs(v - Math.abs(s.netBb)) < 1 || v === Math.round(Math.abs(s.netBb));
          expect(ok).toBe(true);
        }
      }
    }
  });

  it('a losing day is not written as a winning one', () => {
    const losing = SESSIONS[1]!;
    for (const id of ids.slice(0, 20)) {
      const t = composeSessionPost(losing, styleSheetFor(id)).text.toLowerCase();
      expect(t).not.toMatch(/good day|take those/);
    }
  });
});

describe('nobody is named', () => {
  const ids = fleetIds(120);

  it('no opponent is ever a person', () => {
    for (const f of HANDS) {
      for (const id of ids) {
        const t = composeHandPost(f, styleSheetFor(id)).text;
        // No @handles, and no capitalised two-word names outside card groups.
        expect(t).not.toMatch(/@\w/);
        expect(t.toLowerCase()).not.toMatch(/\bvillain\b|\bseat \d\b.*\bcalled\b/);
      }
    }
  });

  it('the anonymous opponents are the only ones referenced', () => {
    const seen = new Set<string>();
    for (const f of HANDS) {
      for (const id of ids) {
        const t = composeHandPost(f, styleSheetFor(id)).text.toLowerCase();
        for (const opp of ['the big blind', 'a reg', 'one of the regs', 'the small blind', 'the guy in the straddle']) {
          if (t.includes(opp)) seen.add(opp);
        }
      }
    }
    // At least one anonymous form is in use, and nothing else names anybody.
    expect(seen.size).toBeGreaterThan(0);
  });
});

describe('the brief describes the hand honestly', () => {
  it('carries the cards, the result and full confidence', () => {
    const f = HANDS[0]!;
    const b = briefForHand(f);
    expect(b.domain).toBe('poker');
    expect(b.kind).toBe('hand');
    expect(b.people).toEqual([]);
    expect(b.confidence).toBe(1);
    expect(b.amounts[0]).toContain('bb');
    expect(b.title).toContain(f.holeNotation);
    expect(b.builtFrom).toContain('horse_hand_reviews');
  });

  it('a session brief says where it came from', () => {
    const b = briefForSession(SESSIONS[0]!);
    expect(b.builtFrom).toContain('horse_daily_nets');
    expect(b.domain).toBe('poker');
    expect(b.people).toEqual([]);
  });
});

describe('house rules still hold on grounded posts', () => {
  const ids = fleetIds(80);
  it('no emoji, no em dashes', () => {
    for (const f of HANDS) {
      for (const id of ids) {
        const t = composeHandPost(f, styleSheetFor(id)).text;
        expect(t).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
        expect(t).not.toContain('—');
      }
    }
  });
});
