/**
 * GET/POST /cron/trivia-pvp-cleanup
 *
 * Ported from pages/api/cron/trivia-pvp-cleanup.js (172 lines).
 *
 * Hourly: find trivia_pvp_matches stuck in 'active' status >10min.
 * - Neither player scored → refund both stakes, mark 'abandoned'
 * - Only one scored → that player wins by forfeit, 10% rake
 * - Also expire trivia_pvp_queue entries >5min old
 *
 * IDEMPOTENCY (rewritten 2026-08-23 after a 10-day currency leak).
 * The claim that this route was "idempotent via status check" was false in
 * both halves:
 *   1. `.update({ status: 'abandoned' })` was rejected by
 *      trivia_pvp_matches_status_check, which did not list 'abandoned'. The
 *      result was never destructured, so the 23514 was invisible - the money
 *      had already moved and the match stayed 'active'.
 *   2. The refund passed `p_reference_id: null`, and add_diamonds_to_balance
 *      only deduplicates when a reference is present.
 * So the same four matches were refunded every four hours from 2026-08-13 to
 * 2026-08-23: 488 credits, 14,240 diamonds minted against 120 in real stakes.
 *
 * Every credit now carries the SAME reference the player-facing settlement
 * engine uses (pvp_refund_<matchId>_<userId>, pvp_match_win_<matchId>), so
 * the two paths deduplicate against each other, and the database now REFUSES
 * a settlement credit with a null reference outright. Every write that closes
 * a match is checked and throws, because a status write that silently fails
 * is what turns one bad refund into an unbounded series.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

interface Match {
  id: string;
  player1_id: string | null;
  player2_id: string | null;
  player1_score: number | null;
  player2_score: number | null;
  stake_amount: number | null;
}

interface PlayerStats {
  wins?: number;
  losses?: number;
  ties?: number;
  win_streak?: number;
  best_streak?: number;
  total_diamonds_won?: number;
  total_diamonds_lost?: number;
}

export async function triviaPvpCleanup(c: Context) {
  try {
    const supabase = getSupabase();
    const now = new Date();
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);

    /**
     * Move diamonds and REFUSE to continue quietly if the move did not happen.
     * add_diamonds_to_balance returns { success: false, duplicate: true } on a
     * replay, which is exactly what a retry wants to hear - that is the only
     * failure treated as success here.
     */
    const creditDiamonds = async (
      userId: string,
      amount: number,
      type: string,
      description: string,
      referenceId: string,
    ) => {
      const { data, error } = await supabase.rpc('add_diamonds_to_balance', {
        p_user_id: userId,
        p_amount: amount,
        p_type: type,
        p_description: description,
        p_reference_id: referenceId,
      });
      const res = data as { success?: boolean; duplicate?: boolean; error?: string } | null;
      if (res?.duplicate) return { credited: false, deduped: true };
      if (error || res?.success === false) {
        throw new Error(
          `credit failed (${type}, ref ${referenceId}): ${error?.message ?? res?.error ?? 'unknown'}`,
        );
      }
      return { credited: true, deduped: false };
    };

    /**
     * Close a match, and throw if the close did not land. This is the write
     * that failed silently for ten days; an unchecked terminal write turns a
     * one-off payout into a schedule.
     */
    const closeMatch = async (matchId: string, patch: Record<string, unknown>) => {
      const { error } = await supabase
        .from('trivia_pvp_matches')
        .update(patch)
        .eq('id', matchId);
      if (error) {
        throw new Error(`could not close match ${matchId}: ${error.message}`);
      }
    };

    const refundPlayer = async (
      playerId: string | null,
      amount: number,
      matchId: string,
    ) => {
      if (!playerId) return;
      await creditDiamonds(
        playerId,
        amount,
        'pvp_refund',
        `PvP match abandoned - ${amount} diamonds refunded`,
        `pvp_refund_${matchId}_${playerId}`,
      );
    };

    const updatePlayerStats = async (
      playerId: string | null,
      outcome: 'win' | 'loss',
      diamondsDelta: number,
    ) => {
      if (!playerId) return;
      const { data: current } = await supabase
        .from('trivia_pvp_stats')
        .select('*')
        .eq('user_id', playerId)
        .maybeSingle();
      const prev = (current as PlayerStats | null) ?? {};
      const winStreak =
        outcome === 'win' ? (prev.win_streak ?? 0) + 1 : 0;
      const updates = {
        user_id: playerId,
        wins: outcome === 'win' ? (prev.wins ?? 0) + 1 : prev.wins ?? 0,
        losses: outcome === 'loss' ? (prev.losses ?? 0) + 1 : prev.losses ?? 0,
        ties: prev.ties ?? 0,
        win_streak: winStreak,
        best_streak:
          outcome === 'win'
            ? Math.max(winStreak, prev.best_streak ?? 0)
            : prev.best_streak ?? 0,
        total_diamonds_won:
          outcome === 'win'
            ? (prev.total_diamonds_won ?? 0) + (diamondsDelta || 0)
            : prev.total_diamonds_won ?? 0,
        total_diamonds_lost:
          outcome === 'loss'
            ? (prev.total_diamonds_lost ?? 0) + (diamondsDelta || 0)
            : prev.total_diamonds_lost ?? 0,
        updated_at: new Date().toISOString(),
      };
      await supabase.from('trivia_pvp_stats').upsert(updates, { onConflict: 'user_id' });
    };

    const awardForfeitWin = async (
      winnerId: string | null,
      loserId: string | null,
      stakeAmount: number,
      matchId: string,
    ) => {
      const totalPot = stakeAmount * 2;
      const rakeAmount = Math.floor(totalPot * 0.1);
      const winnerPayout = totalPot - rakeAmount;
      if (winnerId) {
        // pvp_match_win_<matchId> is the reference pvp-settle-match.js has
        // always used. Sharing it means a settle/sweep race is a no-op instead
        // of a double payout. The bare matchId used before was a raw uuid in a
        // globally unique reference index - a collision waiting to happen.
        await creditDiamonds(
          winnerId,
          winnerPayout,
          'pvp_win',
          `PvP forfeit win - ${winnerPayout} diamonds payout`,
          `pvp_match_win_${matchId}`,
        );
      }
      await closeMatch(matchId, {
        status: 'complete',
        winner_id: winnerId,
        completed_at: new Date().toISOString(),
      });
      await updatePlayerStats(winnerId, 'win', winnerPayout - stakeAmount);
      await updatePlayerStats(loserId, 'loss', stakeAmount);
    };

    const { data: matchesData } = await supabase
      .from('trivia_pvp_matches')
      .select('*')
      .eq('status', 'active')
      .lt('created_at', tenMinutesAgo.toISOString())
      .limit(100);
    const abandonedMatches = (matchesData ?? []) as Match[];

    let refunded = 0;
    let forfeited = 0;
    const failures: Array<{ match_id: string; error: string }> = [];
    for (const match of abandonedMatches) {
      const p1Submitted = match.player1_score !== null;
      const p2Submitted = match.player2_score !== null;
      const stakeAmount = match.stake_amount ?? 10;

      try {
        if (!p1Submitted && !p2Submitted) {
          await refundPlayer(match.player1_id, stakeAmount, match.id);
          await refundPlayer(match.player2_id, stakeAmount, match.id);
          await closeMatch(match.id, { status: 'abandoned' });
          refunded++;
        } else if (p1Submitted && !p2Submitted) {
          await awardForfeitWin(match.player1_id, match.player2_id, stakeAmount, match.id);
          forfeited++;
        } else if (!p1Submitted && p2Submitted) {
          await awardForfeitWin(match.player2_id, match.player1_id, stakeAmount, match.id);
          forfeited++;
        }
      } catch (err) {
        // One bad match must not abort the sweep, but it must be LOUD and it
        // must be counted. Silence here is the whole incident.
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[trivia-pvp-cleanup] match failed:', match.id, msg);
        failures.push({ match_id: match.id, error: msg });
      }
    }

    // Expire stale queue entries
    await supabase
      .from('trivia_pvp_queue')
      .update({ status: 'expired' })
      .eq('status', 'waiting')
      .lt('created_at', new Date(now.getTime() - 5 * 60 * 1000).toISOString());

    return c.json({
      success: failures.length === 0,
      scanned: abandonedMatches.length,
      refunded,
      forfeited,
      failures,
      timestamp: now.toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[trivia-pvp-cleanup] fatal:', msg);
    return c.json({ error: msg }, 500);
  }
}
