/**
 * The scan's memory.
 *
 * The window rule is the whole fix: a 30-minute cron over a rolling 24-hour
 * window re-read every hand 48 times, which was survivable at 136,000 hands a
 * day and fatal at 770,000. These cases pin the properties that keep the cost
 * proportional to the platform's RATE, and - just as important - keep it from
 * ever skipping a hand to get there.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  COMMIT_LAG_MS,
  MAX_SPAN_HOURS,
  windowFromState,
  type ScanState,
} from './collusionScanState.js';

const state = (lastWindowEnd: string): ScanState => ({
  lastWindowEnd: new Date(lastWindowEnd),
  lastSuccessAt: null,
  secondsBehind: null,
});

describe('windowFromState', () => {
  it('covers only what has happened since the last run', () => {
    // UPDATED 2026-09-04 with the commit-lag ceiling that replaced the
    // behaviour it used to pin: the end was `now`, and is now `now` minus
    // COMMIT_LAG_MS. See the new case below for why.
    const now = new Date('2026-09-04T12:00:00Z');
    const w = windowFromState(state('2026-09-04T11:30:00Z'), now);
    expect(w.start.toISOString()).toBe('2026-09-04T11:30:00.000Z');
    expect(w.end.toISOString()).toBe('2026-09-04T11:59:00.000Z');
    // Twenty-nine minutes, not twenty-four hours. That ratio IS the fix.
    expect(w.end.getTime() - w.start.getTime()).toBe(30 * 60_000 - COMMIT_LAG_MS);
  });

  it('caps one run so a long outage cannot recreate the unbounded read', () => {
    // A day behind. Without the cap the next run would try to read ~700,000
    // hands in one go, which is precisely what stopped returning.
    const now = new Date('2026-09-04T12:00:00Z');
    const w = windowFromState(state('2026-09-03T12:00:00Z'), now);
    expect(w.end.getTime() - w.start.getTime()).toBe(MAX_SPAN_HOURS * 3600_000);
    expect(w.end.getTime()).toBeLessThan(now.getTime());
  });

  it('catches up over successive runs rather than in one', () => {
    const now = new Date('2026-09-04T12:00:00Z');
    let mark = '2026-09-03T00:00:00Z';
    let runs = 0;
    // Each run advances by at most MAX_SPAN_HOURS, so a 36-hour gap closes in
    // a handful of runs and every one of them stays bounded.
    const ceiling = new Date(now.getTime() - COMMIT_LAG_MS);
    while (new Date(mark).getTime() < ceiling.getTime() && runs < 100) {
      const w = windowFromState(state(mark), now);
      expect(w.end.getTime() - w.start.getTime()).toBeLessThanOrEqual(MAX_SPAN_HOURS * 3600_000);
      mark = w.end.toISOString();
      runs += 1;
    }
    // It converges on the commit-lag ceiling, not on `now`.
    expect(new Date(mark).toISOString()).toBe(ceiling.toISOString());
    expect(runs).toBeGreaterThan(1);
    expect(runs).toBeLessThan(20);
  });

  it('never returns a backwards window when the mark is ahead of now', () => {
    // Clock skew, or somebody hand-editing the row. A backwards window reads
    // as "no rows", which the scan would report as a clean bill of health.
    const now = new Date('2026-09-04T12:00:00Z');
    const w = windowFromState(state('2026-09-04T18:00:00Z'), now);
    expect(w.end.getTime()).toBeGreaterThanOrEqual(w.start.getTime());
  });

  it('produces an empty window when nothing has happened yet', () => {
    const now = new Date('2026-09-04T12:00:00Z');
    const w = windowFromState(state('2026-09-04T12:00:00Z'), now);
    expect(w.end.getTime()).toBe(w.start.getTime());
  });

  it('never reaches past now, so no hand is stepped over', () => {
    const now = new Date('2026-09-04T12:00:00Z');
    for (const mark of [
      '2026-09-04T11:59:59Z',
      '2026-09-04T09:00:00Z',
      '2026-09-01T00:00:00Z',
    ]) {
      const w = windowFromState(state(mark), now);
      expect(w.end.getTime()).toBeLessThanOrEqual(now.getTime());
    }
  });

  it('holds the end back from now, because created_at is transaction start', () => {
    // THE SILENT HOLE THIS CLOSES. `hand_history.created_at` defaults to
    // now(), which in Postgres is the TRANSACTION START time. A hand that
    // starts at 11:59:59.8 and commits at 12:00:00.2 carries a created_at
    // INSIDE a window ending at 12:00:00 and is not visible when that window
    // is read. The mark then moves past it, the next window starts after its
    // timestamp, and that hand is never examined by anything - with both runs
    // reporting a clean completion.
    //
    // Once per run, forever, and invisible: the same shape as the 106,238
    // hands scanWindow.ts exists for.
    const now = new Date('2026-09-04T12:00:00Z');
    const w = windowFromState(state('2026-09-04T11:00:00Z'), now);
    expect(now.getTime() - w.end.getTime()).toBe(COMMIT_LAG_MS);
  });

  it('returns an empty window inside the commit lag rather than a backwards one', () => {
    // A run firing within COMMIT_LAG_MS of the mark has nothing it can safely
    // read. An empty window is the honest answer; a backwards one reads as
    // "no rows", which the scan would report as a clean bill of health.
    const now = new Date('2026-09-04T12:00:00Z');
    const w = windowFromState(state('2026-09-04T11:59:30Z'), now);
    expect(w.end.getTime()).toBe(w.start.getTime());
  });
});

describe('advanceScanState', () => {
  it('is not a fire-and-forget: a refusal from the RPC is a failed run', async () => {
    // The RPC answers {ok:false, reason} when it matched no row. A
    // transport-level success carrying a refusal used to return ok:true, and
    // the route then answered 200 - so the detector would re-read the same
    // window and re-insert the same findings forever, with every row in
    // cron_execution_log saying `success`.
    vi.resetModules();
    vi.doMock('./supabase.js', () => ({
      getSupabase: () => ({
        rpc: () => Promise.resolve({ data: { ok: false, reason: 'no_state_row' }, error: null }),
      }),
    }));
    const { advanceScanState } = await import('./collusionScanState.js');
    const r = await advanceScanState({
      coveredTo: new Date(),
      scannedHands: 1,
      findings: 0,
      durationMs: 1,
      moreToRead: false,
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('no_state_row');
    vi.doUnmock('./supabase.js');
    vi.resetModules();
  });

  it('passes moreToRead through as the flag the console renders as catching_up', async () => {
    vi.resetModules();
    let seen: Record<string, unknown> | null = null;
    vi.doMock('./supabase.js', () => ({
      getSupabase: () => ({
        rpc: (_fn: string, args: Record<string, unknown>) => {
          seen = args;
          return Promise.resolve({ data: { ok: true }, error: null });
        },
      }),
    }));
    const { advanceScanState } = await import('./collusionScanState.js');
    const r = await advanceScanState({
      coveredTo: new Date('2026-09-04T12:00:00Z'),
      scannedHands: 40_000,
      findings: 3,
      durationMs: 7_100,
      moreToRead: true,
    });
    expect(r.ok).toBe(true);
    expect(seen!.p_budget_hit).toBe(true);
    expect(seen!.p_window_end).toBe('2026-09-04T12:00:00.000Z');
    vi.doUnmock('./supabase.js');
    vi.resetModules();
  });
});
