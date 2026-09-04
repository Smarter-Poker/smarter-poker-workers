/**
 * Where the collusion detector got to, and how far forward it may go.
 *
 * WHY (2026-09-04)
 * ----------------
 * The scan ran EVERY 30 MINUTES over a ROLLING 24-HOUR WINDOW, so it re-read
 * every hand up to 48 times. That was survivable at 136,000 hands a day and
 * fatal at 770,000: from 2026-09-03 02:00 UTC it stopped returning at all -
 * not slow, never finished - and the only trace was the container's own
 * sweeper marking the row `killed` half an hour later.
 *
 * The same overlap produced the other symptom. Re-scanning a hand 48 times
 * means re-INSERTING its findings 48 times, and the handler has always
 * inserted rather than upserted: `collusion_tracking` holds 169,530 rows for
 * 81,323 distinct (pair, pattern) triples, a 2.1x duplication that is purely
 * an artefact of the window.
 *
 * So the fix is not a bigger timeout. It is to stop asking "what happened in
 * the last 24 hours" and start asking "what has happened since I last
 * looked", which makes the cost proportional to the platform's RATE rather
 * than its HISTORY - about 15,000 hands per run instead of 700,000.
 *
 * The mark lives in Postgres (`ca_collusion_scan_state`, one row) rather than
 * in this process, because the container restarts on every deploy and a mark
 * that resets on restart is not a mark. `fn_ca_collusion_scan_advance` owns
 * the advance rule so no caller can rewind it or jump it past now.
 */
import { getSupabase } from './supabase.js';

/**
 * The most ground one run may cover.
 *
 * A long outage must not turn the next run into the unbounded read this whole
 * change exists to remove. Six hours at a 30-minute cadence means a gap
 * closes at roughly twelve times real time - a day of downtime is caught up
 * in about two hours of running - while any single run stays bounded.
 */
export const MAX_SPAN_HOURS = 6;

export interface ScanState {
  lastWindowEnd: Date;
  lastSuccessAt: Date | null;
  secondsBehind: number | null;
}

/** Read the mark. Throws rather than guessing: a wrong window is worse than no scan. */
export async function readScanState(): Promise<ScanState> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('fn_ca_collusion_scan_state');
  if (error) throw new Error(`scan state read failed: ${error.message}`);
  if (!data || typeof data !== 'object') {
    throw new Error('scan state read returned no payload');
  }
  const row = data as Record<string, unknown>;
  const end = row.last_window_end ? new Date(String(row.last_window_end)) : null;
  if (!end || Number.isNaN(end.getTime())) {
    throw new Error('scan state has no usable last_window_end');
  }
  const success = row.last_success_at ? new Date(String(row.last_success_at)) : null;
  return {
    lastWindowEnd: end,
    lastSuccessAt: success && !Number.isNaN(success.getTime()) ? success : null,
    secondsBehind:
      typeof row.seconds_behind === 'number' ? row.seconds_behind : null,
  };
}

/**
 * The window this run should cover: from the mark, forward, capped.
 *
 * `end` is never in the future and never more than MAX_SPAN_HOURS past the
 * mark. When the platform is quiet the window is short and the run is cheap;
 * when it is behind, the window is a full span and the run catches up.
 */
export function windowFromState(state: ScanState, now: Date = new Date()): { start: Date; end: Date } {
  const start = state.lastWindowEnd;
  const capped = new Date(start.getTime() + MAX_SPAN_HOURS * 3600_000);
  const end = capped.getTime() < now.getTime() ? capped : now;
  // A mark ahead of now (clock skew, or a hand-edited row) must not produce a
  // backwards window, which PostgREST would happily read as "no rows" and the
  // scan would report as a clean bill of health.
  return { start, end: end.getTime() > start.getTime() ? end : start };
}

/**
 * Move the mark, and only ever over ground actually read.
 *
 * `coveredTo` is the window end when the read completed, or the last row's
 * timestamp when it stopped on a budget - so an interrupted run leaves a
 * contiguous unscanned tail rather than a hole, and the next run picks it up.
 *
 * Best effort by design: the findings are already written by the time this
 * runs, and failing the whole scan because a bookkeeping write failed would
 * turn a good run into a retry that re-does the work.
 */
export async function advanceScanState(args: {
  coveredTo: Date;
  scannedHands: number;
  findings: number;
  durationMs: number;
  budgetHit: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const supabase = getSupabase();
    const { error } = await supabase.rpc('fn_ca_collusion_scan_advance', {
      p_window_end: args.coveredTo.toISOString(),
      p_scanned_hands: args.scannedHands,
      p_findings: args.findings,
      p_duration_ms: args.durationMs,
      p_budget_hit: args.budgetHit,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'advance failed';
    console.warn('[collusion-scan] state advance failed:', msg);
    return { ok: false, error: msg };
  }
}
