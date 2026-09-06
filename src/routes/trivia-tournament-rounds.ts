/**
 * GET/POST /cron/trivia-tournament-rounds
 *
 * RETIRED 2026-09-06. This route permanently moves zero diamonds.
 *
 * The legacy hourly worker independently advanced brackets, chose forfeits
 * and ties, and paid tournament prizes. Phase 1 removes that second decision
 * and payout authority. Authentication remains enforced by the shared
 * /cron/* middleware chain in index.ts; both methods terminate here.
 */
import type { Context } from 'hono';

export async function triviaTournamentRounds(c: Context) {
  console.warn(
    '[trivia-tournament-rounds] RETIRED route called. Competitive Trivia ' +
      'round settlement is disabled. Nothing was read, advanced, or paid.',
  );

  c.header('Cache-Control', 'no-store');
  return c.json(
    {
      success: false,
      retired: true,
      diamonds_moved: 0,
      rounds_advanced: 0,
      tournaments_finished: 0,
      error: 'trivia_tournament_rounds_route_retired',
      message:
        'This legacy round settlement is permanently retired and cannot move diamonds.',
      replacement: 'World Hub release-controlled nightly Trivia lifecycle',
      retired_at: '2026-09-06',
    },
    410,
  );
}
