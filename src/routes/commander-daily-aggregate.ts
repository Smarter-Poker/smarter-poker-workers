/**
 * GET/POST /cron/commander-daily-aggregate
 *
 * Ported from pages/api/cron/commander-daily-aggregate.js (197 lines).
 *
 * Daily 04:00: aggregate yesterday's data for every active poker_venue
 * into commander_analytics_daily. Per venue, fans out 7 parallel
 * Promise.all queries (sessions, tournaments, waitlist, time billing,
 * cash, awards, incidents) for the day window, computes ~25 metrics,
 * upserts on (venue_id, date).
 *
 * Optional ?date=YYYY-MM-DD or POST body.date overrides yesterday.
 *
 * Idempotent: ON CONFLICT (venue_id, date) DO UPDATE — same query
 * over same data writes the same row.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

interface Venue {
  id: string;
  name: string;
}

interface Session {
  id: string;
  player_id: string | null;
  total_time_minutes: number | string | null;
  total_buyin: number | string | null;
  games_played: number | null;
}

interface Tournament {
  id: string;
  current_entries: number | null;
  buyin_amount: number | string | null;
  buyin_fee: number | string | null;
  prize_pool: number | string | null;
  status: string | null;
}

interface WaitlistRow {
  id: string;
  status: string | null;
  created_at: string;
  called_at: string | null;
  seated_at: string | null;
}

interface TimeBilling {
  id: string;
  duration_minutes: number | null;
  amount_charged: number | string | null;
}

interface CashTx {
  id: string;
  type: string | null;
  amount: number | string | null;
}

interface Award {
  id: string;
  prize_value: number | string | null;
}

export async function commanderDailyAggregate(c: Context) {
  try {
    const supabase = getSupabase();

    let targetDate: string | null = null;
    try {
      const body = (await c.req.json().catch(() => ({}))) as { date?: string };
      targetDate = body.date ?? null;
    } catch {
      /* no body */
    }
    if (!targetDate) targetDate = c.req.query('date') ?? null;

    const date =
      targetDate ??
      (() => {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        return d.toISOString().split('T')[0]!;
      })();

    const dayStart = `${date}T00:00:00`;
    const dayEnd = `${date}T23:59:59`;

    const { data: venuesData } = await supabase
      .from('poker_venues')
      .select('id, name')
      .eq('status', 'active')
      .limit(100);

    const venues = (venuesData ?? []) as Venue[];

    if (venues.length === 0) {
      return c.json({ message: 'No active venues', aggregated: 0 });
    }

    const results: Array<Record<string, unknown>> = [];

    for (const venue of venues) {
      try {
        const [
          sessionsRes,
          tournamentsRes,
          waitlistRes,
          timeBillingRes,
          cashRes,
          awardsRes,
          incidentsRes,
        ] = await Promise.all([
          supabase
            .from('commander_player_sessions')
            .select('id, player_id, total_time_minutes, total_buyin, games_played')
            .eq('venue_id', venue.id)
            .gte('check_in_at', dayStart)
            .lt('check_in_at', dayEnd),
          supabase
            .from('commander_tournaments')
            .select('id, current_entries, buyin_amount, buyin_fee, prize_pool, status')
            .eq('venue_id', venue.id)
            .gte('scheduled_start', dayStart)
            .lt('scheduled_start', dayEnd),
          supabase
            .from('commander_waitlist')
            .select('id, status, created_at, called_at, seated_at')
            .eq('venue_id', venue.id)
            .gte('created_at', dayStart)
            .lt('created_at', dayEnd),
          supabase
            .from('commander_table_sessions')
            .select('id, duration_minutes, amount_charged')
            .eq('venue_id', venue.id)
            .gte('created_at', dayStart)
            .lt('created_at', dayEnd),
          supabase
            .from('commander_cash_transactions')
            .select('id, type, amount')
            .eq('venue_id', venue.id)
            .gte('created_at', dayStart)
            .lt('created_at', dayEnd),
          supabase
            .from('commander_promotion_awards')
            .select('id, prize_value')
            .eq('venue_id', venue.id)
            .gte('created_at', dayStart)
            .lt('created_at', dayEnd),
          supabase
            .from('commander_incidents')
            .select('id')
            .eq('venue_id', venue.id)
            .gte('created_at', dayStart)
            .lt('created_at', dayEnd),
        ]);

        const sessions = (sessionsRes.data ?? []) as Session[];
        const tournaments = (tournamentsRes.data ?? []) as Tournament[];
        const waitlist = (waitlistRes.data ?? []) as WaitlistRow[];
        const timeBilling = (timeBillingRes.data ?? []) as TimeBilling[];
        const cashTx = (cashRes.data ?? []) as CashTx[];
        const awards = (awardsRes.data ?? []) as Award[];
        const incidents = (incidentsRes.data ?? []) as Array<{ id: string }>;

        const uniquePlayers = new Set(sessions.map((s) => s.player_id).filter(Boolean));
        const totalMinutes = sessions.reduce(
          (s, x) => s + Number(x.total_time_minutes ?? 0),
          0,
        );
        const totalBuyin = sessions.reduce(
          (s, x) => s + parseFloat(String(x.total_buyin ?? 0)),
          0,
        );

        const seatedEntries = waitlist.filter(
          (w) => w.status === 'seated' && w.seated_at && w.created_at,
        );
        const waitTimes = seatedEntries.map(
          (w) =>
            (new Date(w.seated_at as string).getTime() - new Date(w.created_at).getTime()) /
            60000,
        );
        const avgWaitMinutes =
          waitTimes.length > 0 ? waitTimes.reduce((a, b) => a + b, 0) / waitTimes.length : 0;
        const noShows = waitlist.filter((w) => w.status === 'no_show').length;

        const timeRevenue = timeBilling.reduce(
          (s, x) => s + parseFloat(String(x.amount_charged ?? 0)),
          0,
        );
        const totalTableHours =
          timeBilling.reduce((s, x) => s + Number(x.duration_minutes ?? 0), 0) / 60;

        const buyIns = cashTx.filter((t) => t.type === 'buy_in' || t.type === 'add_on');
        const cashOuts = cashTx.filter((t) => t.type === 'cash_out');
        const totalCashIn = buyIns.reduce((s, x) => s + parseFloat(String(x.amount ?? 0)), 0);
        const totalCashOut = cashOuts.reduce(
          (s, x) => s + parseFloat(String(x.amount ?? 0)),
          0,
        );

        const tournamentFees = tournaments.reduce(
          (s, t) => s + Number(t.current_entries ?? 0) * parseFloat(String(t.buyin_fee ?? 0)),
          0,
        );
        const tournamentPrizePool = tournaments.reduce(
          (s, t) => s + parseFloat(String(t.prize_pool ?? 0)),
          0,
        );

        const analytics = {
          venue_id: venue.id,
          date,
          total_sessions: sessions.length,
          unique_players: uniquePlayers.size,
          total_play_hours: parseFloat((totalMinutes / 60).toFixed(2)),
          avg_session_hours:
            sessions.length > 0
              ? parseFloat((totalMinutes / 60 / sessions.length).toFixed(2))
              : 0,
          total_buyin: totalBuyin,
          total_cashout: totalCashOut,
          avg_buyin: sessions.length > 0 ? Math.round(totalBuyin / sessions.length) : 0,
          tournaments_run: tournaments.length,
          tournament_entries: tournaments.reduce((s, t) => s + Number(t.current_entries ?? 0), 0),
          tournament_fees: tournamentFees,
          tournament_prize_pool: tournamentPrizePool,
          time_revenue: timeRevenue,
          table_hours: parseFloat(totalTableHours.toFixed(2)),
          cash_in: totalCashIn,
          cash_out: totalCashOut,
          net_drop: totalCashIn - totalCashOut,
          waitlist_entries: waitlist.length,
          waitlist_seated: seatedEntries.length,
          waitlist_no_shows: noShows,
          avg_wait_minutes: parseFloat(avgWaitMinutes.toFixed(1)),
          promotions_awarded: awards.length,
          promotion_value_awarded: awards.reduce(
            (s, a) => s + parseFloat(String(a.prize_value ?? 0)),
            0,
          ),
          incidents_count: incidents.length,
          calculated_at: new Date().toISOString(),
        };

        const { error } = await supabase
          .from('commander_analytics_daily')
          .upsert(analytics, { onConflict: 'venue_id,date' });

        if (error) {
          console.warn(`[commander-daily-aggregate] error for ${venue.name}:`, error.message);
          results.push({ venue: venue.name, status: 'error', error: error.message });
        } else {
          results.push({
            venue: venue.name,
            status: 'ok',
            players: uniquePlayers.size,
            sessions: sessions.length,
          });
        }
      } catch (venueErr) {
        const msg = venueErr instanceof Error ? venueErr.message : String(venueErr);
        console.warn(`[commander-daily-aggregate] venue ${venue.name} error:`, msg);
        results.push({ venue: venue.name, status: 'error', error: msg });
      }
    }

    return c.json({
      success: true,
      date,
      venues_processed: results.length,
      results,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[commander-daily-aggregate] fatal:', msg);
    return c.json({ error: msg }, 500);
  }
}
