/**
 * GET/POST /cron/daily-challenges
 *
 * Ported from pages/api/cron/daily-challenges.js (146 lines).
 *
 * Daily at midnight UTC: generate a new training_daily_challenges row
 * with a rotated game, scaled level, weekend-boosted rewards, then enqueue
 * Club Arena Daily Mission reset alerts for players who explicitly opted in.
 * Both paths are idempotent and the alert RPC is retried even when the
 * training row already exists, so a partial prior run self-heals.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const TRAINING_GAMES = [
  'raise-first-in',
  '3bet-defense',
  'board-texture-analysis',
  'cbet-strategy',
  'pot-odds-math',
  'position-awareness',
  'range-construction',
  'bluff-catching',
  'value-betting',
  'tournament-icm',
];

const ALERT_BATCH_SIZE = 1000;
const MAX_ALERT_BATCHES = 100;

async function enqueueMissionResetAlerts(
  supabase: ReturnType<typeof getSupabase>,
  challengeDate: string,
): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < MAX_ALERT_BATCHES; batch += 1) {
    const { data, error } = await supabase.rpc('enqueue_daily_mission_reset_notifications', {
      p_cycle_date: challengeDate,
      p_limit: ALERT_BATCH_SIZE,
    });
    if (error) throw new Error(error.message || 'Daily Mission alert enqueue failed');
    const inserted = Number(data);
    if (!Number.isInteger(inserted) || inserted < 0) {
      throw new Error('Daily Mission alert enqueue returned an invalid receipt');
    }
    total += inserted;
    if (inserted < ALERT_BATCH_SIZE) return total;
  }
  throw new Error('Daily Mission alert enqueue exceeded the batch safety limit');
}

export async function dailyChallenges(c: Context) {
  try {
    const supabase = getSupabase();
    const today = new Date();
    const challengeDate = today.toISOString().split('T')[0]!;

    const { data: existing } = await supabase
      .from('training_daily_challenges')
      .select('id')
      .eq('challenge_date', challengeDate)
      .maybeSingle();

    let trainingChallengeCreated = false;
    let trainingChallenge: Record<string, unknown> | null = null;

    if (!existing) {
      const dayOfMonth = today.getDate();
      const dayOfWeek = today.getDay();
      const startOfYear = new Date(today.getFullYear(), 0, 0);
      const dayOfYear = Math.floor(
        (today.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24),
      );
      const gameIndex = dayOfYear % TRAINING_GAMES.length;
      const gameId = TRAINING_GAMES[gameIndex] ?? TRAINING_GAMES[0]!;
      const level = Math.min((dayOfMonth % 10) || 10, 10);
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      const requiredAccuracy = isWeekend ? 90 : 85;
      const bonusDiamonds = isWeekend ? 100 : 50;

      const { error } = await supabase
        .from('training_daily_challenges')
        .insert({
          challenge_date: challengeDate,
          game_id: gameId,
          level,
          required_accuracy: requiredAccuracy,
          bonus_diamonds: bonusDiamonds,
        });

      if (error) {
        console.warn('[daily-challenges] insert error:', error.message);
        return c.json({ error: error.message }, 500);
      }

      trainingChallengeCreated = true;
      trainingChallenge = {
        date: challengeDate,
        game: gameId,
        level,
        requiredAccuracy,
        bonusDiamonds,
      };
    }

    const missionAlertsQueued = await enqueueMissionResetAlerts(supabase, challengeDate);

    return c.json({
      success: true,
      challengeDate,
      trainingChallengeCreated,
      challenge: trainingChallenge,
      missionAlertsQueued,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[daily-challenges] fatal:', msg);
    return c.json({ error: msg }, 500);
  }
}
