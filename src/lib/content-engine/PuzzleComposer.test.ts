/**
 * PuzzleComposer: every kind on rows in the horse_hand_reviews shape, the
 * committed answer, deterministic option placement, every rejection reason,
 * and the laws every horse-visible line obeys (no emoji, no dashes, no at
 * signs, no names, nothing the row does not say, and never a user id).
 */
import { describe, it, expect } from 'vitest';
import {
  PUZZLE_KINDS,
  REVEAL_HOURS,
  TEMPLATE_POOL,
  commitmentFor,
  composePuzzle,
  correctPosition,
  puzzleKey,
  type ComposedPuzzle,
  type PuzzleKind,
  type PuzzleReviewRow,
} from './PuzzleComposer.js';
import { EVALUATOR_VERSION } from './PokerEvaluator.js';

const HORSE = 'aaaaaaaa-0000-4000-8000-00000000h0r5';
/** A fake opponent id planted in the action log; it must never come out. */
const VILLAIN = 'fake-human-0000-4000-8000-0000deadbeef';
const HAND = 'bbbbbbbb-0000-4000-8000-000000000001';
const SALT = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';
const NOW = new Date('2026-09-30T01:00:00Z');

const w = (rank: string, suit: string) => ({ rank, suit });
interface Act {
  seat: number;
  userId: string;
  stage: string;
  action: string;
  amount: number;
  origin?: string;
  publicNode: { pot: number | null; currentBet: number | null; seats: number[][] } | null;
}
const act = (seat: number, userId: string, stage: string, action: string, amount: number, pot: number | null, currentBet: number | null): Act => ({
  seat, userId, stage, action, amount, origin: 'horse_policy', publicNode: { pot, currentBet, seats: [[seat, 1000]] },
});

/** Preflop to the turn, checked around on the turn: pot 586 on the river. */
const TO_RIVER: Act[] = [
  { seat: 5, userId: HORSE, stage: 'preflop', action: 'sb', amount: 2.5, origin: 'forced', publicNode: null },
  { seat: 9, userId: VILLAIN, stage: 'preflop', action: 'bb', amount: 5, origin: 'forced', publicNode: null },
  act(5, HORSE, 'preflop', 'raise', 15, 7.5, 5),
  act(9, VILLAIN, 'preflop', 'call', 10, 20, 15),
  act(5, HORSE, 'flop', 'check', 0, 30, 0),
  act(9, VILLAIN, 'flop', 'bet', 20, 30, 0),
  act(5, HORSE, 'flop', 'call', 20, 50, 20),
  act(5, HORSE, 'turn', 'bet', 258, 70, 0),
  act(9, VILLAIN, 'turn', 'call', 258, 328, 258),
];

/** The design section 3.3 river: horse checks, a bet of 419 into 586, horse calls. */
const RIVER_BET: Act[] = [act(5, HORSE, 'river', 'check', 0, 586, 0), act(9, VILLAIN, 'river', 'bet', 419, 586, 0), act(5, HORSE, 'river', 'call', 419, 1005, 419)];

function row(over: Partial<PuzzleReviewRow> = {}): PuzzleReviewRow {
  return {
    id: 829413,
    hand_id: HAND,
    horse_user_id: HORSE,
    game_variant: 'nlh',
    format: 'cash',
    big_blind: 5,
    played_at: '2026-09-29T20:00:00Z',
    net_bb: 58.6,
    is_win: true,
    pot_size: 201,
    seat: 5,
    hole_cards: [w('T', 'hearts'), w('J', 'clubs')],
    board: [w('2', 'clubs'), w('7', 'clubs'), w('A', 'clubs'), w('Q', 'clubs'), w('2', 'diamonds')],
    actions: [...TO_RIVER, ...RIVER_BET],
    ...over,
  };
}

function ok(kind: PuzzleKind, r: PuzzleReviewRow = row(), salt = SALT): ComposedPuzzle {
  const res = composePuzzle(kind, r, { salt, now: NOW });
  if (!res.ok) throw new Error(`${kind} rejected: ${res.rejected}`);
  return res.puzzle;
}
function rejected(kind: PuzzleKind, r: PuzzleReviewRow, salt = SALT): string {
  const res = composePuzzle(kind, r, { salt, now: NOW });
  return res.ok ? 'OK' : res.rejected;
}
const correctLabel = (p: ComposedPuzzle): string => p.options.find((o) => o.key === p.correct_option)!.label;

describe('the nuts puzzle', () => {
  it('composes the design board: pocket deuces for quads, three full house decoys, the board as feed tokens', () => {
    const p = ok('nuts');
    expect(p.kind).toBe('nuts');
    expect(p.puzzle_key).toBe(`p7:nuts:${HAND}`);
    expect(p.hand_id).toBe(HAND);
    expect(p.source_review_id).toBe(829413);
    expect(p.game_variant).toBe('nlh');
    expect(p.board).toEqual([{ rank: '2', suit: 'c' }, { rank: '7', suit: 'c' }, { rank: 'A', suit: 'c' }, { rank: 'Q', suit: 'c' }, { rank: '2', suit: 'd' }]);
    expect(p.prompt.split('\n')).toEqual([
      'Went to the river on this board not long ago in a 2.5/5 cash game.',
      'Board [[sp-card:2c]][[sp-card:7c]][[sp-card:Ac]][[sp-card:Qc]][[sp-card:2d]]',
      'What is the nuts here? I will post the answer in about six hours.',
    ]);
    expect(p.options.map((o) => o.key)).toEqual(['A', 'B', 'C', 'D']);
    expect(correctLabel(p)).toBe('pocket deuces, for quads');
    expect(p.options.map((o) => o.label).sort()).toEqual([
      'pocket aces, for aces full of deuces',
      'pocket deuces, for quads',
      'pocket queens, for queens full of deuces',
      'pocket sevens, for sevens full of deuces',
    ]);
    expect(p.explanation).toBe('The best hand this board allows is quads. 1 of the 1081 two card holdings makes it. Next best is aces full of deuces, made by 3 holdings.');
    expect(p.proof).toMatchObject({ category: 'quads', holdings: ['2h2s'], holdings_count: 1, enumerated: 1081, evaluator_version: 'p7-nlh-1' });
    expect(p.evaluator_version).toBe(EVALUATOR_VERSION);
    expect(p.rewardable).toBe(true);
    expect(p.reveal_hours).toBe(REVEAL_HOURS);
    expect(p.reveal_hours).toBe(6);
    expect(p.salt).toBe(SALT);
  });

  it('uses neutral recent timing across midnight because the row does not carry the author timezone', () => {
    const result = composePuzzle('nuts', row({ played_at: '2026-09-30T23:00:00Z' }), {
      salt: SALT,
      now: new Date('2026-10-01T00:30:00Z'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`nuts rejected: ${result.rejected}`);
    expect(result.puzzle.prompt).toContain('Went to the river on this board not long ago in a 2.5/5 cash game.');
    expect(result.puzzle.prompt).not.toContain('earlier today');
  });

  it('names the format when the stake cannot be stated', () => {
    const p = ok('nuts', row({ played_at: '2026-09-29T08:00:00Z', format: 'tournament', big_blind: 400 }));
    expect(p.prompt).toContain('Went to the river on this board not long ago in a tournament.');
    const q = ok('nuts', row({ format: 'cash', big_blind: 0.25 }));
    expect(q.prompt).toContain('in a cash game.');
    const h = ok('nuts', row({ format: 'hu_cash', big_blind: 2 }));
    expect(h.prompt).toContain('in a 1/2 heads up cash game.');
  });

  it('reads numeric columns that arrive as strings the way PostgREST sends them', () => {
    const p = ok('nuts', row({ big_blind: '5' as unknown as number }));
    expect(p.prompt).toContain('2.5/5 cash game');
  });
});

describe('the pot odds puzzle', () => {
  it('composes the design section 3.3 river: 419 into 586 is 29 percent, about 2.4 to 1, with the three prescribed decoys', () => {
    const p = ok('pot_odds');
    expect(p.prompt.split('\n')[2]).toBe('There is 586 in the pot and I am facing a bet of 419. How much equity do I need to call? I will post the answer in about six hours.');
    expect(correctLabel(p)).toBe('29 percent, about 2.4 to 1');
    expect(p.options.map((o) => o.label).sort()).toEqual(['15 percent, about 5.8 to 1', '29 percent, about 2.4 to 1', '42 percent, about 1.4 to 1', '72 percent, about 0.4 to 1']);
    expect(p.explanation).toBe(
      'Calling 419 to win a pot of 1005 means putting in 419 of the final 1424, which comes to 29.4 percent. In odds that is about 2.4 to 1. With at least that much equity the call is fine over time.',
    );
    expect(p.proof).toMatchObject({ river_action: 'bet', pot: 586, bet: 419, call: 419, pot_after_bet: 1005, final_pot: 1424, required_pct: 29.4, ratio_to_one: 2.4, decoys: { bet_over_pot: 72, bet_over_pot_plus_bet: 42, half: 15 } });
    expect(p.rewardable).toBe(true);
  });

  it('calls a river all in a shove', () => {
    const p = ok('pot_odds', row({ actions: [...TO_RIVER, act(5, HORSE, 'river', 'check', 0, 586, 0), act(9, VILLAIN, 'river', 'all_in', 419, 586, 0), act(5, HORSE, 'river', 'fold', 0, 1005, 419)] }));
    expect(p.prompt).toContain('There is 586 in the pot and I am facing a shove of 419.');
    expect(p.proof).toMatchObject({ river_action: 'all_in', call: 419 });
  });

  it('reads a raise over the horse bet exactly: the chips added, the chips to call, and the pot before', () => {
    const actions = [...TO_RIVER, act(5, HORSE, 'river', 'bet', 100, 586, 0), act(9, VILLAIN, 'river', 'raise', 300, 686, 100), act(5, HORSE, 'river', 'call', 200, 986, 300)];
    const p = ok('pot_odds', row({ actions }));
    expect(p.prompt).toContain('I had 100 in on the river and got raised. The pot is 986 and it is 200 to call.');
    // 200 / (686 + 300 + 200) = 16.9 percent; (686 + 300) / 200 = 4.9 to 1.
    expect(correctLabel(p)).toBe('17 percent, about 4.9 to 1');
    expect(p.proof).toMatchObject({ pot: 686, bet: 300, call: 200, required_pct: 16.9 });
  });

  it('picks the largest bet the horse actually answered, never one after its last action', () => {
    const actions = [
      ...TO_RIVER,
      act(5, HORSE, 'river', 'check', 0, 586, 0),
      act(9, VILLAIN, 'river', 'bet', 50, 586, 0),
      act(5, HORSE, 'river', 'call', 50, 636, 50),
      act(3, 'fake-third-seat', 'river', 'raise', 900, 686, 50),
    ];
    const p = ok('pot_odds', row({ actions }));
    expect(p.proof).toMatchObject({ pot: 586, bet: 50, call: 50 });
  });

  it('rejects a river with no bet faced, decoys that collapse, and decoys out of range', () => {
    expect(rejected('pot_odds', row({ actions: [...TO_RIVER, act(5, HORSE, 'river', 'check', 0, 586, 0), act(9, VILLAIN, 'river', 'check', 0, 586, 0)] }))).toBe('no_river_bet_faced');
    expect(rejected('pot_odds', row({ actions: [...TO_RIVER, act(5, HORSE, 'river', 'bet', 100, 586, 0), act(9, VILLAIN, 'river', 'call', 100, 686, 100)] }))).toBe('no_river_bet_faced');
    expect(rejected('pot_odds', row({ actions: [...TO_RIVER, act(5, HORSE, 'river', 'check', 0, 1000, 0), act(9, VILLAIN, 'river', 'bet', 1, 1000, 0), act(5, HORSE, 'river', 'call', 1, 1001, 1)] }))).toBe('decoys_not_distinct');
    expect(rejected('pot_odds', row({ actions: [...TO_RIVER, act(5, HORSE, 'river', 'check', 0, 500, 0), act(9, VILLAIN, 'river', 'bet', 2000, 500, 0), act(5, HORSE, 'river', 'call', 2000, 2500, 2000)] }))).toBe('decoy_out_of_range');
    expect(rejected('pot_odds', row({ actions: [...TO_RIVER, act(5, HORSE, 'river', 'check', 0, null, 0), act(9, VILLAIN, 'river', 'bet', 419, null, 0), act(5, HORSE, 'river', 'call', 419, null, 419)] }))).toBe('actions_unreadable');
  });
});

describe('the what would you do puzzle', () => {
  it('shows the horse hand and board, the river spot, four options when facing a bet, and reveals what it did from the row', () => {
    const p = ok('what_would_you_do');
    expect(p.prompt.split('\n')).toEqual([
      'Spot from not long ago in a 2.5/5 cash game.',
      'Hand [[sp-card:Th]][[sp-card:Jc]]',
      'Board [[sp-card:2c]][[sp-card:7c]][[sp-card:Ac]][[sp-card:Qc]][[sp-card:2d]]',
      'On the river there is 1005 in the pot and it is 419 to call. What would you do? I will post what I did in about six hours.',
    ]);
    expect(p.options.map((o) => o.label).sort()).toEqual(['Call', 'Fold', 'Move all in', 'Raise']);
    expect(correctLabel(p)).toBe('Call');
    expect(p.explanation).toBe('I paid it off and the hand went my way, up 58.6 big blinds.');
    expect(p.proof).toMatchObject({ action: 'call', facing: true, pot: 1005, to_call: 419, net_bb: 58.6, is_win: true });
    expect(p.rewardable).toBe(false);
    expect(p.reveal_hours).toBe(6);
  });

  it('offers check, bet or move all in when nothing is bet, and tells a loss or a missing result honestly', () => {
    const open = [...TO_RIVER, act(9, VILLAIN, 'river', 'check', 0, 586, 0), act(5, HORSE, 'river', 'bet', 300, 586, 0), act(9, VILLAIN, 'river', 'fold', 0, 886, 300)];
    const p = ok('what_would_you_do', row({ actions: open, net_bb: -41.2, is_win: false }));
    expect(p.prompt).toContain('On the river there is 586 in the pot and it is on me to act. What would you do?');
    expect(p.options.map((o) => o.label).sort()).toEqual(['Bet', 'Check', 'Move all in']);
    expect(correctLabel(p)).toBe('Bet');
    expect(p.explanation).toBe('I fired and it went the other way, down 41.2 big blinds.');

    const shove = [...TO_RIVER, act(5, HORSE, 'river', 'check', 0, 586, 0), act(9, VILLAIN, 'river', 'bet', 419, 586, 0), act(5, HORSE, 'river', 'all_in', 1000, 1005, 419)];
    const q = ok('what_would_you_do', row({ actions: shove, net_bb: null, is_win: null }));
    expect(correctLabel(q)).toBe('Move all in');
    expect(q.explanation).toBe('I shoved the rest in and that was the hand.');

    const fold = [...TO_RIVER, act(5, HORSE, 'river', 'check', 0, 586, 0), act(9, VILLAIN, 'river', 'bet', 419, 586, 0), act(5, HORSE, 'river', 'fold', 0, 1005, 419)];
    const f = ok('what_would_you_do', row({ actions: fold, net_bb: -57.6, is_win: null }));
    expect(correctLabel(f)).toBe('Fold');
    expect(f.explanation).toBe('I let it go and finished the hand down 57.6 big blinds.');
  });

  it('rejects a hand the horse left before the river, one it was all in for, and unreadable hole cards', () => {
    const foldedTurn = [...TO_RIVER.slice(0, 7), act(5, HORSE, 'turn', 'fold', 0, 70, 0), act(9, VILLAIN, 'river', 'bet', 10, 70, 0)];
    expect(rejected('what_would_you_do', row({ actions: foldedTurn }))).toBe('no_river_decision');
    const allInTurn = [...TO_RIVER.slice(0, 7), act(5, HORSE, 'turn', 'all_in', 900, 70, 0), act(9, VILLAIN, 'turn', 'call', 900, 970, 900)];
    expect(rejected('what_would_you_do', row({ actions: allInTurn }))).toBe('no_river_decision');
    expect(rejected('pot_odds', row({ actions: allInTurn }))).toBe('no_river_bet_faced');
    expect(rejected('what_would_you_do', row({ hole_cards: [w('T', 'hearts')] }))).toBe('hole_cards_unreadable');
    expect(rejected('what_would_you_do', row({ actions: [] }))).toBe('actions_unreadable');
    expect(rejected('what_would_you_do', row({ actions: 'nope' }))).toBe('actions_unreadable');
  });
});

describe('rejections every kind shares', () => {
  it('names the reason: variant, board size, unreadable board, quads or a straight flush on board, missing key or salt', () => {
    for (const kind of PUZZLE_KINDS) {
      expect(rejected(kind, row({ game_variant: 'plo4' })), kind).toBe('variant_not_nlh');
      expect(rejected(kind, row({ board: [w('2', 'clubs'), w('7', 'clubs'), w('A', 'clubs'), w('Q', 'clubs')] })), kind).toBe('board_not_five_cards');
      expect(rejected(kind, row({ board: [w('2', 'clubs'), w('7', 'clubs'), w('A', 'clubs'), w('Q', 'clubs'), w('2', 'stars')] })), kind).toBe('board_unreadable');
      expect(rejected(kind, row({ board: null })), kind).toBe('board_unreadable');
      expect(rejected(kind, row({ hand_id: '' })), kind).toBe('hand_id_missing');
      expect(rejected(kind, row(), ''), kind).toBe('salt_missing');
      expect(rejected(kind, row({ played_at: 'yesterday-ish' })), kind).toBe('played_at_unreadable');
    }
    expect(rejected('nuts', row({ board: [w('2', 'clubs'), w('2', 'diamonds'), w('2', 'hearts'), w('2', 'spades'), w('A', 'hearts')] }))).toBe('nuts_on_board');
    expect(rejected('nuts', row({ board: [w('9', 'hearts'), w('8', 'hearts'), w('7', 'hearts'), w('6', 'hearts'), w('5', 'hearts')] }))).toBe('nuts_on_board');
    expect(rejected('unknown' as PuzzleKind, row())).toBe('unknown_kind');
  });
});

describe('the committed answer and deterministic placement', () => {
  it('commits sha256(key:correct:salt) exactly as Postgres encode(sha256(...), hex) does', () => {
    // Vector computed with: select encode(sha256(('p7:nuts:1111...' || ':' || 'C' || ':' || salt)::bytea), 'hex') on 2026-09-30.
    expect(commitmentFor('p7:nuts:11111111-2222-4333-8444-555555555555', 'C', SALT)).toBe('18300a27d9e1de0fdd7d540fb59d9829bdff87bc5c0ab88caf1ffd425b67cfab');
    const p = ok('nuts');
    expect(p.answer_commitment).toBe(commitmentFor(p.puzzle_key, p.correct_option, p.salt));
    expect(p.answer_commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(ok('nuts', row(), 'another-salt').answer_commitment).not.toBe(p.answer_commitment);
    expect(puzzleKey('pot_odds', HAND)).toBe(`p7:pot_odds:${HAND}`);
  });

  it('places the correct option from the key alone: the same key gives the same order, other keys move it', () => {
    const a = ok('nuts');
    const b = ok('nuts', row(), 'a-different-salt-does-not-move-the-answer');
    expect(b.options).toEqual(a.options);
    expect(b.correct_option).toBe(a.correct_option);
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const p = ok('nuts', row({ hand_id: `bbbbbbbb-0000-4000-8000-0000000000${String(i).padStart(2, '0')}` }));
      seen.add(p.correct_option);
      expect(p.options.map((o) => o.key)).toEqual(['A', 'B', 'C', 'D']);
    }
    expect(seen.size).toBeGreaterThan(1);
    expect(correctPosition('p7:nuts:x', 4)).toBe(correctPosition('p7:nuts:x', 4));
    expect(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => correctPosition(`p7:nuts:${i}`, 4))).size).toBeGreaterThan(1);
  });
});

describe('what never leaves the module', () => {
  const ALLOWED_CAPITALS = new Set(['Board', 'Hand', 'Went', 'Spot', 'There', 'The', 'On', 'What', 'How', 'In', 'Next', 'Calling', 'With', 'I', 'Fold', 'Call', 'Raise', 'Move', 'Check', 'Bet']);
  const texts = (p: ComposedPuzzle): string[] => [p.prompt, p.explanation, ...p.options.map((o) => o.label)];
  const variants: Array<[PuzzleKind, PuzzleReviewRow]> = [
    ['nuts', row()],
    ['nuts', row({ format: 'tournament', big_blind: 400, played_at: '2026-09-29T08:00:00Z' })],
    ['pot_odds', row()],
    ['pot_odds', row({ actions: [...TO_RIVER, act(5, HORSE, 'river', 'bet', 100, 586, 0), act(9, VILLAIN, 'river', 'all_in', 300, 686, 100), act(5, HORSE, 'river', 'call', 200, 986, 300)] })],
    ['what_would_you_do', row()],
    ['what_would_you_do', row({ actions: [...TO_RIVER, act(9, VILLAIN, 'river', 'check', 0, 586, 0), act(5, HORSE, 'river', 'check', 0, 586, 0)], net_bb: 12, is_win: true })],
    ['what_would_you_do', row({ actions: [...TO_RIVER, act(5, HORSE, 'river', 'bet', 100, 586, 0), act(9, VILLAIN, 'river', 'raise', 300, 686, 100), act(5, HORSE, 'river', 'raise', 900, 986, 300), act(9, VILLAIN, 'river', 'fold', 0, 1786, 900)] })],
  ];

  it('a user id planted in the action log reaches no prompt, option, explanation, proof or field of the puzzle', () => {
    for (const [kind, r] of variants) {
      const p = ok(kind, r);
      const blob = JSON.stringify(p);
      expect(blob, kind).not.toContain(VILLAIN);
      expect(blob, kind).not.toContain('deadbeef');
      expect(blob, kind).not.toContain('fake-third-seat');
      for (const t of texts(p)) expect(t, kind).not.toContain(HORSE);
    }
  });

  it('the prompt never names the correct option and the explanation never repeats its label', () => {
    for (const [kind, r] of variants) {
      const p = ok(kind, r);
      const correct = correctLabel(p);
      expect(p.prompt, kind).not.toContain(correct);
      expect(p.explanation.toLowerCase(), `${kind}: ${p.explanation}`).not.toContain(correct.toLowerCase());
      for (const o of p.options) expect(p.prompt, kind).not.toContain(o.label);
      expect(p.prompt, kind).toMatch(/six hours\.$/);
      expect(new Set(p.options.map((o) => o.label)).size).toBe(p.options.length);
      expect(p.options.length).toBeGreaterThanOrEqual(2);
      expect(p.options.length).toBeLessThanOrEqual(4);
    }
  });

  it('every template and every composed line: no emoji, no U+2013 or U+2014, no at sign, no name, and only the row numbers', () => {
    const lines = [...TEMPLATE_POOL];
    for (const [kind, r] of variants) lines.push(...texts(ok(kind, r)));
    expect(lines.length).toBeGreaterThan(40);
    for (const line of lines) {
      expect(line).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(line).not.toMatch(/[–—@]/);
      expect(line).not.toMatch(/\bbot\b/i);
      const plain = line.replace(/\[\[sp-card:[2-9TJQKA][cdhs]\]\]/g, '');
      for (const word of plain.match(/\b[A-Z][a-z]+\b/g) ?? []) {
        expect(ALLOWED_CAPITALS.has(word), `"${word}" in "${line}"`).toBe(true);
      }
    }
    // The numbers a puzzle states are the row's: pot 586, bet 419, the pot after 1005 and the final 1424, the net 58.6, the stake 2.5/5, the count 1081 and 3.
    const numbers = (s: string) => s.replace(/\[\[sp-card:[2-9TJQKA][cdhs]\]\]/g, '').match(/\d+(?:\.\d+)?/g);
    const nuts = ok('nuts');
    const odds = ok('pot_odds');
    const did = ok('what_would_you_do');
    expect(numbers(nuts.prompt)).toEqual(['2.5', '5']);
    expect(numbers(nuts.explanation)).toEqual(['1', '1081', '3']);
    expect(numbers(odds.prompt)).toEqual(['2.5', '5', '586', '419']);
    expect(numbers(did.prompt)).toEqual(['2.5', '5', '1005', '419']);
    expect(numbers(did.explanation)).toEqual(['58.6']);
  });
});
