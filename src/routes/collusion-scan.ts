/**
 * GET/POST /cron/collusion-scan
 *
 * Ported from pages/api/cron/collusion-scan.js (410 lines).
 *
 * Nightly 03:30 UTC: scan last 24h of hand_history + action_log for
 * suspicious player-pair patterns. Writes findings to collusion_tracking
 * with status='open' for human review.
 *
 * Patterns:
 *   CHIP_DUMP          — pair where one consistently ships pots to the other
 *                        (≥80% loss ratio over ≥15 hands)
 *   SOFT_PLAY          — mutual checkdowns post-flop without raises
 *                        (≥15 checkdown hands)
 *   TIMING_CORRELATION — adjacent-action timing on same hand <500ms in
 *                        ≥35% of cases AND z-score ≥ 2.5 vs 15% baseline
 *   WIN_RATE_ANOMALY   — pair bb/100 magnitude ≥80 over ≥30 hands together
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
const TIMING_Z_SCORE = 2.5;

interface PlayerSeat {
  user_id?: string;
  userId?: string;
  id?: string;
}

interface HandAction {
  street?: string;
  action?: string;
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
    const losesA = stat.aLoses / stat.total;
    const losesB = stat.bLoses / stat.total;
    if (losesA >= CHIP_DUMP_LOSS_RATIO || losesB >= CHIP_DUMP_LOSS_RATIO) {
      const dominantLoser = losesA >= losesB ? stat.a : stat.b;
      const dominantWinner = losesA >= losesB ? stat.b : stat.a;
      const ratio = Math.max(losesA, losesB);
      const score = Math.min(100, Math.round(ratio * 100 + (stat.total >= 40 ? 10 : 0)));
      findings.push({
        player_a: dominantLoser,
        player_b: dominantWinner,
        pattern_type: 'CHIP_DUMP',
        suspicion_score: score,
        evidence: {
          hands: stat.total,
          loser_loss_ratio: Number(ratio.toFixed(3)),
          pot_volume: Number(stat.potSum.toFixed(2)),
        },
      });
    }
  }
  return findings;
}

function scanSoftPlay(hands: HandRow[]): Finding[] {
  interface SPStat {
    a: string;
    b: string;
    checkdowns: number;
    total: number;
  }
  const pairStats = new Map<string, SPStat>();
  for (const h of hands) {
    const players = extractPlayerIds(h);
    if (players.length < 2) continue;
    const actions = Array.isArray(h.actions) ? h.actions : [];
    const postflopActions = actions.filter(
      (a) => a && ['flop', 'turn', 'river'].includes(a.street ?? ''),
    );
    if (postflopActions.length === 0) continue;
    const raises = postflopActions.filter(
      (a) => a.action === 'bet' || a.action === 'raise' || a.action === 'all-in',
    ).length;
    const checks = postflopActions.filter((a) => a.action === 'check').length;
    if (!(checks >= 3 && raises === 0)) continue;

    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const a = players[i]!;
        const b = players[j]!;
        const key = pairKey(a, b);
        const existing = pairStats.get(key);
        const stat: SPStat = existing ?? {
          a: a < b ? a : b,
          b: a < b ? b : a,
          checkdowns: 0,
          total: 0,
        };
        stat.total += 1;
        stat.checkdowns += 1;
        pairStats.set(key, stat);
      }
    }
  }

  const findings: Finding[] = [];
  for (const stat of pairStats.values()) {
    if (stat.checkdowns < MIN_HANDS_FOR_SIGNAL) continue;
    const score = Math.min(100, 40 + Math.min(60, stat.checkdowns * 2));
    findings.push({
      player_a: stat.a,
      player_b: stat.b,
      pattern_type: 'SOFT_PLAY',
      suspicion_score: score,
      evidence: {
        mutual_checkdowns: stat.checkdowns,
        threshold: MIN_HANDS_FOR_SIGNAL,
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

  const findings: Finding[] = [];
  for (const stat of pairStats.values()) {
    if (stat.totalEvents < MIN_HANDS_FOR_SIGNAL) continue;
    const ratio = stat.closeEvents / stat.totalEvents;
    if (ratio < 0.35) continue;
    const zish = (ratio - 0.15) / 0.08;
    if (zish < TIMING_Z_SCORE) continue;
    const score = Math.min(100, Math.round(40 + ratio * 60));
    findings.push({
      player_a: stat.a,
      player_b: stat.b,
      pattern_type: 'TIMING_CORRELATION',
      suspicion_score: score,
      evidence: {
        close_action_pairs: stat.closeEvents,
        total_adjacent_actions: stat.totalEvents,
        close_ratio: Number(ratio.toFixed(3)),
        threshold_ms: 500,
      },
    });
  }
  return findings;
}

function scanWinRateAnomaly(hands: HandRow[]): Finding[] {
  interface WStat {
    a: string;
    b: string;
    handsTogether: number;
    aWins: number;
    bWins: number;
    bbFlowAtoB: number;
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
          aWins: 0,
          bWins: 0,
          bbFlowAtoB: 0,
        };
        stat.handsTogether += 1;
        const bbDelta = pot / bb;
        if (winner === stat.a) {
          stat.aWins += 1;
          stat.bbFlowAtoB -= bbDelta;
        } else if (winner === stat.b) {
          stat.bWins += 1;
          stat.bbFlowAtoB += bbDelta;
        }
        pairStats.set(key, stat);
      }
    }
  }

  const findings: Finding[] = [];
  for (const stat of pairStats.values()) {
    if (stat.handsTogether < 30) continue;
    const bb100 = (stat.bbFlowAtoB / stat.handsTogether) * 100;
    if (Math.abs(bb100) < 80) continue;
    const winner = bb100 > 0 ? stat.b : stat.a;
    const loser = bb100 > 0 ? stat.a : stat.b;
    const score = Math.min(100, 50 + Math.min(50, Math.round(Math.abs(bb100) / 4)));
    findings.push({
      player_a: loser,
      player_b: winner,
      pattern_type: 'WIN_RATE_ANOMALY',
      suspicion_score: score,
      evidence: {
        hands_together: stat.handsTogether,
        bb_per_100: Number(bb100.toFixed(1)),
        direction: 'loser_to_winner',
      },
    });
  }
  return findings;
}

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
    let handsRows: HandRow[];
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
        { maxRows: MAX_SCAN_HANDS, budgetMs: READ_BUDGET_MS },
      );
      timings.read_ms = Date.now() - phaseAt;
      phaseAt = Date.now();
      handsRows = paged.rows;
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
    // starved on every scan. Now we synthesize per-action rows from
    // hand_history.actions[] JSONB which IS populated by every hand.
    const actionRows: ActionRow[] = [];
    for (const h of handsRows) {
      const arr = Array.isArray(h.actions) ? h.actions : [];
      for (const a of arr as Array<Record<string, unknown>>) {
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
    }

    const findings: Finding[] = [
      ...scanChipDump(handsRows),
      ...scanSoftPlay(handsRows),
      ...scanTimingCorrelation(actionRows),
      ...scanWinRateAnomaly(handsRows),
    ];

    // ── Exclude horse-vs-horse pairs ──────────────────────────────────────
    // Horses are house-run AI. Two of them cannot collude in the sense this
    // detector exists to catch, and including them destroyed the signal:
    // 169,519 of the 169,523 rows ever written were horse-vs-horse, 99.99% of
    // them WIN_RATE_ANOMALY at an average suspicion_score of 97 - and not one
    // row in four months was ever reviewed.
    //
    // Why it saturates: WIN_RATE_ANOMALY flags any pair with >=30 shared hands
    // and |bb/100| >= 80. Attributing a whole multiway pot delta to two named
    // players is extremely noisy, so across a field of horses grinding
    // thousands of hands essentially every pair crosses that line. It had
    // flagged 81,301 distinct pairs drawn from just 573 players - roughly half
    // of every pairing that exists. The one human ever caught had played 6
    // hands total.
    //
    // Only BOTH-horse pairs are dropped. A horse/human pair is retained, so a
    // horse leaking chips to a human still surfaces.
    timings.analyse_ms = Date.now() - phaseAt;
    phaseAt = Date.now();

    const findingIds = Array.from(new Set(findings.flatMap((f) => [f.player_a, f.player_b])));
    const horseIds = new Set<string>();
    // Chunked because .in() serialises every id into the query string. While
    // the scan was capped at 1000 hands this list stayed small and a single
    // call worked; reading the full window made it large enough that PostgREST
    // refused the request outright and the scan 500'd with "fetch failed".
    // A findings list is at most a few thousand ids, so this is 1-2 extra
    // round trips, not a paging loop.
    const HORSE_LOOKUP_CHUNK = 300;
    for (let i = 0; i < findingIds.length; i += HORSE_LOOKUP_CHUNK) {
      const chunk = findingIds.slice(i, i + HORSE_LOOKUP_CHUNK);
      const { data: horseRows, error: horseErr } = await withDeadline(
        supabase.from('profiles').select('id').in('id', chunk).eq('is_horse', true),
        CALL_DEADLINE_MS,
        `horse lookup (${chunk.length} ids)`,
      );
      if (horseErr) {
        // Fail the scan rather than fall back to the old behaviour. Falling
        // back would quietly resume writing ~170k horse-vs-horse rows, which
        // is the exact failure being fixed.
        console.warn('[collusion-scan] horse lookup failed:', horseErr.message);
        return c.json({ error: `horse lookup failed: ${horseErr.message}` }, 500);
      }
      for (const r of horseRows ?? []) horseIds.add((r as { id: string }).id);
    }
    timings.horse_lookup_ms = Date.now() - phaseAt;
    timings.horse_lookup_calls = Math.ceil(findingIds.length / HORSE_LOOKUP_CHUNK);
    phaseAt = Date.now();

    const humanFindings = findings.filter(
      (f) => !(horseIds.has(f.player_a) && horseIds.has(f.player_b)),
    );
    const suppressedHorsePairs = findings.length - humanFindings.length;

    const scan_date = windowEnd.toISOString().split('T')[0]!;
    const rows = humanFindings.map((f) => ({
      ...f,
      scan_date,
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
        findings: humanFindings.length,
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
            findings: humanFindings.length,
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
        win_rate_min_shared_hands: 30,
        aggregates_across_runs: false,
      },
      scanned_hands: handsRows.length,
      scanned_actions: actionRows.length,
      findings: findings.length,
      findings_after_horse_filter: humanFindings.length,
      suppressed_horse_pairs: suppressedHorsePairs,
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
