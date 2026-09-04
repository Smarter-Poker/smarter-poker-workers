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

/**
 * How far back from `now` the window's END is held, and why it is not zero.
 *
 * `hand_history.created_at` defaults to `now()`, which in Postgres is the
 * TRANSACTION START time, not the commit time. A hand that starts at 12:00:00
 * and commits at 12:00:00.4 is stamped 12:00:00 and becomes visible 400ms
 * later. A window ending at exactly `now` therefore reads rows that are
 * already committed, moves the mark past them, and the next window starts
 * AFTER the timestamp of hands that were still in flight - so those hands are
 * never read by anything, forever, and nothing reports a gap because both runs
 * completed cleanly.
 *
 * That is the same silent-hole failure as the 106,238 hands scanWindow.ts
 * exists for, in miniature, once per run. Sixty seconds is far beyond any
 * observed hand-insert latency here (p99 well under a second) and costs only
 * that the scan trails a minute behind live, which no integrity finding is
 * time-critical enough to care about.
 */
export const COMMIT_LAG_MS = 60_000;

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
  // The ceiling is now MINUS the commit lag, never now itself: a hand in
  // flight carries a created_at that is already inside the window but is not
  // yet visible to read. See COMMIT_LAG_MS.
  const ceiling = new Date(now.getTime() - COMMIT_LAG_MS);
  const capped = new Date(start.getTime() + MAX_SPAN_HOURS * 3600_000);
  const end = capped.getTime() < ceiling.getTime() ? capped : ceiling;
  // A mark ahead of the ceiling (clock skew, a hand-edited row, or simply a
  // run inside the last minute) must not produce a backwards window, which
  // PostgREST reads as "no rows" and the scan would report as a clean bill of
  // health. An empty window is the honest answer there.
  return { start, end: end.getTime() > start.getTime() ? end : start };
}

/**
 * Move the mark, and only ever over ground actually read.
 *
 * `coveredTo` is the window end when the read completed, or the last row's
 * timestamp when it stopped early - so an interrupted run leaves a contiguous
 * unscanned tail rather than a hole, and the next run picks it up.
 *
 * `moreToRead` IS NOT "the time budget ran out". It was called `budgetHit`
 * and the caller passed only the budget flag, which was wrong in the most
 * common case there is: a six-hour catch-up span holds ~148,000 hands against
 * a 40,000-row ceiling, so EVERY catch-up run stops on the ROW CAP, in about
 * seven seconds, nowhere near the budget. The flag was therefore false for the
 * entire ~18 hours of a catch-up, and the console - which renders it as
 * `catching_up` - showed a detector calmly up to date while it was a day
 * behind. The honest question is "is there more in this window than this run
 * read", whichever limit bound first, so that is the question the field asks
 * now.
 *
 * IT RETURNS ok:false RATHER THAN THROWING, and the caller must treat that as
 * a failed run. A findings write that lands while the mark does not is not a
 * success: the next run re-reads the same window, re-inserts the same
 * findings, and does that forever while every log row says `success`. This
 * used to answer 200.
 */
export async function advanceScanState(args: {
  coveredTo: Date;
  scannedHands: number;
  findings: number;
  durationMs: number;
  /** True when the window holds more than this run read, for any reason. */
  moreToRead: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.rpc('fn_ca_collusion_scan_advance', {
      p_window_end: args.coveredTo.toISOString(),
      p_scanned_hands: args.scannedHands,
      p_findings: args.findings,
      p_duration_ms: args.durationMs,
      p_budget_hit: args.moreToRead,
    });
    if (error) throw new Error(error.message);
    // The RPC answers {ok:false, reason} when it matched no row - a missing
    // state row, or a row somebody deleted. A transport-level success with a
    // refusal inside it is still a refusal.
    const payload = (data ?? null) as { ok?: unknown; reason?: unknown } | null;
    if (!payload || payload.ok !== true) {
      const reason = payload && typeof payload.reason === 'string' ? payload.reason : 'unknown';
      throw new Error(`advance refused: ${reason}`);
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'advance failed';
    console.warn('[collusion-scan] state advance failed:', msg);
    return { ok: false, error: msg };
  }
}
