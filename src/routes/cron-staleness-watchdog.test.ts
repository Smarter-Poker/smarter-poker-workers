import { describe, it, expect } from 'vitest';
import { findStaleJobs } from './cron-staleness-watchdog.js';

/**
 * Cover for the silence that made the 2026-08-31 outage last 25 hours.
 *
 * Four anti-cheat sweeps returned 401 for a full day and nothing anywhere said
 * so. The rules under test are the ones that would have spoken:
 *
 *   1. a job well past its own normal cadence is reported
 *   2. a job running on schedule is not
 *   3. the outage's own enormous gap cannot inflate the baseline and hide the
 *      next one (median, not mean)
 *   4. a job with too little history is left alone rather than guessed at
 */

const T0 = new Date('2026-09-01T18:00:00Z').getTime();
const iso = (msAgo: number) => new Date(T0 - msAgo).toISOString();

/** `count` runs every `everyMin` minutes, the most recent `lastRunMinAgo` ago. */
function runs(job: string, everyMin: number, count: number, lastRunMinAgo = 0) {
  return Array.from({ length: count }, (_, i) => ({
    job_name: job,
    started_at: iso((lastRunMinAgo + i * everyMin) * 60_000),
  }));
}

describe('findStaleJobs', () => {
  const now = new Date(T0);

  it('reports a 30-minute sweep that has not run in a day', () => {
    const stale = findStaleJobs(runs('/cron/collusion-scan', 30, 60, 25 * 60), now);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.job_name).toBe('/cron/collusion-scan');
    expect(stale[0]!.median_gap_minutes).toBe(30);
    expect(stale[0]!.minutes_since_last_run).toBe(1500);
  });

  it('stays quiet for a job running on schedule', () => {
    expect(findStaleJobs(runs('/cron/horses-stories', 15, 200, 3), now)).toHaveLength(0);
  });

  it('does not let a single huge gap inflate the baseline and mask the next outage', () => {
    // 40 runs at 30 min, then one 25-hour hole, then 5 more at 30 min, and now
    // it is late again. A mean gap would be ~60 min and the threshold ~4h,
    // swallowing the second outage. The median stays at 30.
    const recent = runs('/cron/anti-cheat-chip-dump', 30, 5, 8 * 60);
    const older = runs('/cron/anti-cheat-chip-dump', 30, 40, 8 * 60 + 5 * 30 + 25 * 60);
    const stale = findStaleJobs([...recent, ...older], now);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.median_gap_minutes).toBe(30);
    expect(stale[0]!.threshold_minutes).toBe(120);
  });

  it('leaves a job with too little history alone rather than guessing', () => {
    expect(findStaleJobs(runs('/cron/brand-new-job', 30, 3, 25 * 60), now)).toHaveLength(0);
  });

  it('does not alert a fast job merely for being a few minutes late', () => {
    // deploy-error-poll runs every 2 min; 4x that is 8 min, which is noise.
    // The floor holds it to 45 min.
    const stale = findStaleJobs(runs('/cron/deploy-error-poll', 2, 300, 20), now);
    expect(stale).toHaveLength(0);
    expect(findStaleJobs(runs('/cron/deploy-error-poll', 2, 300, 60), now)).toHaveLength(1);
  });

  it('reports the worst offender first', () => {
    const stale = findStaleJobs(
      [
        ...runs('/cron/a', 30, 20, 5 * 60),
        ...runs('/cron/b', 30, 20, 25 * 60),
      ],
      now,
    );
    expect(stale.map((s) => s.job_name)).toEqual(['/cron/b', '/cron/a']);
  });
});
