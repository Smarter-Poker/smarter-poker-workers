/**
 * GET/POST /cron/collusion-scan
 *
 * Ported from pages/api/cron/collusion-scan.js (410 lines).
 *
 * Nightly 03:30 UTC: scan last 24h of hand_history + action_log for
 * suspicious player-pair patterns. Writes findings to collusion_tracking
 * with status='open' for human review.
 *
 * Patterns, all four rebuilt 2026-09-04/05. Every one of them now measures a
 * pair against the POPULATION THIS WINDOW ACTUALLY CONTAINS, at four standard
 * errors, rather than against a constant somebody typed. The constants were
 * the common defect: three of the four were provably broken and the fourth
 * flagged 63% of everybody.
 *
 *   CHIP_DUMP          — share of the pots WON BY EITHER of the pair that went
 *                        one way (≥80% over ≥15 head-to-head pots). Was
 *                        dividing by every shared hand, so at six-handed the
 *                        ratio could not exceed ~0.17 against a 0.8 bar: 22
 *                        rows in four months, all heads-up.
 *   SOFT_PLAY          — checkdowns over pots the pair BOTH contested
 *                        postflop, against the population's checkdown rate.
 *                        Read `a.street`, which the engine never writes, so it
 *                        produced ZERO rows in its entire life.
 *   TIMING_CORRELATION — share of adjacent actions inside 500ms, against the
 *                        population's own rate. Was `(ratio - 0.15) / 0.08`:
 *                        constants, not scaling with n, evaluating to exactly
 *                        its own threshold, so the significance test was a
 *                        no-op. 910 rows since 2026-08-28, none ever reviewed.
 *   WIN_RATE_ANOMALY   — pot split across the winner's opponents, flagged at
 *                        ≥4 standard errors from zero. Was whole-pot-per-pair
 *                        against a fixed bb/100 line: 169,509 rows.
 *
 * (CONCURRENT_IP from the original spec is documented but not implemented
 * in the JS source — preserved verbatim, no port needed.)
 *
 * Idempotence: insert-only into collusion_tracking. Same window + same
 * data produces the same findings, so re-runs may double-insert. Source
 * comment claims dedupe via upsert on tuple — actual JS uses .insert()
 * straight. Ported at parity (still .insert()).
 *
 * Auth: /cron/* middleware chain.
 *
 * WHAT ONE RUN NOW SEES, AND WHAT THAT COSTS (2026-09-04)
 * ------------------------------------------------------
 * The scheduled path no longer reads a rolling 24 hours. It resumes from
 * `ca_collusion_scan_state` and covers only what has happened since the last
 * run - about thirty minutes - which is the whole reason it completes at all
 * now. Every threshold above ("over >=15 hands", ">=30 hands together") counts
 * hands a pair shared INSIDE ONE RUN'S WINDOW, and those numbers were chosen
 * when one window was a day.
 *
 * So the detector is less sensitive than it was, in a specific and stateable
 * way: a pair that shares 40 hands spread evenly over an evening never has 30
 * of them inside a single run, and nothing aggregates a pair across runs yet.
 * Pairs playing a long session at one table - which is what every one of the
 * 18 CHIP_DUMP rows looks like - still trigger.
 *
 * That is disclosed rather than hidden: the response carries
 * `detection_span_minutes` and `detection_thresholds.aggregates_across_runs:
 * false`, and the console renders it. Closing it properly means a rolling
 * per-pair counter table so a signal can accumulate across runs, which is
 * Phase 5 detector work and is written down in PHASE5-CONTRACTS section 1
 * rather than left as an unstated regression.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { resolveScanWindow, ScanWindowError } from '../lib/scanWindow.js';
import { pagedSelectKeyset } from '../lib/pagedSelectKeyset.js';
import { withDeadline } from '../lib/withDeadline.js';
import {
  advanceScanState,
  readScanState,
  windowFromState,
  MAX_SPAN_HOURS,
} from '../lib/collusionScanState.js';

/**
 * The rolling default, kept ONLY for an explicit ?since=/?until= call that
 * omits one side. The scheduled path no longer uses a rolling window at all -
 * it resumes from ca_collusion_scan_state - because a 30-minute cron over a
 * 24-hour window re-read every hand 48 times, and at 770,000 hands a day that
 * stopped returning entirely. See src/lib/collusionScanState.ts.
 */
const WINDOW_HOURS = 24;

/**
 * Row ceiling for one run. Unchanged in spirit, lower in fact: with an
 * incremental window a normal run reads ~15,000 hands, and this is the guard
 * against a catch-up run trying to read a whole span at once.
 */
const MAX_SCAN_HANDS = 40_000;

/**
 * Wall-clock budget for the READ phase.
 *
 * The dispatcher's client timeout is 120s and it does NOT cancel the worker,
 * so a run that overruns is invisible until the container's stale sweeper
 * marks it `killed` thirty minutes later. Ninety seconds leaves room for the
 * analysis and the writes inside that 120s, and a run that hits it returns a
 * HONEST PARTIAL result instead of never returning.
 */
const READ_BUDGET_MS = 90_000;

/**
 * Ceiling for every call the scan makes that the read budget does NOT cover.
 *
 * The read was budgeted and reported; the horse lookup, the findings insert
 * and the advance were not, so any one of them could hang the handler with no
 * error and no clue which it was. Measured against this workload the slowest
 * of them is a 300-id profiles lookup at 695ms, so thirty seconds is a wide
 * margin and still well inside the dispatcher's 120s client timeout.
 */
const CALL_DEADLINE_MS = 30_000;
const MIN_HANDS_FOR_SIGNAL = 15;
const CHIP_DUMP_LOSS_RATIO = 0.8;

// WIN_RATE_ANOMALY needs a pair to have played enough together for the mean to
// mean anything. Unchanged; it was never the problem.
const WIN_RATE_MIN_SHARED_HANDS = 30;

// ...and it needs the observed flow to be far enough from zero RELATIVE TO THAT
// PAIR'S OWN VARIANCE. Four sigma, and the reason is multiple comparisons: a
// normal 24h window yields ~3,500 pairs over the shared-hand gate, so a 3-sigma
// bar admits ~9 false positives per run by construction and a 4-sigma bar
// admits ~0.2. An integrity queue is read by a human, and a queue that cries
// wolf nine times a run is one nobody opens - PHASE5-CONTRACTS section 0 rule 3.
const WIN_RATE_MIN_Z = 4;

// SOFT_PLAY and TIMING_CORRELATION are the same shape of test - a pair's rate
// against the population's own rate - so they take the same bar for the same
// multiple-comparisons reason.
const SOFT_PLAY_MIN_Z = 4;
const TIMING_MIN_Z = 4;

interface PlayerSeat {
  user_id?: string;
  userId?: string;
  id?: string;
}

interface HandAction {
  /** The engine writes `stage`. `street` is accepted for older rows only. */
  stage?: string;
  street?: string;
  action?: string;
  userId?: string;
  user_id?: string;
}

/**
 * The street of an action. hand_history.actions[] carries `stage`, NEVER
 * `street`: measured 2026-09-05 over 3,000 consecutive production hands, 3,000
 * matched stage and zero matched street. scanSoftPlay read `a.street`, so its
 * postflop filter was always empty, every hand hit the `continue`, and the
 * detector has produced EXACTLY ZERO ROWS in its entire life - confirmed
 * against collusion_tracking, which holds WIN_RATE_ANOMALY, TIMING_CORRELATION
 * and CHIP_DUMP rows and not one SOFT_PLAY.
 */
function streetOf(a: HandAction | undefined): string {
  return (a?.stage ?? a?.street ?? '') as string;
}

function actorOf(a: HandAction | undefined): string | undefined {
  return a?.userId ?? a?.user_id;
}

interface HandRow {
  id: string;
  table_id: string | null;
  hand_number: number | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  players: PlayerSeat[] | null;
  winners: PlayerSeat[] | null;
  actions: HandAction[] | null;
  pot_size: number | string | null;
  big_blind: number | string | null;
  small_blind: number | string | null;
  /**
   * DERIVED IN THE PAGE FOLD, because `actions` is dropped there.
   *
   * The fold sets `actions: null` on the slim record - correctly, it is the
   * bulk of the payload - which means any detector reading h.actions after the
   * read sees nothing. scanSoftPlay did exactly that, so fixing its `street`
   * bug alone would have left it just as dead, for a second reason.
   *
   * `postflopLive` is who actually acted after the flop (NOT the seat roster:
   * a pair that both folded preflop has not softplayed anything), and
   * `checkdown` is whether the pot went check-check-check with no aggression.
   * Both are a few bytes per hand against ~850 for the JSONB they replace.
   */
  postflopLive?: string[];
  checkdown?: boolean;
}

interface ActionRow {
  id: string;
  table_id: string | null;
  hand_id: string | null;
  user_id: string | null;
  created_at: string;
  street: string | null;
  action: string | null;
}

interface Finding {
  player_a: string;
  player_b: string;
  pattern_type: 'CHIP_DUMP' | 'SOFT_PLAY' | 'TIMING_CORRELATION' | 'WIN_RATE_ANOMALY';
  suspicion_score: number;
  evidence: Record<string, unknown>;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function extractPlayerIds(handRow: HandRow): string[] {
  if (!handRow.players) return [];
  if (!Array.isArray(handRow.players)) return [];
  return handRow.players
    .map((p) => p?.user_id ?? p?.userId ?? p?.id)
    .filter((id): id is string => !!id);
}

function scanChipDump(hands: HandRow[]): Finding[] {
  interface CDStat {
    a: string;
    b: string;
    aLoses: number;
    bLoses: number;
    total: number;
    potSum: number;
  }
  const pairStats = new Map<string, CDStat>();
  for (const h of hands) {
    const players = extractPlayerIds(h);
    if (players.length < 2) continue;

    const winners = Array.isArray(h.winners) ? h.winners : [];
    const winnerIds = winners
      .map((w) => w?.user_id ?? w?.userId ?? w?.id)
      .filter((id): id is string => !!id);
    if (winnerIds.length !== 1) continue;
    const winner = winnerIds[0]!;

    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const a = players[i]!;
        const b = players[j]!;
        const key = pairKey(a, b);
        const existing = pairStats.get(key);
        const stat: CDStat = existing ?? {
          a: a < b ? a : b,
          b: a < b ? b : a,
          aLoses: 0,
          bLoses: 0,
          total: 0,
          potSum: 0,
        };
        stat.total += 1;
        stat.potSum += Number(h.pot_size ?? 0);
        if (winner === stat.a) stat.bLoses += 1;
        else if (winner === stat.b) stat.aLoses += 1;
        pairStats.set(key, stat);
      }
    }
  }

  const findings: Finding[] = [];
  for (const stat of pairStats.values()) {
    if (stat.total < MIN_HANDS_FOR_SIGNAL) continue;

    /**
     * THE DENOMINATOR IS HEAD-TO-HEAD, NOT EVERY SHARED HAND (fixed
     * 2026-09-05). The ratio used to divide by `total` - every hand the pair
     * sat in together, including the majority won by a third party. At a
     * six-handed table each seat wins roughly a sixth of the pots, so the
     * ratio could not exceed ~0.17 against a 0.8 threshold and CHIP_DUMP was
     * unreachable off heads-up tables: 22 rows in four months, against
     * 169,509 from the detector next to it.
     *
     * The question the pattern is actually asking is "when one of these two
     * takes the pot, how often is it the same one" - so the denominator is
     * the hands one of THEM won. A dumper shows up at any table size now.
     */
    const headToHead = stat.aLoses + stat.bLoses;
    if (headToHead < MIN_HANDS_FOR_SIGNAL) continue;
    const losesA = stat.aLoses / headToHead;
    const losesB = stat.bLoses / headToHead;

    if (losesA >= CHIP_DUMP_LOSS_RATIO || losesB >= CHIP_DUMP_LOSS_RATIO) {
      const dominantLoser = losesA >= losesB ? stat.a : stat.b;
      const dominantWinner = losesA >= losesB ? stat.b : stat.a;
      const ratio = Math.max(losesA, losesB);
      const score = Math.min(100, Math.round(ratio * 100 + (headToHead >= 40 ? 10 : 0)));
      findings.push({
        player_a: dominantLoser,
        player_b: dominantWinner,
        pattern_type: 'CHIP_DUMP',
        suspicion_score: score,
        evidence: {
          hands: stat.total,
          head_to_head_pots: headToHead,
          loser_loss_ratio: Number(ratio.toFixed(3)),
          pot_volume: Number(stat.potSum.toFixed(2)),
          method: 'share of the pots WON BY EITHER of the pair that went one way',
        },
      });
    }
  }
  return findings;
}

/**
 * SOFT_PLAY - two players who keep checking a pot down between them.
 *
 * REWRITTEN 2026-09-05, and it had never run. Three defects, in order of how
 * badly they broke it:
 *
 * 1. IT READ A FIELD THAT DOES NOT EXIST. `a.street` is always undefined, so
 *    `postflopActions` was always empty, every hand hit the continue, and the
 *    detector returned [] on every scan since it was written. Zero SOFT_PLAY
 *    rows exist in collusion_tracking.
 *
 * 2. IT CREDITED A CHECKDOWN TO EVERY PAIR AT THE TABLE, including two players
 *    who both folded preflop and never saw the flop. Soft play is a statement
 *    about two people who were IN the pot together; a pair that was not in it
 *    has not softplayed anything. Only pairs where BOTH acted postflop count.
 *
 * 3. `total` AND `checkdowns` WERE INCREMENTED TOGETHER, so total was a copy of
 *    checkdowns and the ratio it existed to support could only ever be 1. The
 *    denominator now counts every hand the pair contested postflop, so
 *    "checked down 15 of 15" and "checked down 15 of 300" stop being the same
 *    finding.
 *
 * The bar is a ratio AND a count, not a raw count: at 15 shared checkdowns out
 * of 300 contested pots, two nits are being nits. Significance is the same
 * binomial test WIN_RATE_ANOMALY uses, against the population's own checkdown
 * rate rather than a guessed constant.
 */
function scanSoftPlay(hands: HandRow[]): Finding[] {
  interface SPStat {
    a: string;
    b: string;
    checkdowns: number;
    contested: number;
  }
  const pairStats = new Map<string, SPStat>();
  let totalContested = 0;
  let totalCheckdowns = 0;

  for (const h of hands) {
    // Read from the fold, not from h.actions - the read drops the JSONB. See
    // HandRow.postflopLive. Falling back to h.actions keeps this callable
    // directly from a unit test with a full row.
    let live = h.postflopLive;
    let isCheckdown = h.checkdown;
    if (live === undefined || isCheckdown === undefined) {
      const actions = Array.isArray(h.actions) ? h.actions : [];
      const postflopActions = actions.filter((a) =>
        ['flop', 'turn', 'river'].includes(streetOf(a)),
      );
      if (postflopActions.length === 0) continue;
      live = Array.from(
        new Set(postflopActions.map((a) => actorOf(a)).filter((id): id is string => !!id)),
      );
      isCheckdown =
        postflopActions.filter((a) => a.action === 'check').length >= 3 &&
        postflopActions.filter(
          (a) => a.action === 'bet' || a.action === 'raise' || a.action === 'all-in',
        ).length === 0;
    }
    if (!live || live.length < 2) continue;

    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i]!;
        const b = live[j]!;
        const key = pairKey(a, b);
        const stat: SPStat = pairStats.get(key) ?? {
          a: a < b ? a : b,
          b: a < b ? b : a,
          checkdowns: 0,
          contested: 0,
        };
        stat.contested += 1;
        totalContested += 1;
        if (isCheckdown) {
          stat.checkdowns += 1;
          totalCheckdowns += 1;
        }
        pairStats.set(key, stat);
      }
    }
  }

  // The population's own checkdown rate is the baseline. A table full of
  // passive players has a high one, and softplay means standing out FROM the
  // room rather than from a number somebody typed.
  const baseRate = totalContested > 0 ? totalCheckdowns / totalContested : 0;
  const findings: Finding[] = [];
  if (!(baseRate > 0) || baseRate >= 1) return findings;

  for (const stat of pairStats.values()) {
    if (stat.checkdowns < MIN_HANDS_FOR_SIGNAL) continue;
    if (stat.contested < MIN_HANDS_FOR_SIGNAL) continue;
    const rate = stat.checkdowns / stat.contested;
    if (rate <= baseRate) continue;
    const se = Math.sqrt((baseRate * (1 - baseRate)) / stat.contested);
    if (!(se > 0)) continue;
    const z = (rate - baseRate) / se;
    if (z < SOFT_PLAY_MIN_Z) continue;

    findings.push({
      player_a: stat.a,
      player_b: stat.b,
      pattern_type: 'SOFT_PLAY',
      suspicion_score: Math.min(100, Math.round(50 + (z - SOFT_PLAY_MIN_Z) * 10)),
      evidence: {
        mutual_checkdowns: stat.checkdowns,
        contested_pots: stat.contested,
        checkdown_rate: Number(rate.toFixed(3)),
        population_rate: Number(baseRate.toFixed(3)),
        z_score: Number(z.toFixed(2)),
        threshold_z: SOFT_PLAY_MIN_Z,
        method: 'checkdowns over pots the pair BOTH contested postflop, against the population rate',
      },
    });
  }
  return findings;
}

function scanTimingCorrelation(actions: ActionRow[]): Finding[] {
  const byHand = new Map<string, ActionRow[]>();
  for (const a of actions) {
    if (!a.hand_id) continue;
    const arr = byHand.get(a.hand_id) ?? [];
    arr.push(a);
    byHand.set(a.hand_id, arr);
  }

  interface TStat {
    a: string;
    b: string;
    closeEvents: number;
    totalEvents: number;
  }
  const pairStats = new Map<string, TStat>();

  for (const handActions of byHand.values()) {
    handActions.sort(
      (x, y) => new Date(x.created_at).getTime() - new Date(y.created_at).getTime(),
    );
    for (let i = 0; i < handActions.length - 1; i++) {
      const cur = handActions[i]!;
      const next = handActions[i + 1]!;
      if (!cur.user_id || !next.user_id || cur.user_id === next.user_id) continue;
      const dt = Math.abs(
        new Date(next.created_at).getTime() - new Date(cur.created_at).getTime(),
      );
      const key = pairKey(cur.user_id, next.user_id);
      const existing = pairStats.get(key);
      const stat: TStat = existing ?? {
        a: cur.user_id < next.user_id ? cur.user_id : next.user_id,
        b: cur.user_id < next.user_id ? next.user_id : cur.user_id,
        closeEvents: 0,
        totalEvents: 0,
      };
      stat.totalEvents += 1;
      if (dt < 500) stat.closeEvents += 1;
      pairStats.set(key, stat);
    }
  }

  /**
   * THE BASELINE IS MEASURED, NOT ASSUMED (fixed 2026-09-05). The old test was
   * `zish = (ratio - 0.15) / 0.08` - a hardcoded population rate and a
   * hardcoded standard deviation, neither scaling with sample size, so it was
   * not a z-score at all. With the ratio gate at 0.35 it evaluated to exactly
   * 2.5 against a 2.5 threshold, meaning the significance test was a no-op and
   * the whole rule was "35% of adjacent actions inside 500ms over 15 events".
   *
   * On this platform that is close to a description of the fleet: horses act
   * on a timer, so two horses in sequence are fast by construction. It wrote
   * 910 rows since 2026-08-28 and NOT ONE has ever been reviewed.
   *
   * The fix is not to exclude horses - CLAUDE.md 10.5 - it is to compare each
   * pair against the rate this population actually produces, with a binomial
   * standard error that shrinks as the pair plays more. A fast pool raises the
   * baseline for everybody, and standing out means standing out from the room.
   */
  let totalClose = 0;
  let totalEvents = 0;
  for (const stat of pairStats.values()) {
    totalClose += stat.closeEvents;
    totalEvents += stat.totalEvents;
  }
  const baseRate = totalEvents > 0 ? totalClose / totalEvents : 0;

  const findings: Finding[] = [];
  if (!(baseRate > 0) || baseRate >= 1) return findings;

  for (const stat of pairStats.values()) {
    if (stat.totalEvents < MIN_HANDS_FOR_SIGNAL) continue;
    const ratio = stat.closeEvents / stat.totalEvents;
    if (ratio <= baseRate) continue;
    const se = Math.sqrt((baseRate * (1 - baseRate)) / stat.totalEvents);
    if (!(se > 0)) continue;
    const z = (ratio - baseRate) / se;
    if (z < TIMING_MIN_Z) continue;

    findings.push({
      player_a: stat.a,
      player_b: stat.b,
      pattern_type: 'TIMING_CORRELATION',
      suspicion_score: Math.min(100, Math.round(50 + (z - TIMING_MIN_Z) * 10)),
      evidence: {
        close_action_pairs: stat.closeEvents,
        total_adjacent_actions: stat.totalEvents,
        close_ratio: Number(ratio.toFixed(3)),
        population_rate: Number(baseRate.toFixed(3)),
        z_score: Number(z.toFixed(2)),
        threshold_z: TIMING_MIN_Z,
        threshold_ms: 500,
        method: 'share of adjacent actions inside 500ms, against the population rate for this window',
      },
    });
  }
  return findings;
}

/**
 * WIN_RATE_ANOMALY - pairs whose chip flow is too one-directional to be luck.
 *
 * REWRITTEN 2026-09-04. The previous version flagged 63% of every pair that
 * cleared its own hand gate, and the response was to filter horses out of the
 * results rather than to fix the measurement. Two separate defects:
 *
 * 1. IT CREDITED THE WHOLE POT TO EVERY PAIR THE WINNER WAS IN. On a six-handed
 *    table one 20bb pot was recorded as 20bb of flow toward the winner in each
 *    of the five pairs containing them - the pot counted five times, and each
 *    opponent charged for all of it as though they had paid it alone. The per
 *    hand step was therefore about (n-1) times too large, which inflates the
 *    apparent bb/100 of every pair on the platform.
 *
 * 2. IT COMPARED THAT NUMBER TO A FIXED LINE. |bb/100| >= 80 over >= 30 hands
 *    sounds strict and is not: with a per-hand step the size of a whole pot the
 *    standard error of a 30-hand mean is several hundred bb/100, so the line
 *    sat well inside one sigma of pure noise. It was not a threshold, it was a
 *    coin flip, and every pair with enough volume eventually crossed it. The
 *    author of the horse filter measured this correctly - 81,301 pairs from 573
 *    players, roughly half of all possible pairings - and drew the wrong
 *    conclusion from it. The tell was in the same comment: the one human ever
 *    caught had played six hands. That was a false positive too.
 *
 * What it does now. The pot is split across the (n-1) opponents of the winner,
 * which is the unbiased estimate of pairwise transfer when the hand record does
 * not say who put what in (players[] carries seat, cards, stack and username,
 * and no contribution field - player-stats-refresh reads a chips_invested that
 * production data does not have). Then the pair is flagged only when its total
 * flow is at least WIN_RATE_MIN_Z standard errors from zero, using the pair's
 * OWN observed per-hand spread rather than a constant. A pair that plays big
 * pots is held to a proportionally bigger bar, which is the entire point.
 *
 * MEASURED over the same 50,000 hands the live scan reads (2026-09-04):
 *
 *   pairs over the 30-hand gate                     3,477
 *   flagged by the old fixed-line rule              2,178   (63%)
 *   flagged at 3 sigma with the split estimator         3
 *   flagged at 4 sigma with the split estimator         0
 *
 * The largest |z| in that window was 3.29, which is what the maximum of ~3,500
 * standard normal draws looks like. There is no collusion signal in that data,
 * and the corrected statistic says so WITHOUT being told who is a horse. That
 * is why the identity filter could be deleted rather than merely narrowed.
 *
 * Sensitivity, so this is not a threshold that can only ever say no: a pair
 * where one side ships 80% of a 20bb average pot to the other over 30 shared
 * hands lands near 9 sigma. The bar rejects noise, not dumping. The unit tests
 * pin both directions.
 */
function scanWinRateAnomaly(hands: HandRow[]): Finding[] {
  interface WStat {
    a: string;
    b: string;
    handsTogether: number;
    /** Sum of per-hand pairwise flow, in bb, positive toward b. */
    flowBb: number;
    /** Welford running mean and M2, so the variance needs no second pass and
     *  does not lose precision to catastrophic cancellation the way a raw
     *  sum-of-squares does when the mean is small against the step size. */
    mean: number;
    m2: number;
  }
  const pairStats = new Map<string, WStat>();

  for (const h of hands) {
    const bb = Number(h.big_blind ?? 0) || 1;
    const pot = Number(h.pot_size ?? 0);
    const winners = Array.isArray(h.winners) ? h.winners : [];
    const winnerIds = winners
      .map((w) => w?.user_id ?? w?.userId ?? w?.id)
      .filter((id): id is string => !!id);
    if (winnerIds.length !== 1) continue;
    const winner = winnerIds[0]!;
    const players = extractPlayerIds(h);
    if (players.length < 2) continue;

    // The winner took the pot from the OTHER (n-1) seats, not from each of them
    // in full. Without per-player contributions in the hand record, an equal
    // split is the unbiased estimate of what each of them lost to the winner.
    const perOpponentBb = pot / bb / (players.length - 1);

    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const a = players[i]!;
        const b = players[j]!;
        const key = pairKey(a, b);
        const existing = pairStats.get(key);
        const stat: WStat = existing ?? {
          a: a < b ? a : b,
          b: a < b ? b : a,
          handsTogether: 0,
          flowBb: 0,
          mean: 0,
          m2: 0,
        };
        stat.handsTogether += 1;
        // A hand won by a third party moves nothing between these two, and
        // still counts as a hand played together - that is what makes the
        // denominator honest.
        let step = 0;
        if (winner === stat.b) step = perOpponentBb;
        else if (winner === stat.a) step = -perOpponentBb;
        stat.flowBb += step;
        const delta = step - stat.mean;
        stat.mean += delta / stat.handsTogether;
        stat.m2 += delta * (step - stat.mean);
        pairStats.set(key, stat);
      }
    }
  }

  const findings: Finding[] = [];
  for (const stat of pairStats.values()) {
    const n = stat.handsTogether;
    if (n < WIN_RATE_MIN_SHARED_HANDS) continue;

    const mean = stat.mean;
    // A pair that never moved a chip on net is not evidence of anything, and
    // it is the only case where a zero here means "nothing to see".
    if (mean === 0) continue;

    const variance = Math.max(0, stat.m2 / (n - 1));
    const stdErr = Math.sqrt(variance / n);

    // ZERO VARIANCE IS THE STRONGEST SIGNAL THERE IS, NOT A DIVIDE-BY-ZERO TO
    // SKIP. A pair whose every shared hand moved the same amount the same way
    // is perfectly consistent one-directional transfer - the most blatant dump
    // the detector could ever see. An earlier draft of this function guarded
    // `variance > 0` and silently dropped exactly that case; the unit test for
    // a 40-hand sweep is what caught it.
    const z = stdErr > 0 ? Math.abs(mean) / stdErr : Number.POSITIVE_INFINITY;
    if (z < WIN_RATE_MIN_Z) continue;

    // Reported capped and finite: Infinity serialises to null through
    // JSON.stringify, and an evidence payload with a null where the number
    // should be is the empty-queue failure in miniature.
    const zReported = Number.isFinite(z) ? Number(z.toFixed(2)) : 999;

    const bb100 = mean * 100;
    const winnerId = stat.flowBb > 0 ? stat.b : stat.a;
    const loserId = stat.flowBb > 0 ? stat.a : stat.b;
    // Score reads off how far past the bar it is, so an operator sorting by
    // score is sorting by evidence and not by pot size.
    const score = Math.min(100, Math.round(50 + (zReported - WIN_RATE_MIN_Z) * 10));
    findings.push({
      player_a: loserId,
      player_b: winnerId,
      pattern_type: 'WIN_RATE_ANOMALY',
      suspicion_score: score,
      evidence: {
        hands_together: n,
        bb_per_100: Number(bb100.toFixed(1)),
        z_score: zReported,
        threshold_z: WIN_RATE_MIN_Z,
        net_bb: Number(stat.flowBb.toFixed(1)),
        direction: 'loser_to_winner',
        // Says plainly what the number is and is not, because "bb/100" on an
        // operator screen invites reading it as a real win rate.
        method:
          'pot split equally across the winning seat\'s opponents; ' +
          'flagged on standard errors from zero, not on bb/100 magnitude',
      },
    });
  }
  return findings;
}

/**
 * Internals exposed for unit tests. The detectors are pure functions over rows
 * and are far better tested directly than through a mocked Supabase client:
 * the old horse-filter suite stubbed four table clients to assert one boolean.
 */
export const __testing = {
  scanWinRateAnomaly,
  SOFT_PLAY_MIN_Z,
  TIMING_MIN_Z,
  scanChipDump,
  scanSoftPlay,
  scanTimingCorrelation,
  WIN_RATE_MIN_Z,
  WIN_RATE_MIN_SHARED_HANDS,
};

export async function collusionScan(c: Context) {
  const supabase = getSupabase();
  const scanStart = Date.now();

  // Window is the rolling last WINDOW_HOURS by default, but an explicit
  // ?since=&until= lets a missed run be re-scanned over the period it should
  // have covered. See src/lib/scanWindow.ts for why that exists.
  let scanWindow;
  try {
    scanWindow = await resolveScanWindow(c, WINDOW_HOURS);
  } catch (err) {
    if (err instanceof ScanWindowError) return c.json({ error: err.message }, 400);
    throw err;
  }

  // THE SCHEDULED PATH RESUMES; only an explicit since/until overrides.
  //
  // A rolling window on a 30-minute cron re-read every hand 48 times, which is
  // what killed this scan when volume quintupled. Resuming from the mark makes
  // the cost proportional to the platform's RATE: ~15,000 hands a run rather
  // than ~700,000.
  //
  // An operator rescanning a historical gap still gets exactly the window they
  // asked for, and does NOT move the mark - a backfill must not make the live
  // scan skip forward over hands it never read.
  let windowStart = scanWindow.start;
  let windowEnd = scanWindow.end;
  let resumed = false;
  let secondsBehindAtStart: number | null = null;

  if (!scanWindow.overridden) {
    try {
      const state = await readScanState();
      const w = windowFromState(state);
      windowStart = w.start;
      windowEnd = w.end;
      resumed = true;
      secondsBehindAtStart = state.secondsBehind;
    } catch (stateErr) {
      // FAIL, do not fall back to the rolling window. Falling back would
      // quietly restore the exact shape that stopped this scan returning, and
      // it would look like a healthy run while doing it.
      const msg = stateErr instanceof Error ? stateErr.message : 'scan state unavailable';
      console.warn('[collusion-scan] state read failed:', msg);
      return c.json({ error: `scan state unavailable: ${msg}` }, 503);
    }
  }

  // Nothing new. Not an error, and not a finding: the platform has simply not
  // played a hand since the last run. Reported explicitly so an empty result
  // is never confused with a clean one.
  if (windowEnd.getTime() <= windowStart.getTime()) {
    return c.json({
      success: true,
      resumed,
      no_new_hands: true,
      window: { start: windowStart.toISOString(), end: windowEnd.toISOString() },
      duration_ms: Date.now() - scanStart,
    });
  }

  /**
   * WHERE THE TIME WENT, per phase, reported in the response and therefore
   * into cron_execution_log.result.
   *
   * Added after a run sat at `running` for ten minutes and the only way to
   * find out which call it was on was to reproduce the whole handler locally
   * against 40,000 real hands. The read had a budget and reported it; nothing
   * else reported anything. A run that takes too long must be able to say
   * which part took it.
   */
  const timings: Record<string, number> = {};
  let phaseAt = Date.now();

  try {
    // Paged: a single .limit(50000) came back as 1000 rows and a 200, so this
    // scan had only ever seen ~0.36% of a 24h window. See lib/pagedSelect.ts.
    const handsRows: HandRow[] = [];
    const actionRows: ActionRow[] = [];
    let handsTruncated: boolean;
    let readBudgetHit = false;
    let readComplete = false;
    let readCursorEnd: string | null = null;
    let readPages = 0;
    try {
      // KEYSET, ASCENDING, BUDGETED. OFFSET paging over a window where
      // thousands of rows share a millisecond is not a total order - two pages
      // can repeat a row and skip another - and an unbudgeted read is what
      // stopped this scan returning at all. Ascending so an interrupted run
      // leaves a contiguous unscanned TAIL the next run resumes from, rather
      // than a hole in the middle.
      const paged = await pagedSelectKeyset<HandRow>(
        (afterCreatedAt, afterId) => {
          let q = supabase
            .from('hand_history')
            .select(
              'id, table_id, hand_number, started_at, ended_at, created_at, players, winners, actions, pot_size, big_blind, small_blind',
            )
            // THE CURSOR MUST APPEAR AS A PLAIN >= TOO, not only inside the
            // .or() below. PostgREST turns an `or=(...)` into a boolean
            // expression the planner will not use as an index condition, so
            // page 40 was a Filter over the whole window rather than an Index
            // Cond: measured 154.9ms and 21,099 buffers against 8.6ms and 964
            // for the same page with this line - and getting worse with depth,
            // because every page re-scanned everything before it. This one
            // line is what makes the read O(page) instead of O(window x pages).
            //
            // It is a WIDENING of the .or() below, never a replacement: >= the
            // cursor still includes the cursor row itself and every row tied
            // with it, and the .or() is what makes the boundary strict.
            .gte('created_at', afterCreatedAt ?? windowStart.toISOString())
            .lt('created_at', windowEnd.toISOString());
          if (afterCreatedAt !== null && afterId !== null) {
            // (created_at, id) strictly after the cursor. `id` breaks every
            // tie, so no row is read twice and none is skipped.
            q = q.or(
              `created_at.gt.${afterCreatedAt},and(created_at.eq.${afterCreatedAt},id.gt.${afterId})`,
            );
          }
          return q
            .order('created_at', { ascending: true })
            .order('id', { ascending: true });
        },
        {
          maxRows: MAX_SCAN_HANDS,
          budgetMs: READ_BUDGET_MS,
          // FOLD EACH PAGE, DO NOT ACCUMULATE IT. The detectors need six
          // small fields per hand; `actions` is needed only to derive
          // actionRows and is the bulk of the payload. Converting here and
          // dropping the JSONB immediately keeps peak memory flat in
          // MAX_SCAN_HANDS instead of growing with it. See the onPage note in
          // lib/pagedSelectKeyset.ts for what this is fixing and how much of
          // that is inferred rather than measured.
          onPage: (batch) => {
            for (const h of batch) {
              for (const a of (Array.isArray(h.actions) ? h.actions : []) as Array<
                Record<string, unknown>
              >) {
                const uid = (a.userId ?? a.user_id ?? a.id) as string | undefined;
                const tsRaw = (a.timestamp ?? a.ts ?? a.time) as number | undefined;
                if (!uid || typeof tsRaw !== 'number') continue;
                actionRows.push({
                  id: `${h.id}:${tsRaw}:${uid}`,
                  table_id: h.table_id,
                  hand_id: h.id,
                  user_id: uid,
                  created_at: new Date(tsRaw).toISOString(),
                  street: ((a.stage ?? a.street) as string | undefined) ?? null,
                  action: (a.action as string | undefined) ?? null,
                });
              }
              // Derived here, while the JSONB is still in hand. See the note
              // on HandRow.postflopLive for why this cannot be done later.
              const acts = (Array.isArray(h.actions) ? h.actions : []) as HandAction[];
              const postflop = acts.filter((a) =>
                ['flop', 'turn', 'river'].includes(streetOf(a)),
              );
              const postflopLive = Array.from(
                new Set(postflop.map((a) => actorOf(a)).filter((id): id is string => !!id)),
              );
              const checkdown =
                postflop.filter((a) => a.action === 'check').length >= 3 &&
                postflop.filter(
                  (a) => a.action === 'bet' || a.action === 'raise' || a.action === 'all-in',
                ).length === 0;

              // The slim record the four detectors actually read. `actions`
              // is deliberately absent: nothing downstream touches it again,
              // and holding it is what made a run's footprint scale with the
              // window.
              handsRows.push({
                id: h.id,
                table_id: h.table_id,
                hand_number: h.hand_number,
                started_at: h.started_at,
                ended_at: h.ended_at,
                created_at: h.created_at,
                players: h.players,
                winners: h.winners,
                actions: null,
                pot_size: h.pot_size,
                big_blind: h.big_blind,
                small_blind: h.small_blind,
                postflopLive,
                checkdown,
              });
            }
          },
        },
      );
      timings.read_ms = Date.now() - phaseAt;
      phaseAt = Date.now();
      readBudgetHit = paged.hitBudget;
      readComplete = paged.complete;
      readCursorEnd = paged.cursorEnd;
      readPages = paged.pages;
      // Truncated means "there is more in this window than this run read",
      // whichever limit bound first.
      handsTruncated = !paged.complete;
    } catch (readErr) {
      const m = readErr instanceof Error ? readErr.message : 'hand_history read failed';
      console.warn('[collusion-scan] hand_history read error:', m);
      return c.json({ error: m }, 500);
    }

    // Round 67 fix: action_log was always empty in production (legacy table
    // — no code ever wrote there). The TIMING_CORRELATION pattern silently
    // starved on every scan, so per-action rows are synthesized from
    // hand_history.actions[] JSONB, which IS populated by every hand. That
    // now happens in the onPage fold above, as each page arrives, so the raw
    // JSONB is never held for the whole window.

    const findings: Finding[] = [
      ...scanChipDump(handsRows),
      ...scanSoftPlay(handsRows),
      ...scanTimingCorrelation(actionRows),
      ...scanWinRateAnomaly(handsRows),
    ];

    // ── NO IDENTITY FILTER. CLAUDE.md 10.5, PHASE5-CONTRACTS section 0 rule 4 ──
    // Between 2026-09-01 and 2026-09-04 this scan dropped every pair in which
    // both players were horses, on the reasoning that two house-run horses
    // "cannot collude in the sense this detector exists to catch". That is an
    // is_horse exclusion, and it is the exact shortcut CLAUDE.md 10.5 was
    // written about after the same reasoning zeroed tournament rake
    // attribution for 39 events. PHASE5-CONTRACTS section 0 rule 4 names this
    // detector as the place the temptation would be sharpest, and it was right.
    //
    // A horse is subject to every rule a human is subject to, integrity checks
    // included, and two horses colluding is a HorseBehavior defect an operator
    // needs to see. The filter also hid the real bug rather than fixing it: it
    // was introduced because the detector flagged 81,301 pairs, and it did that
    // because scanWinRateAnomaly was measuring the wrong quantity against a
    // fixed line. That is fixed above, and with the statistic corrected the
    // same 50,000 hands produce ZERO flags with nobody filtered out - so
    // nothing is being suppressed to keep this queue readable.
    //
    // If this scan ever floods again, the answer is the threshold or the
    // estimator. It is never a filter on who the player is.
    const rows = findings.map((f) => ({
      ...f,
      scan_date: windowEnd.toISOString().split('T')[0]!,
      window_start: windowStart.toISOString(),
      window_end: windowEnd.toISOString(),
      status: 'open',
    }));

    let inserted = 0;
    if (rows.length > 0 && !scanWindow.dryRun) {
      const { error: insErr, count } = await withDeadline(
        supabase.from('collusion_tracking').insert(rows, { count: 'exact' }),
        CALL_DEADLINE_MS,
        `collusion_tracking insert (${rows.length} rows)`,
      );
      if (insErr) {
        console.warn('[collusion-scan] insert error:', insErr.message);
        return c.json({ error: insErr.message, findings: rows.length }, 500);
      }
      inserted = count ?? rows.length;
    }
    timings.insert_ms = Date.now() - phaseAt;
    phaseAt = Date.now();

    // ── ADVANCE THE MARK, over read ground only ───────────────────────────
    //
    // A completed read covers the whole window, so the mark goes to
    // windowEnd. A read that stopped on its budget or its row cap covers only
    // as far as the last row it actually saw, so the mark goes THERE and the
    // next run picks up the tail. That is the difference between "there is
    // more to do" and "some hands were never examined by anything", and the
    // second is the failure scanWindow.ts was written to close.
    //
    // Never on a dry run, and never on an operator's historical rescan: a
    // backfill must not push the live scan forward over hands it never read.
    let advanced: { ok: boolean; error?: string } | null = null;
    let coveredTo = windowEnd;
    if (resumed && !scanWindow.dryRun) {
      if (!readComplete && readCursorEnd) {
        // The last row actually read. JS truncates the microseconds Postgres
        // keeps, and it truncates DOWN, so the mark lands at or before that
        // row - the next window re-reads it rather than stepping over it.
        // Re-reading a handful of rows costs a duplicate finding; stepping
        // over them loses the hand forever, and only one of those two is
        // recoverable.
        const cursor = new Date(readCursorEnd);
        if (!Number.isNaN(cursor.getTime())) coveredTo = cursor;
      } else if (!readComplete && !readCursorEnd) {
        // Bounded out before reading a single row. Cover nothing: the mark
        // stays exactly where it was and the whole window is the next run's.
        // Reachable when the budget is already spent on entry, which is what
        // a container under load looks like.
        coveredTo = windowStart;
      }
      advanced = await advanceScanState({
        coveredTo,
        scannedHands: handsRows.length,
        findings: findings.length,
        durationMs: Date.now() - scanStart,
        // NOT readBudgetHit. A catch-up span holds ~148,000 hands against a
        // 40,000-row ceiling, so it stops on the ROW CAP in seconds and never
        // touches the budget - and the console renders this flag as
        // `catching_up`. Asking "is there more in this window than I read"
        // covers both limits and is the question the operator is actually
        // asking. See advanceScanState.
        moreToRead: !readComplete,
      });

      timings.advance_ms = Date.now() - phaseAt;

      // A findings write that lands while the mark does not is NOT a success.
      // Answering 200 here means the next run re-reads the same window,
      // re-inserts the same findings and does it forever, with every row in
      // cron_execution_log saying `success` - a detector stuck in place
      // reporting health, which is the one failure PHASE5-CONTRACTS section 0
      // exists to forbid.
      if (!advanced.ok) {
        console.warn('[collusion-scan] mark did not advance:', advanced.error);
        return c.json(
          {
            error: `scan completed but the mark did not advance: ${advanced.error ?? 'unknown'}`,
            state_advanced: false,
            scanned_hands: handsRows.length,
            findings: findings.length,
            inserted,
            window: { start: windowStart.toISOString(), end: windowEnd.toISOString() },
            duration_ms: Date.now() - scanStart,
          },
          500,
        );
      }
    }

    const durationMs = Date.now() - scanStart;
    return c.json({
      success: true,
      dry_run: scanWindow.dryRun,
      window_overridden: scanWindow.overridden,
      // TRUE when this run read less of its window than the window contains,
      // whichever limit bound first. The findings are then a floor, not a
      // total, and the remainder is the next run's first job.
      timings,
      hands_truncated: handsTruncated,
      read_complete: readComplete,
      read_budget_hit: readBudgetHit,
      read_pages: readPages,
      read_budget_ms: READ_BUDGET_MS,
      max_scan_hands: MAX_SCAN_HANDS,
      max_span_hours: MAX_SPAN_HOURS,
      resumed,
      seconds_behind_at_start: secondsBehindAtStart,
      // NULL when nothing advanced - an operator's ?since= rescan and a dry
      // run both leave the mark alone, and reporting a covered_to there reads
      // as though the live scan had moved.
      covered_to: advanced ? coveredTo.toISOString() : null,
      state_advanced: advanced ? advanced.ok : false,
      state_advance_error: advanced?.error ?? null,
      // WHAT THE THRESHOLDS SAW. Every pattern below counts hands a pair
      // shared WITHIN THIS RUN's window, and those minimums were chosen when
      // one run was 24 hours. A resumed run is ~30 minutes, so a pair whose
      // shared hands are spread across runs is not yet aggregated by
      // anything and cannot trigger. Stated here, and rendered by the
      // console, because an integrity surface may never imply it is watching
      // something it is not (PHASE5-CONTRACTS section 0).
      detection_span_minutes: Math.round(
        (windowEnd.getTime() - windowStart.getTime()) / 60_000,
      ),
      detection_thresholds: {
        min_shared_hands: MIN_HANDS_FOR_SIGNAL,
        win_rate_min_shared_hands: WIN_RATE_MIN_SHARED_HANDS,
        win_rate_min_z: WIN_RATE_MIN_Z,
        aggregates_across_runs: false,
        // No pair is excluded by who the players are. CLAUDE.md 10.5.
        identity_filtered: false,
      },
      scanned_hands: handsRows.length,
      scanned_actions: actionRows.length,
      findings: findings.length,
      inserted,
      window: {
        start: windowStart.toISOString(),
        end: windowEnd.toISOString(),
      },
      duration_ms: durationMs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'scan failed';
    console.warn('[collusion-scan] fatal:', msg);
    return c.json({ error: msg }, 500);
  }
}
