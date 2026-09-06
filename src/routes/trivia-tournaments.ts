/**
 * GET/POST /cron/trivia-tournaments
 *
 * RETIRED 2026-09-06. This route permanently moves zero diamonds.
 *
 * The legacy worker independently created, started, cancelled and refunded
 * Trivia tournaments. Phase 1 keeps competitive Trivia fail-closed while one
 * server-owned, versioned 8 PM America/Chicago lifecycle is built in World
 * Hub. Keeping an authenticated tombstone makes stale callers visible without
 * allowing this worker to read or mutate tournament, balance or ledger state.
 */
import type { Context } from 'hono';

export async function triviaTournaments(c: Context) {
  console.warn(
    '[trivia-tournaments] RETIRED route called. Competitive Trivia lifecycle ' +
      'is disabled. Nothing was read, created, cancelled, refunded, or paid.',
  );

  c.header('Cache-Control', 'no-store');
  return c.json(
    {
      success: false,
      retired: true,
      diamonds_moved: 0,
      tournaments_created: 0,
      tournaments_started: 0,
      tournaments_cancelled: 0,
      error: 'trivia_tournaments_route_retired',
      message:
        'This legacy tournament lifecycle is permanently retired and cannot move diamonds.',
      replacement: 'World Hub release-controlled nightly Trivia lifecycle',
      retired_at: '2026-09-06',
    },
    410,
  );
}
