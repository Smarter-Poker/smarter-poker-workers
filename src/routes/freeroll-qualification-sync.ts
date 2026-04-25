/**
 * GET/POST /cron/freeroll-qualification-sync
 *
 * Ported from pages/api/cron/freeroll-qualification-sync.js (341 lines).
 *
 * 4×/day: For each commander_freerolls row in status=qualifying|upcoming
 * with qualification_type in (cash_hours, tournament_points), aggregate
 * the relevant per-player metric over the freeroll's qualification_period
 * window and upsert into commander_freeroll_qualifications. Marks players
 * as is_qualified=true once they cross qualification_threshold.
 *
 * Manual qualifications (manually_added=true AND is_qualified=true) are
 * preserved — they're never overwritten by the auto-sync.
 *
 * Idempotent — same window + same data → same upsert payload. Manual
 * overrides survive across runs.
 *
 * Optional ?freeroll_id=<uuid> or POST body.freeroll_id targets a single
 * freeroll instead of the bulk scan.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const POSITION_POINTS: Record<number, number> = {
  1: 100,
  2: 75,
  3: 60,
  4: 50,
  5: 40,
  6: 30,
  7: 25,
  8: 20,
  9: 15,
  10: 10,
};

function getPointsForPosition(pos: number | null | undefined): number {
  if (!pos || pos < 1) return 0;
  return POSITION_POINTS[pos] ?? 5;
}

interface Freeroll {
  id: string;
  name: string;
  venue_id: string;
  qualification_period: string;
  qualification_threshold: number | string | null;
  qualification_type: string;
  qualification_game_types?: unknown;
  qualification_min_stakes?: unknown;
  status: string;
  created_at: string;
  scheduled_date?: string | null;
}

interface DateRange {
  start: string;
  end: string;
}

function getQualificationDateRange(period: string, freeroll: Freeroll): DateRange {
  const now = new Date();
  let start: Date;
  switch (period) {
    case 'daily':
      start = new Date(now);
      start.setHours(0, 0, 0, 0);
      break;
    case 'weekly':
      start = new Date(now);
      start.setDate(start.getDate() - start.getDay());
      start.setHours(0, 0, 0, 0);
      break;
    case 'monthly':
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'season':
    case 'custom':
      start = new Date(freeroll.created_at);
      break;
    default:
      start = new Date(now);
      start.setDate(start.getDate() - 7);
  }
  return { start: start.toISOString(), end: now.toISOString() };
}

interface PlayerHoursRow {
  player_id: string;
  player_name: string;
  hours: number;
}
type PlayerHours = Record<string, PlayerHoursRow>;

async function getCashHoursPerPlayer(
  venueId: string,
  dateRange: DateRange,
): Promise<PlayerHours> {
  const { data, error } = await getSupabase()
    .from('commander_player_sessions')
    .select('player_id, player_name, total_time_minutes, check_in_at, check_out_at')
    .eq('venue_id', venueId)
    .gte('check_in_at', dateRange.start)
    .lte('check_in_at', dateRange.end)
    .not('player_id', 'is', null)
    .limit(5000);

  if (error) {
    console.warn('[freeroll-qualification-sync] cash hours query error:', error.message);
    return {};
  }

  const sessions = (data ?? []) as Array<{
    player_id: string;
    player_name: string | null;
    total_time_minutes: number | null;
    check_in_at: string | null;
    check_out_at: string | null;
  }>;

  const playerHours: PlayerHours = {};
  for (const s of sessions) {
    const pid = s.player_id;
    if (!playerHours[pid]) {
      playerHours[pid] = {
        player_id: pid,
        player_name: s.player_name ?? 'Unknown',
        hours: 0,
      };
    }
    let minutes = s.total_time_minutes ?? 0;
    if (!minutes && s.check_in_at) {
      const checkIn = new Date(s.check_in_at);
      const checkOut = s.check_out_at ? new Date(s.check_out_at) : new Date();
      minutes = (checkOut.getTime() - checkIn.getTime()) / 60000;
    }
    playerHours[pid]!.hours += minutes / 60;
  }

  return playerHours;
}

interface PlayerPointsRow {
  player_id: string;
  player_name: string;
  points: number;
  tournaments_played: number;
}
type PlayerPoints = Record<string, PlayerPointsRow>;

async function getTournamentPointsPerPlayer(
  venueId: string,
  dateRange: DateRange,
): Promise<PlayerPoints> {
  const supabase = getSupabase();

  const { data: tournamentsData, error: tError } = await supabase
    .from('commander_tournaments')
    .select('id')
    .eq('venue_id', venueId)
    .gte('scheduled_start', dateRange.start)
    .lte('scheduled_start', dateRange.end)
    .in('status', ['completed', 'running', 'final_table'])
    .limit(100);

  if (tError) {
    console.warn('[freeroll-qualification-sync] tournament query error:', tError.message);
    return {};
  }

  const tournaments = (tournamentsData ?? []) as Array<{ id: string }>;
  if (tournaments.length === 0) return {};

  const tournamentIds = tournaments.map((t) => t.id);

  const { data: entriesData, error: eError } = await supabase
    .from('commander_tournament_entries')
    .select('player_id, player_name, finish_position, tournament_id')
    .in('tournament_id', tournamentIds)
    .not('player_id', 'is', null)
    .limit(5000);

  if (eError) {
    console.warn(
      '[freeroll-qualification-sync] tournament entries query error:',
      eError.message,
    );
    return {};
  }

  const entries = (entriesData ?? []) as Array<{
    player_id: string;
    player_name: string | null;
    finish_position: number | null;
    tournament_id: string;
  }>;

  const playerPoints: PlayerPoints = {};
  for (const e of entries) {
    const pid = e.player_id;
    if (!playerPoints[pid]) {
      playerPoints[pid] = {
        player_id: pid,
        player_name: e.player_name ?? 'Unknown',
        points: 0,
        tournaments_played: 0,
      };
    }
    playerPoints[pid]!.tournaments_played++;
    if (e.finish_position) {
      playerPoints[pid]!.points += getPointsForPosition(e.finish_position);
    } else {
      playerPoints[pid]!.points += 5;
    }
  }

  return playerPoints;
}

interface SyncResult {
  freeroll_id: string;
  name: string;
  status: 'synced' | 'skipped' | 'error';
  reason?: string;
  players_processed?: number;
  players_qualified?: number;
  total_players_found?: number;
  date_range?: DateRange;
  error?: string;
}

async function syncFreeroll(freeroll: Freeroll): Promise<SyncResult> {
  const supabase = getSupabase();
  const dateRange = getQualificationDateRange(freeroll.qualification_period, freeroll);
  const threshold = parseFloat(String(freeroll.qualification_threshold ?? 0)) || 0;
  const syncType = freeroll.qualification_type;

  let playerData: PlayerHours | PlayerPoints = {};

  if (syncType === 'cash_hours') {
    playerData = await getCashHoursPerPlayer(freeroll.venue_id, dateRange);
  } else if (syncType === 'tournament_points') {
    playerData = await getTournamentPointsPerPlayer(freeroll.venue_id, dateRange);
  } else if (syncType === 'open') {
    return {
      freeroll_id: freeroll.id,
      name: freeroll.name,
      status: 'skipped',
      reason: 'open type',
    };
  } else if (syncType === 'custom') {
    return {
      freeroll_id: freeroll.id,
      name: freeroll.name,
      status: 'skipped',
      reason: 'custom type',
    };
  }

  const { data: existingData } = await supabase
    .from('commander_freeroll_qualifications')
    .select('player_id, manually_added, is_qualified')
    .eq('freeroll_id', freeroll.id)
    .limit(100);

  const existingQuals = (existingData ?? []) as Array<{
    player_id: string;
    manually_added: boolean | null;
    is_qualified: boolean | null;
  }>;

  const manualPlayerIds = new Set(
    existingQuals
      .filter((q) => q.manually_added && q.is_qualified)
      .map((q) => q.player_id),
  );

  let upserted = 0;
  let qualified = 0;

  for (const pid of Object.keys(playerData)) {
    if (manualPlayerIds.has(pid)) continue;

    const row = playerData[pid];
    if (!row) continue;

    const hours =
      syncType === 'cash_hours' && 'hours' in row
        ? parseFloat((row as PlayerHoursRow).hours.toFixed(2))
        : 0;
    const points =
      syncType === 'tournament_points' && 'points' in row
        ? (row as PlayerPointsRow).points
        : 0;

    let isQualified = false;
    if (threshold > 0) {
      if (syncType === 'cash_hours' && hours >= threshold) isQualified = true;
      if (syncType === 'tournament_points' && points >= threshold) isQualified = true;
    }

    const payload = {
      freeroll_id: freeroll.id,
      player_id: pid,
      player_name: row.player_name,
      hours_logged: hours,
      points_earned: points,
      is_qualified: isQualified,
      qualified_at: isQualified ? new Date().toISOString() : null,
      manually_added: false,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from('commander_freeroll_qualifications')
      .upsert(payload, {
        onConflict: 'freeroll_id,player_id',
        ignoreDuplicates: false,
      });

    if (error) {
      console.warn(
        `[freeroll-qualification-sync] upsert error for player ${pid}:`,
        error.message,
      );
    } else {
      upserted++;
      if (isQualified) qualified++;
    }
  }

  return {
    freeroll_id: freeroll.id,
    name: freeroll.name,
    status: 'synced',
    players_processed: upserted,
    players_qualified: qualified,
    total_players_found: Object.keys(playerData).length,
    date_range: dateRange,
  };
}

export async function freerollQualificationSync(c: Context) {
  try {
    const supabase = getSupabase();

    let specificFreerollId: string | undefined;
    try {
      const body = (await c.req.json().catch(() => ({}))) as { freeroll_id?: string };
      specificFreerollId = body.freeroll_id;
    } catch {
      /* no body */
    }
    if (!specificFreerollId) specificFreerollId = c.req.query('freeroll_id');

    let freerollsRes;
    if (specificFreerollId) {
      freerollsRes = await supabase
        .from('commander_freerolls')
        .select('*')
        .eq('id', specificFreerollId)
        .limit(100);
    } else {
      freerollsRes = await supabase
        .from('commander_freerolls')
        .select('*')
        .in('status', ['qualifying', 'upcoming'])
        .in('qualification_type', ['cash_hours', 'tournament_points'])
        .limit(100);
    }

    const { data: freerollsData, error: fetchError } = freerollsRes;
    if (fetchError) {
      console.warn('[freeroll-qualification-sync] fetch error:', fetchError.message);
      return c.json({ error: fetchError.message }, 500);
    }

    const freerolls = (freerollsData ?? []) as Freeroll[];

    if (freerolls.length === 0) {
      return c.json({
        success: true,
        message: 'No qualifying freerolls to sync',
        synced: 0,
      });
    }

    const results: SyncResult[] = [];
    for (const freeroll of freerolls) {
      try {
        const result = await syncFreeroll(freeroll);
        results.push(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[freeroll-qualification-sync] sync error for freeroll ${freeroll.id}:`,
          msg,
        );
        results.push({
          freeroll_id: freeroll.id,
          name: freeroll.name,
          status: 'error',
          error: msg,
        });
      }
    }

    return c.json({
      success: true,
      synced: results.filter((r) => r.status === 'synced').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      errors: results.filter((r) => r.status === 'error').length,
      results,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[freeroll-qualification-sync] fatal:', msg);
    return c.json({ error: msg }, 500);
  }
}
