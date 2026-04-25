/**
 * GET/POST /cron/hard-stop
 *
 * Ported from pages/api/cron/hard-stop.js (293 lines).
 *
 * Every minute: auto-close commander cash games at the venue's scheduled
 * CST hard-stop time. Per venue with hard_stop_enabled=true:
 *   1. Match current CST HH:MM to venue.hard_stop_time exactly
 *   2. Skip if already triggered today (last_hard_stop_date == cst.dateStr)
 *   3. Close cash tables (status active|open AND mode != 'tournament')
 *   4. End cash table sessions, awarding auto-comp by elapsed-min × auto_comp_rate
 *   5. Clear cash seats
 *   6. End any remaining active sessions for the venue (bulk fallback)
 *   7. Set room_open=false + last_hard_stop_date for double-trigger prevention
 *   8. Insert commander_activity_log row (best-effort)
 *
 * Idempotence: last_hard_stop_date guard prevents re-firing within the same
 * CST day. Time-string match (cst.timeStr === venue.hard_stop_time) gives
 * exactly one minute of trigger window per venue per day.
 *
 * Auth: /cron/* middleware chain (Bearer + IP allowlist).
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

interface VenueSetting {
  venue_id: string;
  hard_stop_time: string | null;
  room_open: boolean | null;
  last_hard_stop_date: string | null;
  auto_comp_rate: number | string | null;
}

interface CSTTime {
  hour: number;
  minute: number;
  dateStr: string;
  timeStr: string;
  isoNow: string;
}

interface VenueResult {
  venue_id: string;
  status: 'triggered' | 'already_triggered_today';
  tables_closed?: number;
  table_sessions_ended?: number;
  time_sessions_ended?: number;
  comps_awarded?: number;
}

function getCSTTime(): CSTTime {
  const now = new Date();
  const cst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const year = cst.getFullYear();
  const month = String(cst.getMonth() + 1).padStart(2, '0');
  const day = String(cst.getDate()).padStart(2, '0');
  const hour = cst.getHours();
  const minute = cst.getMinutes();
  return {
    hour,
    minute,
    dateStr: `${year}-${month}-${day}`,
    timeStr: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    isoNow: now.toISOString(),
  };
}

export async function hardStop(c: Context) {
  const supabase = getSupabase();

  try {
    const { data: venuesData, error: fetchError } = await supabase
      .from('commander_venue_settings')
      .select('venue_id, hard_stop_time, room_open, last_hard_stop_date, auto_comp_rate')
      .eq('hard_stop_enabled', true)
      .not('hard_stop_time', 'is', null)
      .limit(100);

    if (fetchError) {
      console.warn('[hard-stop] fetch error:', fetchError.message);
      return c.json({ error: fetchError.message }, 500);
    }

    const venues = (venuesData ?? []) as VenueSetting[];
    if (venues.length === 0) {
      return c.json({ message: 'No venues with hard stop enabled', triggered: 0 });
    }

    const cst = getCSTTime();
    let triggered = 0;
    const results: VenueResult[] = [];

    for (const venue of venues) {
      const stopTime = venue.hard_stop_time;
      if (!stopTime) continue;
      if (cst.timeStr !== stopTime) continue;

      // Double-trigger prevention
      if (venue.last_hard_stop_date === cst.dateStr) {
        results.push({ venue_id: venue.venue_id, status: 'already_triggered_today' });
        continue;
      }

      // 1. Close cash tables (NEVER touch tournament tables)
      const { data: openTablesData } = await supabase
        .from('commander_tables')
        .select('id')
        .eq('venue_id', venue.venue_id)
        .in('status', ['active', 'open'])
        .neq('mode', 'tournament')
        .limit(100);
      const openTables = openTablesData ?? [];

      if (openTables.length > 0) {
        await supabase
          .from('commander_tables')
          .update({ status: 'closed', updated_at: cst.isoNow })
          .eq('venue_id', venue.venue_id)
          .in('status', ['active', 'open'])
          .neq('mode', 'tournament');
      }

      // 2. End cash table sessions + auto-comp awards
      let compsAwarded = 0;

      // Get tournament table numbers to exclude
      const { data: tournTablesData } = await supabase
        .from('commander_tables')
        .select('table_number')
        .eq('venue_id', venue.venue_id)
        .eq('mode', 'tournament')
        .limit(100);
      const tournTableNums = (tournTablesData ?? [])
        .map((t: { table_number: number | string | null }) => t.table_number)
        .filter((n): n is number | string => n !== null && n !== undefined);

      let sessionQuery = supabase
        .from('commander_table_sessions')
        .select('id, member_id, started_at, table_number')
        .eq('venue_id', venue.venue_id)
        .eq('status', 'active')
        .limit(100);

      if (tournTableNums.length > 0) {
        sessionQuery = sessionQuery.not('table_number', 'in', `(${tournTableNums.join(',')})`);
      }

      const { data: tableSessionsData } = await sessionQuery;
      const tableSessions = (tableSessionsData ?? []) as Array<{
        id: string;
        member_id: string | null;
        started_at: string | null;
        table_number: number | string | null;
      }>;

      if (tableSessions.length > 0) {
        const autoCompRate = parseFloat(String(venue.auto_comp_rate ?? '0')) || 0;

        if (autoCompRate > 0) {
          for (const ts of tableSessions) {
            if (!ts.member_id || !ts.started_at) continue;
            try {
              const elapsedMin = Math.floor(
                (new Date(cst.isoNow).getTime() - new Date(ts.started_at).getTime()) / 60000,
              );
              const compEarned = Math.round((elapsedMin / 60) * autoCompRate * 100) / 100;
              if (compEarned <= 0) continue;

              const { data: memberData } = await supabase
                .from('commander_members')
                .select('comp_balance, comp_lifetime_earned')
                .eq('id', ts.member_id)
                .maybeSingle();

              const member = memberData as
                | { comp_balance: number | null; comp_lifetime_earned: number | null }
                | null;
              if (!member) continue;

              const newBalance =
                Math.round(((member.comp_balance ?? 0) + compEarned) * 100) / 100;
              const newLifetime =
                Math.round(((member.comp_lifetime_earned ?? 0) + compEarned) * 100) / 100;

              await supabase
                .from('commander_members')
                .update({
                  comp_balance: newBalance,
                  comp_lifetime_earned: newLifetime,
                  updated_at: cst.isoNow,
                })
                .eq('id', ts.member_id);

              await supabase.from('commander_member_comp_log').insert({
                venue_id: venue.venue_id,
                member_id: ts.member_id,
                amount: compEarned,
                type: 'auto_hourly',
                reason: `Auto comp (hard stop): ${elapsedMin} min × $${autoCompRate}/hr`,
                balance_after: newBalance,
              });

              compsAwarded += compEarned;
            } catch (compErr) {
              console.warn(
                `[hard-stop] auto-comp error for member ${ts.member_id}:`,
                compErr instanceof Error ? compErr.message : compErr,
              );
            }
          }
        }

        // End cash sessions by ID (precise) instead of bulk venue update
        const sessionIds = tableSessions.map((s) => s.id);
        await supabase
          .from('commander_table_sessions')
          .update({
            status: 'ended',
            ended_at: cst.isoNow,
            updated_at: cst.isoNow,
          })
          .in('id', sessionIds);

        // Clear cash seats only (skip tournament tables)
        let seatQuery = supabase
          .from('commander_table_seats')
          .update({
            status: 'empty',
            player_name: null,
            member_id: null,
            seated_at: null,
          })
          .eq('venue_id', venue.venue_id)
          .eq('status', 'occupied');

        if (tournTableNums.length > 0) {
          seatQuery = seatQuery.not('table_number', 'in', `(${tournTableNums.join(',')})`);
        }
        await seatQuery;
      }

      // 3. End any remaining active time-billing sessions (bulk fallback)
      const { data: activeSessionsData } = await supabase
        .from('commander_table_sessions')
        .select('id')
        .eq('venue_id', venue.venue_id)
        .eq('status', 'active')
        .limit(100);
      const activeSessions = activeSessionsData ?? [];

      if (activeSessions.length > 0) {
        await supabase
          .from('commander_table_sessions')
          .update({
            status: 'ended',
            end_time: cst.isoNow,
            end_reason: 'hard_stop',
            updated_at: cst.isoNow,
          })
          .eq('venue_id', venue.venue_id)
          .eq('status', 'active');
      }

      // 4. Set room closed + record trigger date
      await supabase
        .from('commander_venue_settings')
        .update({
          room_open: false,
          last_hard_stop_date: cst.dateStr,
          updated_at: cst.isoNow,
        })
        .eq('venue_id', venue.venue_id);

      // 5. Activity log (best-effort)
      try {
        await supabase.from('commander_activity_log').insert({
          venue_id: venue.venue_id,
          action: 'hard_stop',
          details: `Hard stop triggered at ${stopTime} CST. Closed ${openTables.length} tables, ended ${tableSessions.length} table sessions + ${activeSessions.length} time sessions. Auto-comps: $${compsAwarded.toFixed(2)}.`,
          created_at: cst.isoNow,
        });
      } catch {
        /* activity log table may not exist yet */
      }

      triggered++;
      results.push({
        venue_id: venue.venue_id,
        status: 'triggered',
        tables_closed: openTables.length,
        table_sessions_ended: tableSessions.length,
        time_sessions_ended: activeSessions.length,
        comps_awarded: compsAwarded,
      });
    }

    return c.json({
      message: 'Hard stop check complete',
      current_time_cst: cst.timeStr,
      venues_checked: venues.length,
      triggered,
      results,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[hard-stop] fatal:', msg);
    return c.json({ error: 'Internal server error', details: msg }, 500);
  }
}
