/**
 * GET/POST /cron/venue-game-alerts
 *
 * Ported from pages/api/cron/venue-game-alerts.js (2026-04-24).
 *
 * Every hour (dispatcher schedule): scan venue_game_alerts subscriptions
 * vs. venue_live_tables. When a user's alert-game is running at their
 * alert-venue AND the 4h cooldown has expired, fires a push notification
 * via the /api/notifications/send endpoint on World Hub.
 *
 * Idempotence guards:
 *   - 4-hour cooldown via alert.last_triggered (read → compare → write)
 *   - Flip to STAGGERED in Open Claw so Mac+Hetzner don't race the cooldown
 *     window (see .memory/context/phase-2a2-full-cron-audit.md)
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours — matches monolith

interface VenueGameAlert {
  id: string;
  user_id: string;
  venue_name: string | null;
  game_type: string | null;
  last_triggered: string | null;
  active: boolean;
}

interface LiveTable {
  venue_name: string | null;
  game_name: string | null;
  tables_running: number | null;
  source: string | null;
}

interface MatchResult {
  alert_id: string;
  venue: string | null;
  game: string | null;
  tables_running: number;
}

export async function venueGameAlerts(c: Context) {
  const supabase = getSupabase();
  const now = Date.now();
  const results: {
    checked_at: string;
    matches: MatchResult[];
    notifications_sent: number;
    message?: string;
  } = {
    checked_at: new Date().toISOString(),
    matches: [],
    notifications_sent: 0,
  };

  try {
    // 1. Load all active alerts. Table may not exist yet in some envs — 200 + message.
    let alerts: VenueGameAlert[] = [];
    try {
      const { data, error } = await supabase
        .from('venue_game_alerts')
        .select('*')
        .eq('active', true);
      if (error) {
        console.warn('[venue-game-alerts] query failed (table may not exist):', error.message);
        return c.json({ ...results, message: 'Alerts table not available yet' });
      }
      alerts = (data ?? []) as VenueGameAlert[];
    } catch {
      return c.json({ ...results, message: 'Alerts system not initialized' });
    }
    if (alerts.length === 0) {
      return c.json({ ...results, message: 'No active alerts' });
    }

    // 2. Load live tables (bounded to 5000 rows like the monolith)
    let liveTables: LiveTable[] = [];
    try {
      const { data, error } = await supabase
        .from('venue_live_tables')
        .select('venue_name, game_name, tables_running, source')
        .limit(5000);
      if (error) {
        console.warn('[venue-game-alerts] live_tables query failed:', error.message);
        return c.json({ ...results, message: 'Live tables data not available' });
      }
      liveTables = (data ?? []) as LiveTable[];
    } catch {
      return c.json({ ...results, message: 'Live tables system not initialized' });
    }

    // 3. Match each alert against the live-table snapshot
    const baseUrl = process.env.WORLD_HUB_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://smarter.poker';
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

    for (const alert of alerts) {
      const alertVenue = alert.venue_name?.toLowerCase().trim() ?? '';
      const alertGame = alert.game_type?.toLowerCase().trim() ?? '';

      const matchingTables = liveTables.filter((t) => {
        const venueMatch = t.venue_name?.toLowerCase().trim() === alertVenue;
        const tableGame = t.game_name?.toLowerCase().trim() ?? '';
        const gameMatch = tableGame.startsWith(alertGame) || tableGame.includes(alertGame);
        return venueMatch && gameMatch;
      });
      if (matchingTables.length === 0) continue;

      // Cooldown check
      const lastTriggered = alert.last_triggered ? new Date(alert.last_triggered).getTime() : 0;
      if (now - lastTriggered < COOLDOWN_MS) continue;

      const totalRunning = matchingTables.reduce((s, t) => s + (t.tables_running ?? 1), 0);

      results.matches.push({
        alert_id: alert.id,
        venue: alert.venue_name,
        game: alert.game_type,
        tables_running: totalRunning,
      });

      // Fire push via World Hub's internal notifications endpoint
      try {
        await fetch(`${baseUrl}/api/notifications/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${serviceRoleKey}`,
          },
          body: JSON.stringify({
            title: `${alert.game_type} is Running`,
            message: `${alert.venue_name} has ${totalRunning} ${alert.game_type} table${totalRunning > 1 ? 's' : ''} running right now.`,
            url: `${baseUrl}/hub/poker-near-me/live-games`,
            externalUserIds: [alert.user_id],
            category: 'venue_alerts',
          }),
        });
        results.notifications_sent++;
      } catch (pushErr) {
        console.warn(
          '[venue-game-alerts] push failed:',
          pushErr instanceof Error ? pushErr.message : String(pushErr),
        );
      }

      // Update last_triggered so the next cycle respects cooldown
      await supabase
        .from('venue_game_alerts')
        .update({ last_triggered: new Date().toISOString() })
        .eq('id', alert.id);
    }

    return c.json(results);
  } catch (err) {
    console.error(
      '[venue-game-alerts] fatal:',
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: err instanceof Error ? err.message : 'unknown' }, 500);
  }
}
