/**
 * GET/POST /cron/freeroll-qualification-sync
 *
 * Ported from pages/api/cron/freeroll-qualification-sync.js (341 lines).
 *
 * 4×/day: For each commander_freerolls row in status=qualifying|upcoming
 * with qualification_type=cash_hours, aggregate
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

  // Points may score leaderboards, but never qualify players for a benefit.
  // Targeted requests must refuse the retired mode as well as the bulk scan.
  if (syncType !== 'cash_hours') {
    return {
      freeroll_id: freeroll.id,
      name: freeroll.name,
      status: 'skipped',
      reason: syncType === 'tournament_points' ? 'points_rewards_retired' : `${syncType} type`,
    };
  }
  const playerData = await getCashHoursPerPlayer(freeroll.venue_id, dateRange);

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

    const hours = parseFloat(row.hours.toFixed(2));
    const isQualified = threshold > 0 && hours >= threshold;

    const payload = {
      freeroll_id: freeroll.id,
      player_id: pid,
      player_name: row.player_name,
      hours_logged: hours,
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
        .in('qualification_type', ['cash_hours'])
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
