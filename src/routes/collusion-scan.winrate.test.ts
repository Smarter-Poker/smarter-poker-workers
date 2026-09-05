import { describe, it, expect } from 'vitest';
import { __testing } from './collusion-scan.js';

/**
 * WIN_RATE_ANOMALY, after the 2026-09-04 rewrite.
 *
 * This file replaces collusion-scan.horse-filter.test.ts, which pinned the
 * horse-vs-horse suppression. That suppression was an is_horse exclusion and
 * CLAUDE.md 10.5 does not allow one; PHASE5-CONTRACTS section 0 rule 4 names
 * this detector as the exact place the temptation would arise. The filter was
 * also treating a symptom: the detector flagged 63% of all eligible pairs
 * because it credited whole multiway pots to every pair the winner sat in and
 * then compared that inflated number to a fixed bb/100 line.
 *
 * So the tests that matter are no longer "are horses dropped" but:
 *
 *   1. a REAL dumper is caught (the bar is not just a way of saying no);
 *   2. ordinary winning and losing does NOT trip it, at volumes where the old
 *      rule fired constantly;
 *   3. nothing anywhere depends on who the player is.
 */

const { scanWinRateAnomaly, WIN_RATE_MIN_Z, WIN_RATE_MIN_SHARED_HANDS } = __testing;

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const C = '33333333-3333-3333-3333-333333333333';
const D = '44444444-4444-4444-4444-444444444444';

let seq = 0;
function hand(playerIds: string[], winner: string, potBb: number) {
  seq += 1;
  return {
    id: `hand-${seq}`,
    table_id: 'table-1',
    hand_number: seq,
    started_at: null,
    ended_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    players: playerIds.map((id, i) => ({ userId: id, seat: i + 1 })),
    winners: [{ userId: winner }],
    actions: [],
    pot_size: potBb * 2,
    big_blind: 2,
    small_blind: 1,
  };
}

/** Deterministic pseudo-random so a rerun cannot flake. */
function makeRng(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

describe('scanWinRateAnomaly', () => {
  it('catches a pair shipping chips one way', () => {
    // A loses to B in 80% of their hands together. This is what the detector
    // exists for, and it must clear the bar comfortably rather than scrape it.
    const hands = [];
    const rng = makeRng(7);
    for (let i = 0; i < 60; i++) {
      hands.push(hand([A, B, C, D], rng() < 0.8 ? B : A, 20));
    }
    const findings = scanWinRateAnomaly(hands as never);
    const ab = findings.find(
      (f) => (f.player_a === A && f.player_b === B) || (f.player_a === B && f.player_b === A),
    );
    expect(ab, 'a pair losing 80% of shared pots one way must be flagged').toBeDefined();
    expect(ab!.player_a).toBe(A); // loser first
    expect(ab!.player_b).toBe(B);
    expect(Number(ab!.evidence.z_score)).toBeGreaterThan(WIN_RATE_MIN_Z);
  });

  it('does not flag an even game at a volume where the old rule always fired', () => {
    // Four players, pots won at random, 400 hands. Under the retired rule
    // (|bb/100| >= 80 over >= 30 hands, whole pot per pair) a table like this
    // produced findings on essentially every pair.
    const hands = [];
    const rng = makeRng(11);
    const seats = [A, B, C, D];
    for (let i = 0; i < 400; i++) {
      hands.push(hand(seats, seats[Math.floor(rng() * 4)]!, 15 + Math.floor(rng() * 25)));
    }
    expect(scanWinRateAnomaly(hands as never)).toHaveLength(0);
  });

  it('does not flag a genuinely better player who is merely winning', () => {
    // B wins 35% against three opponents at 25% expectation - a real edge, and
    // not evidence of anything. The old fixed line could not tell these apart.
    const hands = [];
    const rng = makeRng(23);
    for (let i = 0; i < 300; i++) {
      const r = rng();
      const winner = r < 0.35 ? B : r < 0.57 ? A : r < 0.79 ? C : D;
      hands.push(hand([A, B, C, D], winner, 20));
    }
    const findings = scanWinRateAnomaly(hands as never);
    expect(findings).toHaveLength(0);
  });

  it('needs the shared-hand floor before it says anything at all', () => {
    const hands = [];
    for (let i = 0; i < WIN_RATE_MIN_SHARED_HANDS - 1; i++) {
      hands.push(hand([A, B, C, D], B, 20)); // maximally lopsided
    }
    expect(scanWinRateAnomaly(hands as never)).toHaveLength(0);
  });

  it('splits a multiway pot across the winner\'s opponents rather than charging each in full', () => {
    // One 30bb pot won by B at a four-handed table is 10bb from each of the
    // three opponents, not 30bb from each. Pinning the arithmetic directly,
    // because this is the defect that inflated every pair on the platform.
    const hands = [];
    for (let i = 0; i < 40; i++) hands.push(hand([A, B, C, D], B, 30));
    const findings = scanWinRateAnomaly(hands as never);
    const ab = findings.find((f) => f.player_a === A && f.player_b === B);
    expect(ab, 'a pure 40-hand sweep is real signal and must flag').toBeDefined();
    // 40 hands x 10bb each = 400bb, not 1200bb.
    expect(Number(ab!.evidence.net_bb)).toBeCloseTo(400, 0);
    expect(Number(ab!.evidence.bb_per_100)).toBeCloseTo(1000, 0);
  });

  it('reports the z score and the threshold, so a score is not a verdict', () => {
    // PHASE5-CONTRACTS section 0 rule 3: a queue must say what it filtered and
    // why. An operator has to be able to see how far past the bar a row is.
    const hands = [];
    for (let i = 0; i < 40; i++) hands.push(hand([A, B, C, D], B, 30));
    const f = scanWinRateAnomaly(hands as never)[0]!;
    expect(f.evidence).toHaveProperty('z_score');
    expect(f.evidence).toHaveProperty('threshold_z', WIN_RATE_MIN_Z);
    expect(f.evidence).toHaveProperty('hands_together');
    expect(String(f.evidence.method)).toMatch(/split/i);
  });
});
