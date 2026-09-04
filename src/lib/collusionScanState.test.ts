/**
 * The scan's memory.
 *
 * The window rule is the whole fix: a 30-minute cron over a rolling 24-hour
 * window re-read every hand 48 times, which was survivable at 136,000 hands a
 * day and fatal at 770,000. These cases pin the properties that keep the cost
 * proportional to the platform's RATE, and - just as important - keep it from
 * ever skipping a hand to get there.
 */
import { describe, expect, it } from 'vitest';
import { MAX_SPAN_HOURS, windowFromState, type ScanState } from './collusionScanState.js';

const state = (lastWindowEnd: string): ScanState => ({
  lastWindowEnd: new Date(lastWindowEnd),
  lastSuccessAt: null,
  secondsBehind: null,
});

describe('windowFromState', () => {
  it('covers only what has happened since the last run', () => {
    const now = new Date('2026-09-04T12:00:00Z');
    const w = windowFromState(state('2026-09-04T11:30:00Z'), now);
    expect(w.start.toISOString()).toBe('2026-09-04T11:30:00.000Z');
    expect(w.end.toISOString()).toBe('2026-09-04T12:00:00.000Z');
    // Thirty minutes, not twenty-four hours. That ratio IS the fix.
    expect(w.end.getTime() - w.start.getTime()).toBe(30 * 60_000);
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
    while (new Date(mark).getTime() < now.getTime() && runs < 100) {
      const w = windowFromState(state(mark), now);
      expect(w.end.getTime() - w.start.getTime()).toBeLessThanOrEqual(MAX_SPAN_HOURS * 3600_000);
      mark = w.end.toISOString();
      runs += 1;
    }
    expect(new Date(mark).toISOString()).toBe(now.toISOString());
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
});
