/**
 * GET/POST /cron/cron-staleness-watchdog
 *
 * WHY THIS EXISTS (2026-09-01)
 * ----------------------------
 * One bearer CRON_SECRET was serving two hosts that validate it independently.
 * Vercel's copy was rotated, the private workers VM's was not, and from
 * 2026-08-31 08:59:01 to 2026-09-01 17:21:17 UTC every workers-routed cron
 * returned 401. Four anti-cheat sweeps went dark for a full day of play.
 *
 * Nothing said anything. Not one alert, not one issue, no dashboard row. The
 * outage was noticed because a human observed that the horses had stopped
 * posting. That is the defect this closes: a scheduled job that stops running
 * is indistinguishable, from the outside, from a scheduled job with nothing to
 * do.
 *
 * WHAT IT DOES
 * ------------
 * Groups cron_execution_log by job_name, derives each job's OWN normal cadence
 * from its recent history (median gap between runs over BASELINE_DAYS), and
 * flags any job whose last run is older than that cadence times TOLERANCE.
 *
 * The cadence is derived rather than configured on purpose. A hardcoded table
 * of expected intervals is a second copy of the dispatcher schedule, and a
 * second copy drifts — silently, in the direction of "everything looks fine".
 * A job that has run every 30 minutes for a fortnight and has not run for three
 * hours is late no matter what any config file believes.
 *
 * Findings are written to cron_health_log, which the system-health surface
 * already reads. This job never repairs anything: a watchdog that also fixes
 * things has no independent voice when the repair is what is broken.
 *
 * COVERS EVERY OPEN CLAW JOB, not a subset — money jobs, integrity sweeps,
 * scrapers, content. Do not add a second per-area staleness watchdog beside it.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { pagedSelect } from '../lib/pagedSelect.js';

/** How much history to derive a job's normal cadence from. */
const BASELINE_DAYS = 14;
/** A job is late once it is this many times its own median gap overdue. */
const TOLERANCE = 4;
/** Never flag a job that has run fewer times than this — no reliable baseline. */
const MIN_RUNS_FOR_BASELINE = 5;
/** Floor on the alerting threshold, so a 2-minute job does not alert at 8 minutes. */
const MIN_STALE_MINUTES = 45;

interface RunRow {
  job_name: string;
  started_at: string;
}

export interface StaleJob {
  job_name: string;
  last_run_at: string;
  minutes_since_last_run: number;
  median_gap_minutes: number;
  threshold_minutes: number;
  runs_in_baseline: number;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Pure so it can be tested without a database. `runs` need not be sorted.
 */
export function findStaleJobs(runs: RunRow[], now: Date): StaleJob[] {
  const byJob = new Map<string, number[]>();
  for (const r of runs) {
    const t = new Date(r.started_at).getTime();
    if (Number.isNaN(t)) continue;
    const arr = byJob.get(r.job_name) ?? [];
    arr.push(t);
    byJob.set(r.job_name, arr);
  }

  const stale: StaleJob[] = [];
  for (const [job, times] of byJob) {
    if (times.length < MIN_RUNS_FOR_BASELINE) continue;
    times.sort((a, b) => a - b);

    const gaps: number[] = [];
    for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!);
    gaps.sort((a, b) => a - b);
    // The median ignores the outage itself: one enormous gap cannot drag the
    // baseline up and hide the next outage the way a mean would.
    const medianGapMin = median(gaps) / 60_000;
    if (medianGapMin <= 0) continue;

    const thresholdMin = Math.max(MIN_STALE_MINUTES, medianGapMin * TOLERANCE);
    const lastRun = times[times.length - 1]!;
    const sinceMin = (now.getTime() - lastRun) / 60_000;
    if (sinceMin <= thresholdMin) continue;

    stale.push({
      job_name: job,
      last_run_at: new Date(lastRun).toISOString(),
      minutes_since_last_run: Math.round(sinceMin),
      median_gap_minutes: Number(medianGapMin.toFixed(1)),
      threshold_minutes: Math.round(thresholdMin),
      runs_in_baseline: times.length,
    });
  }

  stale.sort((a, b) => b.minutes_since_last_run - a.minutes_since_last_run);
  return stale;
}

export async function cronStalenessWatchdog(c: Context) {
  const supabase = getSupabase();
  const now = new Date();
  const since = new Date(now.getTime() - BASELINE_DAYS * 86_400_000).toISOString();

  let runs: RunRow[];
  try {
    const paged = await pagedSelect<RunRow>(
      () =>
        supabase
          .from('cron_execution_log')
          .select('job_name, started_at')
          .gte('started_at', since)
          .order('started_at', { ascending: false }),
      200_000,
    );
    runs = paged.rows;
  } catch (err) {
    const m = err instanceof Error ? err.message : 'read failed';
    console.warn('[cron-staleness-watchdog] read error:', m);
    return c.json({ ok: false, error: m }, 500);
  }

  const stale = findStaleJobs(runs, now);

  if (stale.length > 0) {
    const rows = stale.map((s) => ({
      cron_name: s.job_name,
      last_run_at: s.last_run_at,
      last_status: 'stale',
      error_message:
        `no run in ${s.minutes_since_last_run} min; normal cadence is ` +
        `${s.median_gap_minutes} min (threshold ${s.threshold_minutes} min)`,
      metadata: { detector: 'cron_staleness_v1', ...s },
    }));
    const { error: insErr } = await supabase.from('cron_health_log').insert(rows);
    if (insErr) {
      console.warn('[cron-staleness-watchdog] insert error:', insErr.message);
      return c.json({ ok: false, error: insErr.message, stale_jobs: stale }, 500);
    }
    for (const s of stale) {
      console.warn(
        `[cron-staleness-watchdog] STALE ${s.job_name}: ${s.minutes_since_last_run} min ` +
          `since last run, normal cadence ${s.median_gap_minutes} min`,
      );
    }
  }

  return c.json({
    ok: true,
    checked_at: now.toISOString(),
    baseline_days: BASELINE_DAYS,
    jobs_with_baseline: new Set(runs.map((r) => r.job_name)).size,
    stale_count: stale.length,
    stale_jobs: stale,
  });
}
