import { describe, it, expect } from 'vitest';
import {
  planTransitions,
  severityFor,
  fingerprintFor,
  type StalenessRow,
} from './cron-staleness-watchdog.js';

/**
 * The scenario these rules exist for is the real one: the 2026-08-31 ->
 * 2026-09-01 CRON_SECRET skew, where 62 workers-routed jobs 401'd for 25 hours
 * and no guard could see it, because a 401 never reaches the logging layer and
 * the log therefore goes SILENT rather than red.
 *
 * Numbers below are the ones actually read out of
 * public.v_openclaw_job_staleness at 2026-09-01 17:50 UTC.
 */
const row = (o: Partial<StalenessRow> & { job_name: string }): StalenessRow => ({
  last_success_at: '2026-08-31T08:00:00Z',
  successes_30d: 100,
  silent_minutes: 2038,
  p90_gap_minutes: 60,
  threshold_minutes: 120,
  is_stale: true,
  ...o,
});

describe('cron staleness watchdog', () => {
  it('fires for a job silent past its own cadence (the real outage)', () => {
    // /cron/chip-supply-snapshot: hourly, last success 2026-08-31 07:00,
    // silent 2098 min against a 180 min threshold.
    const rows = [row({ job_name: '/cron/chip-supply-snapshot', silent_minutes: 2098, threshold_minutes: 360 })];
    const { toFire, toResolve } = planTransitions(rows, new Set());
    expect(toFire.map((r) => r.job_name)).toEqual(['/cron/chip-supply-snapshot']);
    expect(toResolve).toEqual([]);
  });

  it('does not re-fire a job that is already alerting', () => {
    const rows = [row({ job_name: '/cron/hard-stop' })];
    const already = new Set([fingerprintFor('/cron/hard-stop')]);
    const { toFire, toResolve } = planTransitions(rows, already);
    expect(toFire).toEqual([]);
    expect(toResolve).toEqual([]);
  });

  it('resolves a job that has started succeeding again', () => {
    const rows = [row({ job_name: '/cron/bbj-detect', is_stale: false })];
    const already = new Set([fingerprintFor('/cron/bbj-detect')]);
    const { toFire, toResolve } = planTransitions(rows, already);
    expect(toFire).toEqual([]);
    expect(toResolve).toEqual([fingerprintFor('/cron/bbj-detect')]);
  });

  it('resolves an alert whose job no longer appears in the view at all', () => {
    // A retired job drops out of the 30-day window. Leaving its alert open
    // forever is how an alert list becomes noise nobody reads.
    const already = new Set([fingerprintFor('/cron/retired-job')]);
    const { toFire, toResolve } = planTransitions([], already);
    expect(toFire).toEqual([]);
    expect(toResolve).toEqual([fingerprintFor('/cron/retired-job')]);
  });

  it('says nothing about a healthy fleet', () => {
    const rows = [
      row({ job_name: '/cron/player-stats-refresh', silent_minutes: 12, is_stale: false }),
      row({ job_name: '/cron/bbj-detect', silent_minutes: 3, is_stale: false }),
    ];
    const { toFire, toResolve } = planTransitions(rows, new Set());
    expect(toFire).toEqual([]);
    expect(toResolve).toEqual([]);
  });

  it('escalates to critical only well past the threshold', () => {
    expect(severityFor(130, 120)).toBe('warning');
    expect(severityFor(359, 120)).toBe('warning');
    expect(severityFor(360, 120)).toBe('critical');
    // 25-hour outage of an hourly job is unambiguously critical.
    expect(severityFor(1500, 120)).toBe('critical');
  });

  it('never divides by a zero threshold', () => {
    expect(severityFor(1000, 0)).toBe('warning');
  });
});
