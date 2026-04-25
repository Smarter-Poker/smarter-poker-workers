/**
 * GET/POST /cron/trivia-tournament-rounds
 *
 * Ported from pages/api/cron/trivia-tournament-rounds.js (366 lines).
 *
 * Hourly: advance trivia tournament rounds.
 *   1. Send forfeit warnings to players whose round deadline is in <1h
 *      (dedup via 2h-window check on forfeit_warning notifications).
 *   2. For rounds whose deadline has passed:
 *      - Resolve each matchup: both played → higher score wins (random
 *        on tie); one played → forfeit; neither → random advance.
 *      - Mark round complete, eliminate losers (set eliminated_round),
 *        notify them, then either:
 *        a. Final round done → complete tournament and distribute
 *           prizes (50/30/20% to top 3, 10% house rake).
 *        b. Otherwise → create next round matchups + notifications.
 *
 * Prize pool = entries × entry_fee × 90% (10% rake). Winners ranked:
 * tournament winner first, then finalist (lost in final round), then
 * earlier-eliminated players sorted by eliminated_round desc.
 *
 * Idempotence: status filters (active vs complete) prevent re-processing
 * the same round; forfeit-warning 2h-window check prevents duplicate
 * notifications.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const HOUSE_RAKE_PERCENT = 10;

interface Tournament {
  id: string;
  name: string;
  entry_fee: number;
  total_rounds: number | null;
}

interface Matchup {
  match_index: number;
  player1_id: string | null;
  player2_id: string | null;
  player1_score: number | null;
  player2_score: number | null;
  winner_id: string | null;
  is_bye: boolean;
  player1_forfeited?: boolean;
  player2_forfeited?: boolean;
  both_forfeited?: boolean;
}

interface Round {
  id: string;
  tournament_id: string;
  round_number: number;
  deadline: string;
  status: string;
  matchups: Matchup[] | null;
  trivia_tournaments: Tournament | null;
}

interface Entry {
  id: string;
  user_id: string;
  tournament_id: string;
  entry_fee: number | null;
  eliminated_round: number | null;
  score: number | null;
  prize_won: number | null;
  placement: number | null;
  profiles?: { username: string | null } | null;
}

async function createNextRound(
  tournament: Tournament,
  winners: string[],
  roundNumber: number,
): Promise<void> {
  const supabase = getSupabase();
  const matchups: Matchup[] = [];

  for (let i = 0; i < winners.length; i += 2) {
    const player1 = winners[i] ?? null;
    const player2 = winners[i + 1] ?? null;
    const matchup: Matchup = {
      match_index: matchups.length,
      player1_id: player1,
      player2_id: player2,
      player1_score: null,
      player2_score: null,
      winner_id: null,
      is_bye: !player1 || !player2,
    };
    if (matchup.is_bye) matchup.winner_id = player1 ?? player2 ?? null;
    matchups.push(matchup);
  }

  const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await supabase.from('trivia_tournament_rounds').insert({
    tournament_id: tournament.id,
    round_number: roundNumber,
    deadline: deadline.toISOString(),
    status: 'active',
    matchups,
  });

  await supabase
    .from('trivia_tournaments')
    .update({
      current_round: roundNumber,
      round_deadline: deadline.toISOString(),
    })
    .eq('id', tournament.id);

  const notifications = winners.filter(Boolean).map((userId) => ({
    user_id: userId,
    tournament_id: tournament.id,
    notification_type: 'round_start',
    message: `Round ${roundNumber} of ${tournament.name} has started! You have 24 hours to play.`,
  }));

  if (notifications.length > 0) {
    await supabase.from('trivia_tournament_notifications').insert(notifications);
  }
}

async function completeTournament(
  tournament: Tournament,
  winnerId: string | null,
  finalRound: number,
): Promise<void> {
  const supabase = getSupabase();

  const { data: entriesData } = await supabase
    .from('trivia_tournament_entries')
    .select('*, profiles(username)')
    .eq('tournament_id', tournament.id)
    .order('eliminated_round', { ascending: false, nullsFirst: true })
    .order('score', { ascending: false })
    .limit(100);

  const entries = (entriesData ?? []) as Entry[];

  if (entries.length === 0) {
    await supabase
      .from('trivia_tournaments')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', tournament.id);
    return;
  }

  const totalEntryFees = entries.length * tournament.entry_fee;
  const houseRake = Math.floor((totalEntryFees * HOUSE_RAKE_PERCENT) / 100);
  const prizePool = totalEntryFees - houseRake;

  const prizes = [
    { place: 1, percent: 50 },
    { place: 2, percent: 30 },
    { place: 3, percent: 20 },
  ] as const;

  const tournamentWinner = entries.find((e) => e.user_id === winnerId);
  const stillAlive = entries.filter((e) => e.user_id !== winnerId && !e.eliminated_round);
  const finalLosers = entries.filter((e) => e.eliminated_round === finalRound);
  const earlierLosers = entries
    .filter((e) => e.eliminated_round && e.eliminated_round < finalRound)
    .sort((a, b) => (b.eliminated_round ?? 0) - (a.eliminated_round ?? 0));

  const ranked: Entry[] = [
    ...(tournamentWinner ? [tournamentWinner] : []),
    ...stillAlive,
    ...finalLosers,
    ...earlierLosers,
  ];

  const seen = new Set<string>();
  const uniqueRanked = ranked.filter((e) => {
    if (seen.has(e.user_id)) return false;
    seen.add(e.user_id);
    return true;
  });

  const winners: Array<{ place: number; user_id: string; username: string | null; prize: number }> =
    [];

  const slots = Math.min(3, uniqueRanked.length);
  for (let i = 0; i < slots; i++) {
    const entry = uniqueRanked[i];
    const prizeMeta = prizes[i];
    if (!entry || !prizeMeta) continue;

    const prizeAmount = Math.floor((prizePool * prizeMeta.percent) / 100);

    await supabase.rpc('add_diamonds_to_balance', {
      p_user_id: entry.user_id,
      p_amount: prizeAmount,
      p_type: 'tournament_prize',
      p_description: `#${i + 1} place — ${tournament.name} (${prizeAmount}diamonds)`,
      p_reference_id: tournament.id,
    });

    await supabase
      .from('trivia_tournament_entries')
      .update({ prize_won: prizeAmount, placement: i + 1 })
      .eq('id', entry.id);

    winners.push({
      place: i + 1,
      user_id: entry.user_id,
      username: entry.profiles?.username ?? null,
      prize: prizeAmount,
    });

    await supabase.from('trivia_tournament_notifications').insert({
      user_id: entry.user_id,
      tournament_id: tournament.id,
      notification_type: 'winner',
      message: `🏆 You placed #${i + 1} in ${tournament.name}! You won ${prizeAmount}diamonds!`,
    });
  }

  await supabase
    .from('trivia_tournaments')
    .update({
      status: 'completed',
      prize_pool: prizePool,
      winners,
      completed_at: new Date().toISOString(),
    })
    .eq('id', tournament.id);
}

export async function triviaTournamentRounds(c: Context) {
  try {
    const supabase = getSupabase();
    const now = new Date();
    const results = {
      roundsCompleted: 0,
      roundsAdvanced: 0,
      forfeitWarnings: 0,
      tournamentsFinished: 0,
    };

    // 1. Forfeit warnings
    const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
    const { data: warningData } = await supabase
      .from('trivia_tournament_rounds')
      .select('*, trivia_tournaments(*)')
      .eq('status', 'active')
      .gt('deadline', now.toISOString())
      .lte('deadline', oneHourFromNow.toISOString())
      .limit(100);

    const warningRounds = (warningData ?? []) as Round[];

    for (const round of warningRounds) {
      const matchups = round.matchups ?? [];
      for (const matchup of matchups) {
        if (matchup.winner_id || matchup.is_bye) continue;
        const playersToWarn: string[] = [];
        if (matchup.player1_id && matchup.player1_score === null) playersToWarn.push(matchup.player1_id);
        if (matchup.player2_id && matchup.player2_score === null) playersToWarn.push(matchup.player2_id);

        for (const playerId of playersToWarn) {
          const { data: existing } = await supabase
            .from('trivia_tournament_notifications')
            .select('id')
            .eq('user_id', playerId)
            .eq('tournament_id', round.tournament_id)
            .eq('notification_type', 'forfeit_warning')
            .gte('created_at', new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString())
            .limit(1);

          if (!existing || existing.length === 0) {
            await supabase.from('trivia_tournament_notifications').insert({
              user_id: playerId,
              tournament_id: round.tournament_id,
              notification_type: 'forfeit_warning',
              message: `⚠️ Round ${round.round_number} deadline is in 1 hour! Play now or you'll be disqualified.`,
            });
            results.forfeitWarnings++;
          }
        }
      }
    }

    // 2. Process expired rounds
    const { data: expiredData } = await supabase
      .from('trivia_tournament_rounds')
      .select('*, trivia_tournaments(*)')
      .eq('status', 'active')
      .lte('deadline', now.toISOString())
      .limit(100);

    const expiredRounds = (expiredData ?? []) as Round[];

    for (const round of expiredRounds) {
      const tournament = round.trivia_tournaments;
      if (!tournament) continue;

      const matchups = (round.matchups ?? []).map((m) => {
        if (m.winner_id || m.is_bye) return m;
        const p1Played = m.player1_score !== null;
        const p2Played = m.player2_score !== null;

        if (p1Played && p2Played) {
          if ((m.player1_score ?? 0) > (m.player2_score ?? 0)) m.winner_id = m.player1_id;
          else if ((m.player2_score ?? 0) > (m.player1_score ?? 0)) m.winner_id = m.player2_id;
          else m.winner_id = Math.random() < 0.5 ? m.player1_id : m.player2_id;
        } else if (p1Played && !p2Played) {
          m.winner_id = m.player1_id;
          m.player2_forfeited = true;
        } else if (!p1Played && p2Played) {
          m.winner_id = m.player2_id;
          m.player1_forfeited = true;
        } else {
          m.winner_id = m.player1_id ?? m.player2_id;
          m.both_forfeited = true;
        }
        return m;
      });

      await supabase
        .from('trivia_tournament_rounds')
        .update({ status: 'complete', matchups })
        .eq('id', round.id);

      for (const m of matchups) {
        const loserId =
          m.player1_id === m.winner_id ? m.player2_id : m.player1_id;
        if (loserId) {
          await supabase
            .from('trivia_tournament_entries')
            .update({ eliminated_round: round.round_number })
            .eq('tournament_id', tournament.id)
            .eq('user_id', loserId);

          await supabase.from('trivia_tournament_notifications').insert({
            user_id: loserId,
            tournament_id: tournament.id,
            notification_type: 'eliminated',
            message: `You've been eliminated in Round ${round.round_number} of ${tournament.name}.`,
          });
        }
      }

      results.roundsCompleted++;

      const winners = matchups
        .map((m) => m.winner_id)
        .filter((w): w is string => !!w);

      if (winners.length <= 1 || round.round_number >= (tournament.total_rounds ?? 999)) {
        await completeTournament(tournament, winners[0] ?? null, round.round_number);
        results.tournamentsFinished++;
      } else {
        await createNextRound(tournament, winners, round.round_number + 1);
        results.roundsAdvanced++;
      }
    }

    return c.json({
      success: true,
      results,
      timestamp: now.toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[trivia-tournament-rounds] fatal:', msg);
    return c.json({ error: msg }, 500);
  }
}
