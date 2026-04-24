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
 * Idempotent via status check (only 'active' matches touched; after
 * update they're 'abandoned' or 'complete').
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

    const refundPlayer = async (playerId: string | null, amount: number) => {
      if (!playerId) return;
      await supabase.rpc('add_diamonds_to_balance', {
        p_user_id: playerId,
        p_amount: amount,
        p_type: 'pvp_refund',
        p_description: `PvP match abandoned — ${amount}diamonds refund`,
        p_reference_id: null,
      });
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
        await supabase.rpc('add_diamonds_to_balance', {
          p_user_id: winnerId,
          p_amount: winnerPayout,
          p_type: 'pvp_win',
          p_description: `PvP forfeit win — ${winnerPayout}diamonds payout`,
          p_reference_id: matchId,
        });
      }
      await supabase
        .from('trivia_pvp_matches')
        .update({ status: 'complete', winner_id: winnerId, completed_at: new Date().toISOString() })
        .eq('id', matchId);
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
    for (const match of abandonedMatches) {
      const p1Submitted = match.player1_score !== null;
      const p2Submitted = match.player2_score !== null;
      const stakeAmount = match.stake_amount ?? 10;

      if (!p1Submitted && !p2Submitted) {
        await refundPlayer(match.player1_id, stakeAmount);
        await refundPlayer(match.player2_id, stakeAmount);
        await supabase.from('trivia_pvp_matches').update({ status: 'abandoned' }).eq('id', match.id);
        refunded++;
      } else if (p1Submitted && !p2Submitted) {
        await awardForfeitWin(match.player1_id, match.player2_id, stakeAmount, match.id);
        forfeited++;
      } else if (!p1Submitted && p2Submitted) {
        await awardForfeitWin(match.player2_id, match.player1_id, stakeAmount, match.id);
        forfeited++;
      }
    }

    // Expire stale queue entries
    await supabase
      .from('trivia_pvp_queue')
      .update({ status: 'expired' })
      .eq('status', 'waiting')
      .lt('created_at', new Date(now.getTime() - 5 * 60 * 1000).toISOString());

    return c.json({
      success: true,
      refunded,
      forfeited,
      timestamp: now.toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[trivia-pvp-cleanup] fatal:', msg);
    return c.json({ error: msg }, 500);
  }
}
