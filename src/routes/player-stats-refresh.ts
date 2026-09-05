/**
 * GET/POST /cron/player-stats-refresh
 *
 * Phase X4 (Master Gap Ledger 2026-04-28) — closes P0-H1 / WRK-006.
 *
 * Cadence: every 5 minutes.
 *
 * Re-aggregates `player_stats` from `hand_history` for users who played
 * at least one hand in the scan window. Writes:
 *   hands_played, total_rake, vpip, pfr, three_bet_pct, af, wtsd_pct,
 *   bb_per_100, last_active_at, updated_at = now()
 *
 * Pre-Phase-X4, `player_stats.updated_at` had been frozen since 2026-03-24
 * because no handler ran this aggregation. Cron fires every 5 min so any
 * active player's stats stay no-staler-than-5-minutes.
 *
 * Idempotency: each (user_id, club_id) row is upserted on conflict —
 * recomputing the same window twice produces the same numbers.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

// Look back 1 hour so a momentary cron miss still gets covered
const LOOKBACK_HOURS = 1;

interface RefreshResult {
  users_processed: number;
  rows_upserted: number;
  errors: string[];
}

interface HandRow {
  id: string;
  table_id: string | null;
  hand_number: number | null;
  rake_amount: number | string | null;
  big_blind: number | string | null;
  pot_size: number | string | null;
  players: Array<Record<string, unknown>> | null;
  winners: Array<Record<string, unknown>> | null;
  actions: Array<Record<string, unknown>> | null;
  created_at: string;
}

function uidOf(p: Record<string, unknown> | undefined | null): string | null {
  if (!p) return null;
  return (p.user_id ?? p.userId ?? p.id ?? null) as string | null;
}

export async function playerStatsRefresh(c: Context) {
  const supabase = getSupabase();
  const startedAt = new Date().toISOString();
  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600_000).toISOString();

  const result: RefreshResult = {
    users_processed: 0,
    rows_upserted: 0,
    errors: [],
  };

  // 1. Pull recent hands
  const { data: hands, error } = await supabase
    .from('hand_history')
    .select('id, table_id, hand_number, rake_amount, big_blind, pot_size, players, winners, actions, created_at')
    .gte('created_at', since)
    .not('ended_at', 'is', null);

  if (error) {
    result.errors.push(`hand_history scan: ${error.message}`);
    return c.json({ ok: false, started_at: startedAt, ...result }, 500);
  }

  /**
   * THE STREET OF AN ACTION, and why this is a function.
   *
   * hand_history.actions[] carries `stage`, never `street`. Measured
   * 2026-09-05 over 3,000 consecutive production hands: 3,000 matched
   * `stage: "preflop"` and ZERO matched `street: "preflop"`. Every action row
   * looks like
   *
   *   { seat, userId, action, amount, stage, timestamp, dead, isFullRaise }
   *
   * This file read `a.street` in two places, so `preflopActions` was ALWAYS
   * EMPTY and the VPIP, PFR and 3-bet counters below have been computing over
   * nothing since they were written - every player this worker touched was
   * recorded at 0% VPIP and 0% PFR. It went unnoticed because the DB path
   * (fn_refresh_player_stats) reads `stage` correctly and writes the same
   * table, so player_stats looked populated; the 59 horses sitting at exactly
   * 0.00 VPIP over 100+ hands were the seats this worker had last written.
   *
   * `stage ?? street` rather than `stage` alone: the collusion scan's own
   * action mapper already accepts both, and a reader that tolerates the older
   * shape costs nothing while a reader that does not is how this happened.
   */
  const streetOf = (a: Record<string, unknown>): string | undefined =>
    (a.stage as string | undefined) ?? (a.street as string | undefined);

  // 2. Aggregate by user
  type Acc = {
    user_id: string;
    table_ids: Set<string>;
    hands: number;
    rake: number;
    bb_won: number;
    vpip_count: number;
    pfr_count: number;
    three_bet_count: number;
    bets: number;
    raises: number;
    calls: number;
    wts_count: number;        // hands seen at showdown
    wins: number;
    last_seen: string;
  };
  const byUser = new Map<string, Acc>();

  for (const hand of (hands ?? []) as HandRow[]) {
    const players = hand.players ?? [];
    const winners = (hand.winners ?? []) as Array<Record<string, unknown>>;
    const actions = (hand.actions ?? []) as Array<Record<string, unknown>>;
    const bb = Number(hand.big_blind ?? 1) || 1;
    const handRake = Number(hand.rake_amount ?? 0) || 0;
    const handPot  = Number(hand.pot_size ?? 0) || 0;
    const winnerIds = new Set(winners.map(uidOf).filter(Boolean) as string[]);

    for (const seat of players) {
      const uid = uidOf(seat);
      if (!uid) continue;
      let acc = byUser.get(uid);
      if (!acc) {
        acc = {
          user_id: uid,
          table_ids: new Set<string>(),
          hands: 0,
          rake: 0,
          bb_won: 0,
          vpip_count: 0,
          pfr_count: 0,
          three_bet_count: 0,
          bets: 0,
          raises: 0,
          calls: 0,
          wts_count: 0,
          wins: 0,
          last_seen: hand.created_at,
        };
        byUser.set(uid, acc);
      }
      acc.hands += 1;
      if (hand.table_id) acc.table_ids.add(hand.table_id);

      // Per-player rake share approximated as equal split (engine should
      // ideally pass player_contributions; this is a defensive fallback).
      const playerRake = handRake / Math.max(players.length, 1);
      acc.rake += playerRake;

      // bb_won: winners get +pot_in_bb-net_invested (approx: pot/bb if winner)
      if (winnerIds.has(uid)) {
        acc.bb_won += handPot / bb;
        acc.wins += 1;
      } else {
        /**
         * KNOWN GAP, stated rather than hidden. `chips_invested` IS NOT IN THE
         * DATA. A production seat object is { seat, cards, stack, userId,
         * username } and nothing else, verified 2026-09-05, so this branch has
         * always subtracted zero and `bb_won` is a sum of WINS ONLY - it is
         * not a win rate and must not be read as one.
         *
         * It is left computing zero rather than guessed at: `stack` is the
         * snapshot stack and cannot be differenced into an amount invested
         * without a per-street starting stack the row does not carry. The fix
         * is upstream - the engine emitting a per-player contribution - and
         * inventing a number here would put a plausible wrong figure in front
         * of an operator, which is worse than an obvious zero.
         */
        const inv = Number((seat as Record<string, unknown>).chips_invested ?? 0) || 0;
        if (inv > 0) acc.bb_won -= inv / bb;
      }

      // Pre-flop action analysis for VPIP / PFR / 3bet (if engine populated streets)
      const preflopActions = actions.filter(
        (a) => streetOf(a) === 'preflop' && uidOf(a) === uid,
      );
      let voluntary = false;
      let raised = false;
      let raiseCount = 0;
      for (const a of preflopActions) {
        const verb = (a.action as string | undefined) ?? '';
        if (verb === 'call' || verb === 'bet' || verb === 'raise') voluntary = true;
        if (verb === 'raise' || verb === 'bet') {
          raised = true;
          raiseCount += 1;
        }
        if (verb === 'bet') acc.bets += 1;
        if (verb === 'raise') acc.raises += 1;
        if (verb === 'call') acc.calls += 1;
      }
      if (voluntary) acc.vpip_count += 1;
      if (raised) acc.pfr_count += 1;
      if (raiseCount >= 2) acc.three_bet_count += 1;

      // WTSD: was the player still in the hand at the showdown street?
      const playerStreets = new Set(
        actions.filter((a) => uidOf(a) === uid).map((a) => streetOf(a)),
      );
      if (playerStreets.has('showdown') || playerStreets.has('river')) acc.wts_count += 1;

      if (hand.created_at > acc.last_seen) acc.last_seen = hand.created_at;
    }
  }

  // 3. Upsert one row per user
  for (const [, acc] of byUser) {
    if (acc.hands === 0) continue;
    const vpip = (acc.vpip_count / acc.hands) * 100;
    const pfr = (acc.pfr_count / acc.hands) * 100;
    const threeBet = (acc.three_bet_count / acc.hands) * 100;
    const af = acc.calls > 0 ? (acc.bets + acc.raises) / acc.calls : (acc.bets + acc.raises);
    const wtsd = (acc.wts_count / acc.hands) * 100;
    const bbPer100 = acc.hands > 0 ? (acc.bb_won / acc.hands) * 100 : 0;

    const { error: upsertErr } = await supabase
      .from('player_stats')
      .upsert(
        {
          user_id: acc.user_id,
          hands_played: acc.hands,
          total_rake: acc.rake,
          vpip: Number(vpip.toFixed(2)),
          pfr: Number(pfr.toFixed(2)),
          three_bet_pct: Number(threeBet.toFixed(2)),
          af: Number(af.toFixed(2)),
          wtsd_pct: Number(wtsd.toFixed(2)),
          bb_per_100: Number(bbPer100.toFixed(2)),
          last_active_at: acc.last_seen,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      );

    if (upsertErr) {
      result.errors.push(`upsert ${acc.user_id}: ${upsertErr.message}`);
      continue;
    }
    result.users_processed += 1;
    result.rows_upserted += 1;
  }

  return c.json({
    ok: result.errors.length === 0,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    lookback_hours: LOOKBACK_HOURS,
    ...result,
  });
}
