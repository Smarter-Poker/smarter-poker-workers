/**
 * GET/POST /cron/bbj-detect
 *
 * Phase X4 (Master Gap Ledger 2026-04-28) — closes P0-A5 / WRK-003.
 *
 * Cadence: every 5 minutes (Open Claw scheduler).
 *
 * Scans `hand_history` rows settled in the last 6 minutes (1 min overlap with
 * the cadence to absorb scheduler jitter), and for each hand asks the
 * SQL RPC `fn_bbj_check_eligible(p_hand_id)` whether it qualifies for
 * a Bad Beat Jackpot trigger (quad-aces-or-better cracked at showdown
 * by default, configurable per-club later).
 *
 * For each eligible hand it pulls the table's currently-seated player IDs
 * (excluding winner + loser) and invokes `fn_bbj_payout`, which:
 *   - drains the pool atomically
 *   - inserts bbj_payouts header
 *   - writes bbj_payout_recipients per table-share player
 *   - credits all 3 wallet groups (winner 50% / loser 25% / table 25%)
 *
 * Idempotency: every (hand_id) is checked only once per scan window.
 * If a payout for that hand_id already exists in bbj_payouts, the
 * detector skips. Re-running the cron is therefore safe.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const SCAN_WINDOW_MIN = 6;       // scan last 6 minutes; 5min cron + 1min jitter

interface ScanResult {
  hands_scanned: number;
  hands_eligible: number;
  payouts_written: number;
  payouts_skipped_existing: number;
  promo_swept: number;
  errors: string[];
}

export async function bbjDetect(c: Context) {
  const supabase = getSupabase();
  const startedAt = new Date().toISOString();
  const since = new Date(Date.now() - SCAN_WINDOW_MIN * 60_000).toISOString();

  const result: ScanResult = {
    hands_scanned: 0,
    hands_eligible: 0,
    payouts_written: 0,
    payouts_skipped_existing: 0,
    promo_swept: 0,
    errors: [],
  };

  // 1. Pull recently-settled hands
  const { data: hands, error: handsErr } = await supabase
    .from('hand_history')
    .select('id, table_id, ended_at')
    .gte('created_at', since)
    .not('ended_at', 'is', null);

  if (handsErr) {
    result.errors.push(`hand_history scan: ${handsErr.message}`);
    return c.json({ ok: false, started_at: startedAt, ...result }, 500);
  }

  result.hands_scanned = hands?.length ?? 0;

  for (const hand of hands ?? []) {
    try {
      // 2. Skip if a payout already exists for this hand
      const { data: existing } = await supabase
        .from('bbj_payouts')
        .select('id')
        .eq('hand_id', hand.id)
        .maybeSingle();

      if (existing?.id) {
        result.payouts_skipped_existing += 1;
        continue;
      }

      // 3. Ask the SQL detector
      const { data: eligibility, error: eligErr } = await supabase.rpc(
        'fn_bbj_check_eligible',
        { p_hand_id: hand.id },
      );
      if (eligErr) {
        result.errors.push(`fn_bbj_check_eligible(${hand.id}): ${eligErr.message}`);
        continue;
      }
      if (!eligibility?.eligible) continue;

      result.hands_eligible += 1;

      const winnerId = eligibility.winner_user_id as string | null;
      const loserId  = eligibility.loser_user_id  as string | null;
      const poolId   = eligibility.pool_id        as string | null;
      const tableId  = (eligibility.table_id ?? hand.table_id) as string | null;
      if (!winnerId || !loserId || !poolId || !tableId) continue;

      // 4. Resolve currently-seated players at the table (excluding winner+loser)
      const { data: seats } = await supabase
        .from('table_seats')
        .select('user_id')
        .eq('table_id', tableId)
        .not('user_id', 'is', null);

      const tablePlayerIds = (seats ?? [])
        .map((s) => s.user_id as string)
        .filter((id) => id && id !== winnerId && id !== loserId);

      // 5. Write the payout atomically via RPC
      const { error: payoutErr } = await supabase.rpc('fn_bbj_payout', {
        p_pool_id: poolId,
        p_hand_id: hand.id,
        p_table_id: tableId,
        p_winner_user_id: winnerId,
        p_loser_user_id: loserId,
        p_table_player_ids: tablePlayerIds,
      });

      if (payoutErr) {
        result.errors.push(`fn_bbj_payout(${hand.id}): ${payoutErr.message}`);
        continue;
      }

      result.payouts_written += 1;
    } catch (err) {
      result.errors.push(`hand ${hand.id}: ${(err as Error).message}`);
    }
  }

  // 6. Sweep accrued BBJ promo into the union promo wallets.
  //
  // Contributions land 50/25/25 into main/backup/promo on the pool row, but
  // promo_balance is only MONEY IN FLIGHT until fn_sweep_bbj_promo_all()
  // moves it to the union's promo wallet (audit sections 23/29: the one-time
  // manual sweep moved 47,607.05; pools had re-accrued 3,339.90 within two
  // days because nothing recurred). The sweep is idempotent, double-entry
  // ledgered, and cheap (one canonical pool per scope since the 2026-08-17
  // consolidation), so it rides the same 5-minute cadence as detection.
  try {
    const { data: sweep, error: sweepErr } = await supabase.rpc('fn_sweep_bbj_promo_all');
    if (sweepErr) {
      result.errors.push(`fn_sweep_bbj_promo_all: ${sweepErr.message}`);
    } else {
      result.promo_swept = Number((sweep as Record<string, unknown>)?.total_swept ?? 0);
    }
  } catch (err) {
    result.errors.push(`promo sweep: ${(err as Error).message}`);
  }

  return c.json({
    ok: result.errors.length === 0,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    ...result,
  });
}
