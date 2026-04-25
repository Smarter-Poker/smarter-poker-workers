/**
 * GET/POST /cron/daily-challenges
 *
 * Ported from pages/api/cron/daily-challenges.js (146 lines).
 *
 * Daily at midnight UTC: generate a new training_daily_challenges row
 * with a rotated game, scaled level, weekend-boosted rewards. Idempotent
 * via an up-front check on challenge_date — if today's row exists, exit
 * with "already exists" message.
 *
 * Broadcasts a push notification to all profiles after insert (best-effort).
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

export async function dailyChallenges(c: Context) {
  try {
    const supabase = getSupabase();
    const today = new Date();
    const challengeDate = today.toISOString().split('T')[0];

    const { data: existing } = await supabase
      .from('training_daily_challenges')
      .select('id')
      .eq('challenge_date', challengeDate)
      .maybeSingle();

    if (existing) {
      return c.json({ message: 'Daily challenge already exists for today', challengeDate });
    }

    const dayOfMonth = today.getDate();
    const dayOfWeek = today.getDay();
    const startOfYear = new Date(today.getFullYear(), 0, 0);
    const dayOfYear = Math.floor((today.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24));
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
        bonus_xp_multiplier: isWeekend ? 3.0 : 2.0,
        bonus_diamonds: bonusDiamonds,
      });

    if (error) {
      console.warn('[daily-challenges] insert error:', error.message);
      return c.json({ error: error.message }, 500);
    }

    // Best-effort push broadcast
    try {
      const { data: profilesData } = await supabase.from('profiles').select('id');
      const profiles = (profilesData ?? []) as Array<{ id: string }>;
      if (profiles.length > 0) {
        const targetUserIds = profiles.map((p) => p.id);
        const baseUrl = process.env.WORLD_HUB_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://smarter.poker';
        await fetch(`${baseUrl}/api/notifications/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''}`,
          },
          body: JSON.stringify({
            title: 'New Daily Challenge! 🏆',
            message: `Today's Challenge is Live! Test your skills in ${gameId.replace(/-/g, ' ')} for extra diamonds.`,
            url: `${baseUrl}/hub/training/arena`,
            externalUserIds: targetUserIds,
            category: 'daily_challenges',
          }),
        });
      }
    } catch (e) {
      console.warn('[daily-challenges] push broadcast error:', e instanceof Error ? e.message : e);
    }

    return c.json({
      success: true,
      challenge: {
        date: challengeDate,
        game: gameId,
        level,
        requiredAccuracy,
        bonusDiamonds,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[daily-challenges] fatal:', msg);
    return c.json({ error: msg }, 500);
  }
}
