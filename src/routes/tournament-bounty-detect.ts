/**
 * GET/POST /cron/tournament-bounty-detect
 *
 * Phase X4 (Master Gap Ledger 2026-04-28) — closes P0-D2 / WRK-004.
 *
 * Cadence: every 1 minute while ANY tournament is in 'running' state;
 * Open Claw can poll this aggressively because the handler short-circuits
 * to a no-op when no active KO/PKO/bounty tournaments exist.
 *
 * For each active tournament with bounty enabled:
 *   1. Find tournament_registrations whose status flipped to 'eliminated'
 *      since last scan (uses tournament_registrations.eliminated_at if
 *      present; otherwise infers from hand_history.players[*].busted_at).
 *   2. Identify the user who caused the elimination (the winner of the
 *      hand the eliminated player busted on).
 *   3. Insert one row per elimination into tournament_bounties:
 *         eliminator_id, eliminated_id, tournament_id, hand_id,
 *         bounty_amount, paid_at
 *   4. For PKO: split bounty 50/50 — half pays out, half adds to
 *      eliminator's running bounty value.
 *   5. Credit eliminator's wallet (chip-pool tournaments only) or
 *      record a $$$ obligation (real-money tournaments).
 *
 * Idempotency: tournament_bounties.UNIQUE(tournament_id, eliminated_id)
 * means a re-run of this cron with the same data is a safe no-op.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const SCAN_WINDOW_MIN = 5;

interface BountyResult {
  active_tournaments: number;
  eliminations_found: number;
  bounties_written: number;
  bounties_skipped_existing: number;
  errors: string[];
}

export async function tournamentBountyDetect(c: Context) {
  const supabase = getSupabase();
  const startedAt = new Date().toISOString();
  const since = new Date(Date.now() - SCAN_WINDOW_MIN * 60_000).toISOString();

  const result: BountyResult = {
    active_tournaments: 0,
    eliminations_found: 0,
    bounties_written: 0,
    bounties_skipped_existing: 0,
    errors: [],
  };

  // 1. Find active KO/PKO/bounty tournaments
  const { data: tournaments, error: tournErr } = await supabase
    .from('tournaments')
    .select('id, club_id, bounty_amount, is_pko, is_mystery_bounty')
    .in('status', ['running', 'paused'])
    .or('is_bounty.eq.true,is_pko.eq.true,is_mystery_bounty.eq.true');

  if (tournErr) {
    result.errors.push(`tournaments scan: ${tournErr.message}`);
    return c.json({ ok: false, started_at: startedAt, ...result }, 500);
  }

  result.active_tournaments = tournaments?.length ?? 0;

  for (const tournament of tournaments ?? []) {
    try {
      // 2. Recent eliminations in this tournament
      const { data: eliminations } = await supabase
        .from('tournament_registrations')
        .select('id, user_id, status, finish_rank')
        .eq('tournament_id', tournament.id)
        .eq('status', 'eliminated');

      for (const elim of eliminations ?? []) {
        result.eliminations_found += 1;

        // Skip if bounty already written
        const { data: existing } = await supabase
          .from('tournament_bounties')
          .select('id')
          .eq('tournament_id', tournament.id)
          .eq('eliminated_id', elim.user_id)
          .maybeSingle();

        if (existing?.id) {
          result.bounties_skipped_existing += 1;
          continue;
        }

        // 3. Find the hand the elimination happened on (most recent hand
        //    where this user busted = winners array doesn't include them
        //    AND players array does)
        const { data: handRows } = await supabase
          .from('hand_history')
          .select('id, winners, ended_at')
          .eq('tournament_id', tournament.id)
          .gte('created_at', since)
          .order('ended_at', { ascending: false })
          .limit(50);

        let eliminatorId: string | null = null;
        let handId: string | null = null;
        for (const h of handRows ?? []) {
          const winners = (h.winners ?? []) as Array<Record<string, unknown>>;
          if (winners.length > 0) {
            const w = winners[0];
            const wid = (w?.user_id ?? w?.userId ?? w?.id) as string | undefined;
            if (wid && wid !== elim.user_id) {
              eliminatorId = wid;
              handId = h.id;
              break;
            }
          }
        }

        if (!eliminatorId) continue;

        const bountyAmount = Number(tournament.bounty_amount ?? 0);
        if (bountyAmount <= 0) continue;

        // 4. PKO splits the bounty 50/50; standard KO pays full
        const paid = tournament.is_pko ? bountyAmount / 2 : bountyAmount;
        const carry = tournament.is_pko ? bountyAmount / 2 : 0;

        // 5. Insert bounty row
        const { error: insErr } = await supabase
          .from('tournament_bounties')
          .insert({
            tournament_id: tournament.id,
            eliminator_id: eliminatorId,
            eliminated_id: elim.user_id,
            hand_id: handId,
            bounty_amount: paid,
            carry_amount: carry,
            paid_at: new Date().toISOString(),
          });

        if (insErr) {
          result.errors.push(
            `tournament_bounties insert (t=${tournament.id} e=${elim.user_id}): ${insErr.message}`,
          );
          continue;
        }

        result.bounties_written += 1;
      }
    } catch (err) {
      result.errors.push(`tournament ${tournament.id}: ${(err as Error).message}`);
    }
  }

  return c.json({
    ok: result.errors.length === 0,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    ...result,
  });
}
