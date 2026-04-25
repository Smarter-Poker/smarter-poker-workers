/**
 * GET/POST /cron/trivia-tournaments
 *
 * Ported from pages/api/cron/trivia-tournaments.js (274 lines).
 *
 * Daily 01:00 UTC (7PM CST): Two-step lifecycle:
 *   1. For each upcoming tournament whose start_time has passed:
 *      - If <2 entries: cancel and refund all entries via
 *        add_diamonds_to_balance RPC; mark cancelled.
 *      - Else: build bracket, seed players, insert Round 1 matchups
 *        with bye auto-advancement; flip status to active.
 *   2. Create the next 7PM CST tournament if one doesn't exist for
 *      that day, sampling 20 random questions.
 *
 * Idempotence: existing-tournament check by start_time day window;
 * status-based filters mean re-running won't re-process started or
 * cancelled tournaments.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const ENTRY_FEE = 25;

interface Tournament {
  id: string;
  name: string;
  status: string;
  start_time: string | null;
  entry_fee: number;
  current_round: number | null;
}

interface Entry {
  id: string;
  user_id: string;
  tournament_id: string;
  created_at: string;
  seed_number: number | null;
}

interface Matchup {
  match_index: number;
  player1_id: string | null;
  player2_id: string | null;
  player1_score: number | null;
  player2_score: number | null;
  winner_id: string | null;
  is_bye: boolean;
}

function getNext7pmCST(): Date {
  const now = new Date();
  const today7pm = new Date(now);
  today7pm.setUTCHours(1, 0, 0, 0);
  today7pm.setUTCDate(today7pm.getUTCDate() + 1);

  const today7pmCheck = new Date(now);
  today7pmCheck.setUTCHours(1, 0, 0, 0);
  if (now.getUTCHours() < 1) return today7pmCheck;

  return today7pm;
}

async function generateBracket(
  tournament: Tournament,
  entries: Entry[],
): Promise<{ totalRounds: number; matchups: Matchup[] }> {
  const supabase = getSupabase();
  const numPlayers = entries.length;
  let bracketSize = 2;
  while (bracketSize < numPlayers) bracketSize *= 2;
  const totalRounds = Math.log2(bracketSize);

  const shuffled = [...entries].sort(() => Math.random() - 0.5);
  for (let i = 0; i < shuffled.length; i++) {
    const e = shuffled[i];
    if (!e) continue;
    await supabase
      .from('trivia_tournament_entries')
      .update({ seed_number: i + 1 })
      .eq('id', e.id);
  }

  const matchups: Matchup[] = [];
  for (let i = 0; i < bracketSize; i += 2) {
    const player1 = shuffled[i] ?? null;
    const player2 = shuffled[i + 1] ?? null;

    const matchup: Matchup = {
      match_index: matchups.length,
      player1_id: player1?.user_id ?? null,
      player2_id: player2?.user_id ?? null,
      player1_score: null,
      player2_score: null,
      winner_id: null,
      is_bye: !player1 || !player2,
    };

    if (matchup.is_bye) {
      matchup.winner_id = player1?.user_id ?? player2?.user_id ?? null;
    }
    matchups.push(matchup);
  }

  const deadline = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await supabase.from('trivia_tournament_rounds').insert({
    tournament_id: tournament.id,
    round_number: 1,
    deadline: deadline.toISOString(),
    status: 'active',
    matchups,
  });

  await supabase
    .from('trivia_tournaments')
    .update({
      status: 'active',
      current_round: 1,
      total_rounds: totalRounds,
      round_deadline: deadline.toISOString(),
    })
    .eq('id', tournament.id);

  const notifications = entries.map((e) => ({
    user_id: e.user_id,
    tournament_id: tournament.id,
    notification_type: 'round_start',
    message: `Round 1 of ${tournament.name} has started! You have 24 hours to play.`,
  }));

  if (notifications.length > 0) {
    await supabase.from('trivia_tournament_notifications').insert(notifications);
  }

  return { totalRounds, matchups };
}

async function cancelAndRefund(tournament: Tournament, entries: Entry[]): Promise<void> {
  const supabase = getSupabase();
  for (const entry of entries) {
    await supabase.rpc('add_diamonds_to_balance', {
      p_user_id: entry.user_id,
      p_amount: tournament.entry_fee,
      p_type: 'tournament_refund',
      p_description: `Tournament cancelled — ${tournament.name} (${tournament.entry_fee}diamonds refund)`,
      p_reference_id: tournament.id,
    });

    await supabase.from('trivia_tournament_notifications').insert({
      user_id: entry.user_id,
      tournament_id: tournament.id,
      notification_type: 'eliminated',
      message: `${tournament.name} was cancelled — not enough players. Your ${tournament.entry_fee}diamonds has been refunded.`,
    });
  }

  await supabase
    .from('trivia_tournaments')
    .update({ status: 'cancelled' })
    .eq('id', tournament.id);
}

export async function triviaTournaments(c: Context) {
  try {
    const supabase = getSupabase();
    const now = new Date();
    const results: { created: string | null; started: unknown; cancelled: string | null } = {
      created: null,
      started: null,
      cancelled: null,
    };

    // 1. Process upcoming tournaments past start_time
    const { data: upcomingData } = await supabase
      .from('trivia_tournaments')
      .select('*')
      .eq('status', 'upcoming')
      .lte('start_time', now.toISOString())
      .limit(100);

    const upcomingTournaments = (upcomingData ?? []) as Tournament[];

    for (const tournament of upcomingTournaments) {
      const { data: entriesData } = await supabase
        .from('trivia_tournament_entries')
        .select('*')
        .eq('tournament_id', tournament.id)
        .order('created_at', { ascending: true })
        .limit(100);

      const entries = (entriesData ?? []) as Entry[];

      if (entries.length < 2) {
        await cancelAndRefund(tournament, entries);
        results.cancelled = tournament.id;
        continue;
      }

      const bracketResult = await generateBracket(tournament, entries);
      results.started = {
        id: tournament.id,
        players: entries.length,
        rounds: bracketResult.totalRounds,
      };
    }

    // 2. Create next 7PM CST tournament if missing
    const tomorrow7pmCST = getNext7pmCST();
    const startOfDay = new Date(tomorrow7pmCST);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = new Date(tomorrow7pmCST);
    endOfDay.setUTCHours(23, 59, 59, 999);

    const { data: existingTournament } = await supabase
      .from('trivia_tournaments')
      .select('id')
      .gte('start_time', startOfDay.toISOString())
      .lt('start_time', endOfDay.toISOString())
      .limit(1)
      .maybeSingle();

    if (!existingTournament) {
      const { data: questionsData } = await supabase
        .from('trivia_questions')
        .select('*')
        .limit(100);

      const questions = (questionsData ?? []) as Array<Record<string, unknown>>;
      const tournamentQuestions = [...questions]
        .sort(() => Math.random() - 0.5)
        .slice(0, 20);

      const { data: newTournamentData, error } = await supabase
        .from('trivia_tournaments')
        .insert({
          name: `Daily Championship — ${tomorrow7pmCST.toLocaleDateString('en-US', {
            weekday: 'long',
            month: 'short',
            day: 'numeric',
          })}`,
          start_time: tomorrow7pmCST.toISOString(),
          end_time: null,
          entry_fee: ENTRY_FEE,
          prize_pool: 0,
          questions: tournamentQuestions,
          status: 'upcoming',
          tournament_type: 'bracket',
          current_round: 0,
          created_at: now.toISOString(),
        })
        .select()
        .maybeSingle();

      if (!error && newTournamentData) {
        results.created = (newTournamentData as { id: string }).id;
      }
    }

    return c.json({
      success: true,
      results,
      timestamp: now.toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[trivia-tournaments] fatal:', msg);
    return c.json({ error: msg }, 500);
  }
}
