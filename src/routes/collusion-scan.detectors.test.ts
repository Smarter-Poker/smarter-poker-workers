import { describe, it, expect } from 'vitest';
import { __testing } from './collusion-scan.js';

/**
 * The three detectors that were not touched by the 2026-09-04 WIN_RATE_ANOMALY
 * rework. Measured against collusion_tracking on 2026-09-05, every row ever
 * written by this scan:
 *
 *   WIN_RATE_ANOMALY   169,509   (the saturation, since fixed)
 *   TIMING_CORRELATION     910   none ever reviewed
 *   CHIP_DUMP               22   in four months
 *   SOFT_PLAY                0   <- not a low number. Zero. Ever.
 *
 * SOFT_PLAY read `a.street`; the engine writes `stage`, so its postflop filter
 * was always empty and every hand hit the continue. CHIP_DUMP divided by every
 * shared hand rather than by the pots one of the pair actually won, so at a
 * six-handed table its ratio could not exceed ~0.17 against a 0.8 bar.
 * TIMING_CORRELATION used `(ratio - 0.15) / 0.08` - constants, not a z-score,
 * not scaling with sample size - which evaluated to exactly its own threshold
 * and therefore tested nothing.
 */

const {
  scanChipDump,
  scanSoftPlay,
  scanTimingCorrelation,
  SOFT_PLAY_MIN_Z,
  TIMING_MIN_Z,
} = __testing;

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const C = 'cccccccc-0000-0000-0000-000000000003';
const D = 'dddddddd-0000-0000-0000-000000000004';

let seq = 0;
/** A hand as the PRODUCTION row looks: actions carry `stage`, never `street`. */
function hand(opts: {
  players: string[];
  winner?: string;
  potBb?: number;
  postflop?: Array<{ who: string; action: string }>;
}) {
  seq += 1;
  const actions = [
    ...opts.players.map((id) => ({ userId: id, stage: 'preflop', action: 'call', amount: 2 })),
    ...(opts.postflop ?? []).map((a) => ({ userId: a.who, stage: 'flop', action: a.action })),
  ];
  return {
    id: `h-${seq}`,
    table_id: 't1',
    hand_number: seq,
    started_at: null,
    ended_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    players: opts.players.map((id, i) => ({ userId: id, seat: i + 1 })),
    winners: opts.winner ? [{ userId: opts.winner }] : [],
    actions,
    pot_size: (opts.potBb ?? 20) * 2,
    big_blind: 2,
    small_blind: 1,
  };
}

/**
 * A pot checked down. TWO streets of checks, because the detector wants at
 * least three check actions and no aggression - a single street between two
 * players is only two checks, which is not yet a checked-down pot.
 */
const checkdown = (players: string[], winner: string) =>
  hand({
    players,
    winner,
    postflop: [
      ...players.map((who) => ({ who, action: 'check' })),
      ...players.map((who) => ({ who, action: 'check' })),
    ],
  });

describe('scanSoftPlay', () => {
  it('reads stage, so it is capable of producing a finding at all', () => {
    /**
     * The whole bug in one assertion: reading `street`, this returned [] on
     * every input forever.
     *
     * The room matters. This detector compares a pair against the
     * POPULATION's checkdown rate, so a fixture containing only the
     * softplaying pair has a baseline of 1.0 and correctly flags nobody -
     * a pair cannot stand out from itself. C and D contest normally here,
     * which is what gives A and B something to stand out from.
     */
    const hands = [
      ...Array.from({ length: 40 }, () => checkdown([A, B], A)),
      ...Array.from({ length: 160 }, () =>
        hand({
          players: [C, D],
          winner: C,
          postflop: [
            { who: C, action: 'bet' },
            { who: D, action: 'call' },
          ],
        }),
      ),
    ];
    const findings = scanSoftPlay(hands as never);
    const ab = findings.find(
      (f) => (f.player_a === A && f.player_b === B) || (f.player_a === B && f.player_b === A),
    );
    expect(ab, 'a pair checking down every pot in a betting room must flag').toBeDefined();
  });

  it('does not credit a checkdown to players who were not in the pot', () => {
    // A and B check it down; C and D folded preflop and never acted postflop.
    // The old code credited every pair at the table, C-D included.
    const hands = Array.from({ length: 60 }, () =>
      hand({
        players: [A, B, C, D],
        winner: A,
        postflop: [
          { who: A, action: 'check' },
          { who: B, action: 'check' },
          { who: A, action: 'check' },
          { who: B, action: 'check' },
        ],
      }),
    );
    const findings = scanSoftPlay(hands as never);
    const cd = findings.find(
      (f) =>
        (f.player_a === C && f.player_b === D) || (f.player_a === D && f.player_b === C),
    );
    expect(cd, 'C and D never saw a flop together and cannot have softplayed').toBeUndefined();
  });

  it('a pair that bets and raises is not softplaying', () => {
    const hands = Array.from({ length: 60 }, () =>
      hand({
        players: [A, B],
        winner: A,
        postflop: [
          { who: A, action: 'bet' },
          { who: B, action: 'raise' },
          { who: A, action: 'call' },
        ],
      }),
    );
    expect(scanSoftPlay(hands as never)).toHaveLength(0);
  });

  it('a passive room does not make everyone a suspect', () => {
    // EVERY pair checks down at the same rate. Nobody stands out from the
    // population, so nobody is flagged - the old raw-count bar flagged them all.
    const seats = [A, B, C, D];
    const hands = Array.from({ length: 200 }, (_, i) => checkdown(seats, seats[i % 4]!));
    expect(scanSoftPlay(hands as never)).toHaveLength(0);
  });

  it('uses the folded fields when the read has dropped actions', () => {
    /**
     * THE WIRING TRAP. The page fold sets `actions: null` on the slim record,
     * so a detector that reads h.actions after the read sees nothing. Fixing
     * the `street` bug alone would have left SOFT_PLAY dead for this second,
     * quieter reason. This pins that the detector reads what the fold left.
     */
    const hands = [
      ...Array.from({ length: 40 }, (_, i) => ({
        ...checkdown([A, B], A),
        actions: null,
        postflopLive: [A, B],
        checkdown: true,
        id: `folded-${i}`,
      })),
      // The room, folded the same way.
      ...Array.from({ length: 160 }, (_, i) => ({
        ...checkdown([C, D], C),
        actions: null,
        postflopLive: [C, D],
        checkdown: false,
        id: `folded-room-${i}`,
      })),
    ];
    const findings = scanSoftPlay(hands as never);
    const ab = findings.find(
      (f) => (f.player_a === A && f.player_b === B) || (f.player_a === B && f.player_b === A),
    );
    expect(ab, 'the detector must read postflopLive/checkdown, not h.actions').toBeDefined();
  });

  it('reports the population rate beside the pair rate', () => {
    const hands = [
      ...Array.from({ length: 40 }, () => checkdown([A, B], A)),
      ...Array.from({ length: 160 }, () =>
        hand({
          players: [C, D],
          winner: C,
          postflop: [
            { who: C, action: 'bet' },
            { who: D, action: 'call' },
          ],
        }),
      ),
    ];
    const f = scanSoftPlay(hands as never)[0];
    expect(f).toBeDefined();
    expect(f!.evidence).toHaveProperty('population_rate');
    expect(f!.evidence).toHaveProperty('contested_pots');
    expect(f!.evidence).toHaveProperty('threshold_z', SOFT_PLAY_MIN_Z);
  });
});

describe('scanChipDump', () => {
  it('catches a dumper at a full table, where the old denominator could not', () => {
    // A and B are 2 of 4 seats. B wins 95% of the pots that either of them
    // takes - but only ~48% of ALL hands, so the old `/total` ratio maxed out
    // far below the 0.8 bar and this never fired away from heads-up.
    const hands = [];
    for (let i = 0; i < 60; i++) {
      const winner = i % 20 === 0 ? A : B; // B takes 19 of every 20
      hands.push(hand({ players: [A, B, C, D], winner }));
    }
    const f = scanChipDump(hands as never).find(
      (x) => x.player_a === A && x.player_b === B,
    );
    expect(f, 'a 95% one-way split between two seats must flag').toBeDefined();
    expect(Number(f!.evidence.loser_loss_ratio)).toBeGreaterThan(0.9);
  });

  it('an even game between the pair is not a dump', () => {
    const hands = [];
    for (let i = 0; i < 120; i++) {
      hands.push(hand({ players: [A, B, C, D], winner: [A, B, C, D][i % 4]! }));
    }
    expect(scanChipDump(hands as never)).toHaveLength(0);
  });

  it('needs enough head-to-head pots, not just enough shared hands', () => {
    // 60 shared hands but C wins almost all of them: A and B have too few
    // pots between them to say anything, however lopsided those few were.
    const hands = [];
    for (let i = 0; i < 60; i++) {
      hands.push(hand({ players: [A, B, C], winner: i % 30 === 0 ? B : C }));
    }
    const f = scanChipDump(hands as never).find(
      (x) =>
        (x.player_a === A && x.player_b === B) || (x.player_a === B && x.player_b === A),
    );
    expect(f).toBeUndefined();
  });
});

describe('scanTimingCorrelation', () => {
  const act = (handId: string, user: string, ms: number) => ({
    id: `${handId}:${user}:${ms}`,
    table_id: 't1',
    hand_id: handId,
    user_id: user,
    created_at: new Date(ms).toISOString(),
    street: 'preflop',
    action: 'call',
  });

  it('does not flag a uniformly fast room', () => {
    // Every pair acts inside 500ms - which is what a fleet of horses on a
    // timer looks like. Under the old constant baseline of 0.15 this flagged
    // every pair in the room; 910 unreviewed rows is what that produced.
    const rows = [];
    for (let h = 0; h < 60; h++) {
      const t = h * 100_000;
      rows.push(act(`h${h}`, A, t), act(`h${h}`, B, t + 100), act(`h${h}`, C, t + 200));
    }
    expect(scanTimingCorrelation(rows as never)).toHaveLength(0);
  });

  it('flags a pair that is fast in a room that is not', () => {
    const rows = [];
    // A-B always inside 500ms; every other pair takes seconds.
    for (let h = 0; h < 80; h++) {
      const t = h * 1_000_000;
      rows.push(act(`h${h}`, A, t), act(`h${h}`, B, t + 120));
      rows.push(act(`h${h}`, C, t + 9_000), act(`h${h}`, D, t + 18_000));
    }
    const f = scanTimingCorrelation(rows as never).find(
      (x) =>
        (x.player_a === A && x.player_b === B) || (x.player_a === B && x.player_b === A),
    );
    expect(f, 'a genuinely correlated pair must still surface').toBeDefined();
    expect(Number(f!.evidence.z_score)).toBeGreaterThanOrEqual(TIMING_MIN_Z);
    expect(f!.evidence).toHaveProperty('population_rate');
  });
});
