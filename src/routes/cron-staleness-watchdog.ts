/**
 * GET/POST /cron/cron-staleness-watchdog
 *
 * PER-JOB silence detector. Raises when a scheduled job has not SUCCEEDED
 * within its own expected interval, whatever the reason.
 *
 * WHY THIS EXISTS
 * On 2026-08-31 the production CRON_SECRET was rotated on Vercel and not on
 * the private workers VM. Every workers-routed Open Claw job returned 401 for
 * 25 hours (08:59:01 UTC to 2026-09-01 17:21:17 UTC). 62 distinct job paths
 * fired into that 401 and did nothing, and nobody noticed until a human went
 * looking.
 *
 * PR #1214 gave the dispatcher a per-hop secret, which fixes that CAUSE. This
 * route covers the CLASS: a job that stops succeeding, for any reason at all.
 *
 * WHY THE EXISTING GUARDS COULD NOT SEE IT
 *   check-cron-liveness.mjs    "ran >= 3 times in 7 days and never succeeded".
 *                              A 401 is rejected by requireCronSecret BEFORE
 *                              the cron_execution_log middleware runs, so
 *                              there is no failed row to count. The log does
 *                              not fill with errors, it STOPS. It also runs on
 *                              pull requests, so an outage between PRs is
 *                              invisible.
 *   check-cron-fleet-alive.mjs "has ANY job succeeded in the last 25 minutes".
 *                              Fleet-wide. It cannot see one job going quiet
 *                              while the other 84 are noisy, which is the far
 *                              more common failure and the one that hides for
 *                              months.
 *   this route                 per job, against that job's OWN cadence.
 *
 * THE BASELINE IS OBSERVED, NOT DECLARED
 * public.v_openclaw_job_staleness derives each job's normal cadence from the
 * p90 gap between its successful runs over 30 days, and flags it stale once
 * silence exceeds twice that, floored at 45 minutes (so one skipped fire of a
 * minutely job is not an alert) and capped at 10 days (so a weekly job that
 * dies is still caught). Explicit schedule retirements are recorded in
 * ca_retired_cron_jobs, which the view excludes. A missing baseline alone is
 * not evidence of recovery: it can mean an active job has been dead for 30 days.
 *
 * KNOWN LIMIT, STATED RATHER THAN HIDDEN
 * A job firing less often than roughly weekly never reaches the view's
 * successes_30d >= 5 minimum and therefore has no baseline. Monthly jobs
 * (vip-diamond-stipend) are NOT covered here; they stay covered by
 * check-cron-liveness.mjs's "fires and never completes" rule. Widening this to
 * monthly cadences needs a declared-schedule source, not a longer lookback.
 *
 * WHY IT IS ALLOWED TO LIVE INSIDE OPEN CLAW
 * A monitor must not share a failure domain with the thing it monitors. The
 * FLEET-DEAD case does share one, and is deliberately left to
 * check-cron-fleet-alive.mjs, which runs GitHub-side. This route only answers
 * the SINGLE-JOB case, and a single job being stale is by definition observed
 * from a fleet that is running. CLAUDE.md 11.3 requires scheduled work to go
 * through Open Claw, and this is scheduled work.
 *
 * OUTPUT
 * One append-only row per state change in public.engine_alerts, matching the
 * shape that table already uses (fingerprint / alertname / status firing or
 * resolved). Deduplicated: a job that is still stale on the next sweep writes
 * nothing, so a long outage is one alert, not one alert every 15 minutes.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const ALERT_NAME = 'OpenClawJobStale';
const COMPONENT = 'openclaw-cron';

/** Severity rises with how far past its own cadence the job has drifted. */
export function severityFor(silentMinutes: number, thresholdMinutes: number): 'warning' | 'critical' {
  if (thresholdMinutes <= 0) return 'warning';
  return silentMinutes >= thresholdMinutes * 3 ? 'critical' : 'warning';
}

export function fingerprintFor(jobName: string): string {
  return ALERT_NAME + ':' + jobName;
}

export interface StalenessRow {
  job_name: string;
  last_success_at: string | null;
  successes_30d: number | string | null;
  silent_minutes: number | string | null;
  p90_gap_minutes: number | string | null;
  threshold_minutes: number | string | null;
  is_stale: boolean | null;
}

export interface RetiredCronJob {
  job_name: string;
  reason: string;
  replaced_by: string | null;
}

export function resolutionFor(fp: string, retiredJobs: Map<string, RetiredCronJob>) {
  const jobName = fp.slice(ALERT_NAME.length + 1);
  const retired = retiredJobs.get(jobName);
  if (retired) {
    return {
      summary: jobName + ' was explicitly retired from the dispatcher',
      description: retired.reason + (retired.replaced_by ? ' Replacement: ' + retired.replaced_by : ''),
      labels: { source: 'cron-staleness-watchdog', job_name: jobName, resolution: 'retired' },
    };
  }
  return {
    summary: jobName + ' is succeeding again',
    description: 'The job has produced a successful run inside its own expected interval.',
    labels: { source: 'cron-staleness-watchdog', job_name: jobName, resolution: 'recovered' },
  };
}

/**
 * Decide what to write, given the view rows and the currently-open alerts.
 * Pure so the decision is testable without a database.
 */
export function planTransitions(
  rows: StalenessRow[],
  firingFingerprints: Set<string>,
  retiredJobNames: Set<string> = new Set(),
): { toFire: StalenessRow[]; toResolve: string[] } {
  const recoveredFps = new Set<string>();
  const toFire: StalenessRow[] = [];

  for (const r of rows) {
    const fp = fingerprintFor(r.job_name);
    if (retiredJobNames.has(r.job_name)) continue;
    if (r.is_stale === false) recoveredFps.add(fp);
    if (r.is_stale !== true) continue;
    if (!firingFingerprints.has(fp)) toFire.push(r);
  }

  const toResolve: string[] = [];
  for (const fp of firingFingerprints) {
    const jobName = fp.slice(ALERT_NAME.length + 1);
    if (retiredJobNames.has(jobName) || recoveredFps.has(fp)) toResolve.push(fp);
  }

  return { toFire, toResolve };
}

export async function cronStalenessWatchdog(c: Context) {
  const supabase = getSupabase();
  const startedAt = new Date().toISOString();
  const errors: string[] = [];

  try {
    // Read explicit retirement authority separately: the view intentionally
    // excludes retired jobs, but absence also happens when a dead active job
    // ages out of its baseline. Only the former is a resolution.
    const { data: retiredData, error: retiredErr } = await supabase
      .from('ca_retired_cron_jobs')
      .select('job_name, reason, replaced_by')
      .limit(1000);
    if (retiredErr || !retiredData || retiredData.length >= 1000) {
      return c.json({ error: retiredErr?.message ?? 'Retired job registry read incomplete' }, 500);
    }
    const retiredJobs = new Map(
      (retiredData as RetiredCronJob[]).map((job) => [job.job_name, job]),
    );

    const { data: viewData, error: viewErr } = await supabase
      .from('v_openclaw_job_staleness')
      .select(
        'job_name, last_success_at, successes_30d, silent_minutes, p90_gap_minutes, threshold_minutes, is_stale',
      );

    if (viewErr) {
      console.warn('[cron-staleness-watchdog] view read failed:', viewErr.message);
      return c.json({ error: viewErr.message }, 500);
    }

    const rows = (viewData ?? []) as StalenessRow[];

    // Current open alerts for this alertname. engine_alerts is append-only, so
    // "open" means the newest row for a fingerprint is status='firing'.
    const { data: alertData, error: alertErr } = await supabase
      .from('engine_alerts')
      .select('fingerprint, status, received_at')
      .eq('alertname', ALERT_NAME)
      .order('received_at', { ascending: false })
      .limit(1000);

    if (alertErr) {
      console.warn('[cron-staleness-watchdog] alert read failed:', alertErr.message);
      return c.json({ error: alertErr.message }, 500);
    }

    const newestByFp = new Map<string, string>();
    for (const a of (alertData ?? []) as Array<{ fingerprint: string; status: string }>) {
      if (!newestByFp.has(a.fingerprint)) newestByFp.set(a.fingerprint, a.status);
    }
    const firing = new Set<string>();
    for (const [fp, status] of newestByFp) {
      if (status === 'firing') firing.add(fp);
    }

    const { toFire, toResolve } = planTransitions(rows, firing, new Set(retiredJobs.keys()));
    const now = new Date().toISOString();

    if (toFire.length > 0) {
      const payload = toFire.map((r) => {
        const silent = Number(r.silent_minutes ?? 0);
        const threshold = Number(r.threshold_minutes ?? 0);
        return {
          fingerprint: fingerprintFor(r.job_name),
          alertname: ALERT_NAME,
          severity: severityFor(silent, threshold),
          component: COMPONENT,
          status: 'firing',
          summary:
            r.job_name +
            ' has not succeeded for ' +
            Math.round(silent) +
            ' min (expected within ' +
            Math.round(threshold) +
            ' min)',
          description:
            'Last success ' +
            (r.last_success_at ?? 'unknown') +
            '. Observed p90 cadence ' +
            Number(r.p90_gap_minutes ?? 0).toFixed(1) +
            ' min over ' +
            Number(r.successes_30d ?? 0) +
            ' successful runs in 30 days. Check recent cron_execution_log errors, ' +
            'the Open Claw dispatcher journal and the workers container for this path. ' +
            'Missing successes can mean failed runs or missing dispatches.',
          labels: {
            job_name: r.job_name,
            silent_minutes: silent,
            threshold_minutes: threshold,
            p90_gap_minutes: Number(r.p90_gap_minutes ?? 0),
            successes_30d: Number(r.successes_30d ?? 0),
            source: 'cron-staleness-watchdog',
          },
          starts_at: r.last_success_at ?? now,
          received_at: now,
          notified_via: [],
        };
      });

      const { error: insErr } = await supabase.from('engine_alerts').insert(payload);
      if (insErr) errors.push('fire insert: ' + insErr.message);
    }

    if (toResolve.length > 0) {
      const payload = toResolve.map((fp) => ({
        fingerprint: fp,
        alertname: ALERT_NAME,
        severity: 'info',
        component: COMPONENT,
        status: 'resolved',
        ...resolutionFor(fp, retiredJobs),
        ends_at: now,
        received_at: now,
        notified_via: [],
      }));

      const { error: resErr } = await supabase.from('engine_alerts').insert(payload);
      if (resErr) errors.push('resolve insert: ' + resErr.message);
    }

    const staleNow = rows.filter((r) => r.is_stale).map((r) => r.job_name);
    if (staleNow.length > 0) {
      console.warn('[cron-staleness-watchdog] stale: ' + staleNow.join(', '));
    }

    return c.json({
      ok: errors.length === 0,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      jobs_with_baseline: rows.length,
      stale_now: staleNow.length,
      stale_jobs: staleNow,
      alerts_fired: toFire.length,
      alerts_resolved: toResolve.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[cron-staleness-watchdog] unhandled:', msg);
    return c.json({ error: msg }, 500);
  }
}
