/**
 * GET/POST /cron/trivia-pvp-cleanup
 *
 * RETIRED 2026-09-06. This route permanently moves zero diamonds.
 *
 * The legacy worker was a second PvP settlement owner. Every four hours it
 * found old matches, issued refunds or forfeit payouts, updated player stats,
 * and closed matches. That overlapped the release-controlled settlement paths
 * in World Hub, so retries or races could let two independent processes decide
 * and pay the same match.
 *
 * PvP lifecycle and settlement now belong to World Hub. Keeping an explicit
 * tombstone makes stale schedules and manual calls visible without allowing
 * this worker to read or mutate PvP, balance, or ledger state.
 *
 * Auth remains enforced by the shared /cron/* middleware chain in index.ts.
 * Both registered methods intentionally reach this same terminal response.
 */
import type { Context } from 'hono';

export async function triviaPvpCleanup(c: Context) {
  console.warn(
    '[trivia-pvp-cleanup] RETIRED route called. PvP settlement is owned by ' +
      'World Hub. Nothing was read, settled, refunded, or paid.',
  );

  c.header('Cache-Control', 'no-store');
  return c.json(
    {
      success: false,
      retired: true,
      diamonds_moved: 0,
      refunded: 0,
      forfeited: 0,
      error: 'trivia_pvp_cleanup_route_retired',
      message:
        'This legacy four-hour PvP cleanup is permanently retired and cannot move diamonds.',
      replacement:
        'World Hub release-controlled PvP lifecycle and settlement paths',
      retired_at: '2026-09-06',
    },
    410,
  );
}
