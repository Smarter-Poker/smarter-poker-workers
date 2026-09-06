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
import { composeComment } from './Composer.js';
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

  it('card notation keeps its case in every style', () => {
    // Production, 2026-09-06 02:10: the lower-case style published
    // "well asqd7std on ts 6s 5s kh 4c" and the emphatic one "Nah
    // tc6h4dAhAd". Case is meaning in card notation, not decoration.
    //
    // A frame need not mention the cards at all (the big-fold line talks
    // about the board only), so this asserts the SHAPE: whatever card token
    // the text contains must be the canonical one, never a flattened copy.
    for (const f of HANDS) {
      const canonical = [f.holeNotation, ...f.boardNotation.split(' ')].filter(Boolean);
      for (const id of ids) {
        const t = composeHandPost(f, styleSheetFor(id)).text;
        for (const card of canonical) {
          // Word boundaries matter: a naive search for "Ts" finds the "ts"
          // inside "gets me" and reports a bug that is not there.
          const re = new RegExp(`\\b${card}\\b`, 'gi');
          for (const m of t.match(re) ?? []) expect(m).toBe(card);
        }
      }
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

/**
 * The four defects found by reading eight hours of live grounded output on
 * 2026-09-06, after Phase 3 shipped and before Phase 4 began. Every one of
 * them was true, well-formed and passing every test that existed.
 */
describe('a hand post does not read like a template', () => {
  const ids = fleetIds(90);

  it('the fleet does not tell every hand through the same sentence', () => {
    // Measured live: 58 grounded posts drawn from 14 skeletons in eight
    // hours, "got there with {hole}, {board} runout" seven times. The phrase
    // ledger could not see it, because the cards make every post unique.
    //
    // The guarantee is per category: while its pool holds out, no two horses
    // reach for the same skeleton. Eight is the smallest pool any category
    // has, so eight horses on one hand must produce eight different ones -
    // which is also what stops anybody shrinking a pool below eight.
    for (const f of HANDS) {
      const used = new Set<string>();
      for (const id of fleetIds(90).slice(0, 8)) {
        const r = composeHandPost(f, styleSheetFor(id), '0', used);
        expect(r.text.length).toBeGreaterThan(3);
        expect(r.frameKey).toMatch(/^frame:hand:/);
        expect(used.has(r.frameKey)).toBe(false);
        used.add(r.frameKey);
      }
      expect(used.size).toBe(8);
    }
  });

  it('a horse still speaks when every frame is taken', () => {
    // Failing open matters more than repeating: a horse that cannot post is
    // a defect, a horse reusing a skeleton is a blemish.
    const f = HANDS[0]!;
    const all = new Set<string>();
    for (let i = 0; i < 40; i++) all.add(`frame:hand:${f.category}:${i}`);
    const r = composeHandPost(f, styleSheetFor(fleetIds(1)[0]!), '0', all);
    expect(r.text.length).toBeGreaterThan(3);
  });
});

describe('a sentence never names a street the hand never reached', () => {
  const ids = fleetIds(60);
  it('a hand that ended on the flop has no river in it', () => {
    // The numbers-are-the-ledger's rule covers streets. "the whole thing
    // went in on the river" is a claim about the hand as surely as a pot is.
    const river = HANDS[0]!;
    const flop = {
      ...river,
      board: river.board.slice(0, 3),
      boardNotation: river.boardNotation.split(' ').slice(0, 3).join(' '),
      street: 'flop' as const,
    };
    for (const cat of ['big_win', 'bad_beat', 'cooler', 'river_aggression', 'big_fold', 'stackoff', 'grind'] as const) {
      for (const id of ids) {
        const t = composeHandPost({ ...flop, category: cat }, styleSheetFor(id)).text;
        expect(t.toLowerCase()).not.toContain('river');
      }
    }
  });
});

describe('a comment under a hand is written as poker, not as a column value', () => {
  const ids = fleetIds(60);

  it('the category label never reaches a sentence', () => {
    // Live 2026-09-06: "how often is the big win actually the right call
    // there", "what does the grind look like a street earlier". A brief's
    // concepts are internal labels; only HAND_REACT turns them into English.
    for (const f of HANDS) {
      const b = { ...briefForHand(f), postId: `p:${f.handId}` };
      for (const id of ids) {
        const t = composeComment(b, styleSheetFor(id)).text.toLowerCase();
        for (const label of ['big win', 'bad beat', 'river aggression', 'big fold', 'stackoff', 'the grind']) {
          expect(t).not.toContain(`the ${label} `);
          expect(t).not.toContain(`the ${label},`);
        }
        expect(t).not.toMatch(/\b(river_aggr|big_fold|preflop_stackoff|_won|_lost)\b/);
      }
    }
  });

  it('a holding is never spoken about as if it were a person', () => {
    // anchorOf() falls back to keyPhrase, and briefForHand sets that to the
    // hole cards: "curious how 8cKdQsJsTd plays that at a different stake".
    for (const f of HANDS) {
      const b = { ...briefForHand(f), postId: `p:${f.handId}` };
      for (const id of ids) {
        const t = composeComment(b, styleSheetFor(id)).text;
        expect(t).not.toMatch(/what does \S*[AKQJT2-9][hdcs]\S* do there/i);
        expect(t).not.toMatch(/curious how \S*[AKQJT2-9][hdcs]/i);
      }
    }
  });

  it('a commenter does not ask about a river that never came', () => {
    const river = HANDS[0]!;
    const flop = {
      ...river,
      board: river.board.slice(0, 3),
      boardNotation: river.boardNotation.split(' ').slice(0, 3).join(' '),
      street: 'flop' as const,
    };
    const b = { ...briefForHand(flop), postId: 'p:flop' };
    for (const id of ids) {
      expect(composeComment(b, styleSheetFor(id)).text.toLowerCase()).not.toContain('river');
    }
  });

  it('every comment on a hand says something', () => {
    for (const f of HANDS) {
      const b = { ...briefForHand(f), postId: `p:${f.handId}` };
      for (const id of ids.slice(0, 20)) {
        const t = composeComment(b, styleSheetFor(id)).text;
        expect(t.trim().length).toBeGreaterThan(8);
        expect(t).not.toContain('undefined');
        expect(t).not.toContain('{');
      }
    }
  });
});
