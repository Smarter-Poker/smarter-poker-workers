/**
 * GET/POST /cron/rakeback-period-settle
 *
 * Phase X4 (Master Gap Ledger 2026-04-28) — closes P0-A2 / WRK-001.
 *
 * Cadence: weekly, Monday 10:30 UTC (after the heavier auto-settlement
 * job at 10:00 and union-rakeback at 10:20). Hetzner-only, no Mac stagger.
 *
 * Why this handler exists:
 *   The pre-X3 production already had `rakeback_distributions` (per-agent-
 *   per-player ledger written by the legacy auto-settlement.ts) but
 *   `rakeback_periods` (per-club-per-user period header) and
 *   `rakeback_period_payouts` (per-period receipt) had ZERO rows ever
 *   because no handler wrote them. The audit flagged this as P0-A2.
 *
 *   Phase X3 added the canonical RPC pair `fn_create_settlement_period`
 *   + `fn_close_settlement_period` — this handler is the orchestrator
 *   that calls them for every (club, user) that generated rake in the
 *   prior week.
 *
 * Idempotency:
 *   `rakeback_periods` does not have a UNIQUE constraint on
 *   (club_id, user_id, period_start) yet; idempotency comes from the
 *   `fn_create_settlement_period` RPC being a simple INSERT, but a re-run
 *   of this cron WILL produce duplicate period headers without that
 *   constraint. To match the existing settlement_period_settled flag
 *   pattern, the handler scopes by:
 *     skip = EXISTS rakeback_periods WHERE
 *              club_id = X AND user_id = Y
 *              AND period_start = lastMondayDate AND status='paid'
 *   This makes a duplicate run a safe no-op.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

interface SettleResult {
  clubs_processed: number;
  users_processed: number;
  periods_opened: number;
  periods_closed: number;
  periods_skipped_already_paid: number;
  total_payout: number;
  errors: string[];
}

function lastMondayUtc(now: Date = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = d.getUTCDay();          // 0=Sun .. 1=Mon
  const daysBack = dow === 0 ? 6 : dow - 1;
  d.setUTCDate(d.getUTCDate() - daysBack);
  return d;
}

export async function rakebackPeriodSettle(c: Context) {
  const supabase = getSupabase();
  const startedAt = new Date().toISOString();

  const periodEnd = new Date();
  const periodStart = lastMondayUtc(periodEnd);
  const periodStartIso = periodStart.toISOString();
  const periodStartDate = periodStartIso.slice(0, 10);
  const periodEndDate   = periodEnd.toISOString().slice(0, 10);

  const result: SettleResult = {
    clubs_processed: 0,
    users_processed: 0,
    periods_opened: 0,
    periods_closed: 0,
    periods_skipped_already_paid: 0,
    total_payout: 0,
    errors: [],
  };

  // 1. Pull every (club, user) pair that generated rake during the period.
  //    rake_records.player_contributions is JSONB { user_id: rake_share }.
  const { data: clubs, error: clubsErr } = await supabase
    .from('clubs')
    .select('id, name, status')
    .neq('status', 'archived');

  if (clubsErr) {
    result.errors.push(`clubs scan: ${clubsErr.message}`);
    return c.json({ ok: false, started_at: startedAt, ...result }, 500);
  }

  for (const club of clubs ?? []) {
    result.clubs_processed += 1;

    const { data: rakeRows, error: rakeErr } = await supabase
      .from('rake_records')
      .select('player_contributions')
      .eq('club_id', club.id)
      .gte('created_at', periodStartIso)
      .lt('created_at', periodEnd.toISOString());

    if (rakeErr) {
      result.errors.push(`rake_records scan club=${club.id}: ${rakeErr.message}`);
      continue;
    }

    // Aggregate by user
    const userRake = new Map<string, number>();
    for (const row of rakeRows ?? []) {
      const contribs = (row.player_contributions ?? {}) as Record<string, number | string>;
      for (const [uid, amt] of Object.entries(contribs)) {
        const n = parseFloat(String(amt ?? 0));
        if (!Number.isFinite(n) || n <= 0) continue;
        userRake.set(uid, (userRake.get(uid) ?? 0) + n);
      }
    }

    for (const [userId] of userRake) {
      try {
        // 2. Skip if already paid for this period
        const { data: existing } = await supabase
          .from('rakeback_periods')
          .select('id, status')
          .eq('club_id', club.id)
          .eq('user_id', userId)
          .eq('period_start', periodStartDate)
          .maybeSingle();

        if (existing?.status === 'paid') {
          result.periods_skipped_already_paid += 1;
          continue;
        }

        // 3. Open the period (or reuse existing pending row)
        let periodId = existing?.id as string | null;
        if (!periodId) {
          const { data: openRpc, error: openErr } = await supabase.rpc(
            'fn_create_settlement_period',
            {
              p_club_id: club.id,
              p_user_id: userId,
              p_period_start: periodStartDate,
              p_period_end: periodEndDate,
            },
          );
          if (openErr) {
            result.errors.push(`open ${club.id}/${userId}: ${openErr.message}`);
            continue;
          }
          periodId = openRpc as unknown as string;
          result.periods_opened += 1;
        }

        // 4. Close the period (writes rakeback_period_payouts + credits wallet)
        const { data: closeRpc, error: closeErr } = await supabase.rpc(
          'fn_close_settlement_period',
          { p_period_id: periodId },
        );
        if (closeErr) {
          result.errors.push(`close ${periodId}: ${closeErr.message}`);
          continue;
        }
        const closeResult = closeRpc as { success?: boolean; payout?: number };
        if (closeResult?.success) {
          result.periods_closed += 1;
          result.total_payout += closeResult.payout ?? 0;
        }

        result.users_processed += 1;
      } catch (err) {
        result.errors.push(`club ${club.id} user ${userId}: ${(err as Error).message}`);
      }
    }
  }

  return c.json({
    ok: result.errors.length === 0,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    period_start: periodStartDate,
    period_end: periodEndDate,
    ...result,
  });
}
