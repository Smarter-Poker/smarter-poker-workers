/**
 * FleetScheduler: the whole fleet is eligible, weekly is the floor, and the
 * gate no longer depends on the minute the cron happens to fire.
 *
 * Every pin here is a defect that shipped (see the file header):
 *   - 100 horses posting, 900 structurally unable (order+limit)
 *   - ~8% of the fleet able to engage (minute-slot gate vs :00 cron)
 */
import { describe, it, expect } from 'vitest';
import {
  fleetHash,
  postingCadence,
  postingDays,
  postingHour,
  isDueForPost,
  isOnlineNow,
  localClock,
  isoWeek,
  onlineDayRate,
  DUE_WINDOW_HOURS,
} from './FleetScheduler.js';
import { getHorseActiveHours } from './HorseScheduler.js';

// A synthetic fleet of 1,000 UUID-shaped ids, deterministic.
function syntheticFleet(n = 1000): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const h = fleetHash(String(i), 'fixture').toString(16).padStart(8, '0');
    const g = fleetHash(String(i), 'fixture-2').toString(16).padStart(8, '0');
    ids.push(`${h}-${g.slice(0, 4)}-4${g.slice(4, 7)}-8${h.slice(1, 4)}-${g}${h.slice(0, 4)}`);
  }
  return ids;
}

const TZS = ['America/New_York', 'America/Chicago', 'Europe/London', 'Asia/Manila', 'Australia/Melbourne', null];

describe('fleetHash', () => {
  it('is deterministic and salt-sensitive', () => {
    expect(fleetHash('abc', 'x')).toBe(fleetHash('abc', 'x'));
    expect(fleetHash('abc', 'x')).not.toBe(fleetHash('abc', 'y'));
    expect(fleetHash('abc', 'x')).not.toBe(fleetHash('abd', 'x'));
  });
});

describe('cadence and days: weekly is the floor', () => {
  const fleet = syntheticFleet();

  it('every horse posts at least once a week', () => {
    for (const id of fleet) {
      expect(postingCadence(id)).toBeGreaterThanOrEqual(1);
      expect(postingDays(id).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('cadence buckets land near 60/25/10/5 and days are distinct weekdays', () => {
    const counts: Record<number, number> = {};
    for (const id of fleet) {
      const c = postingCadence(id);
      counts[c] = (counts[c] ?? 0) + 1;
      const days = postingDays(id);
      expect(days.length).toBe(c);
      expect(new Set(days).size).toBe(c);
      for (const d of days) expect(d).toBeGreaterThanOrEqual(0), expect(d).toBeLessThanOrEqual(6);
    }
    expect(counts[1]).toBeGreaterThan(520);
    expect(counts[1]).toBeLessThan(680);
    expect(counts[5]).toBeGreaterThan(20);
    expect(counts[5]).toBeLessThan(90);
  });

  it('the fleet spreads across all seven weekdays, no weekday is dead', () => {
    const perDay = new Array(7).fill(0);
    for (const id of fleet) for (const d of postingDays(id)) perDay[d]++;
    for (const n of perDay) expect(n).toBeGreaterThan(120);
  });
});

describe('posting hour', () => {
  const fleet = syntheticFleet(300);

  it('always falls inside the awake window', () => {
    for (const id of fleet) {
      const { start, end } = getHorseActiveHours(id);
      for (let wd = 0; wd < 7; wd++) {
        const h = postingHour(id, wd, '2026-W36');
        const inside = start <= end ? h >= start && h <= end : h >= start || h <= end;
        expect(inside).toBe(true);
      }
    }
  });

  it('drifts between weeks for at least some horses, never by more than two hours', () => {
    let drifted = 0;
    for (const id of fleet) {
      const a = postingHour(id, 2, '2026-W36');
      const b = postingHour(id, 2, '2026-W37');
      if (a !== b) drifted++;
      // Base hour -1..+1 per week, so two weeks differ by at most 2; circular
      // because a window that wraps midnight steps 23 -> 0.
      const d = Math.abs(a - b);
      expect(Math.min(d, 24 - d)).toBeLessThanOrEqual(2);
    }
    expect(drifted).toBeGreaterThan(50);
  });
});

describe('isDueForPost: over a week, every horse is due exactly cadence times (by slot)', () => {
  const fleet = syntheticFleet(200);

  it('walking four weeks, each horse opens 4 x cadence windows, give or take the drift', () => {
    // Each local weekday appears exactly four times in a 28-day span. The
    // weekly hour nudge (-1..+1) can push one opening across either edge of
    // the span, so the count is 4*cadence within one either way.
    const start = Date.UTC(2026, 8, 7, 0, 0, 0); // 2026-09-07, a Monday
    for (const id of fleet) {
      const tz = TZS[fleetHash(id, 'tz') % TZS.length];
      let openings = 0;
      let dueHours = 0;
      for (let h = 0; h < 28 * 24; h++) {
        const r = isDueForPost(id, tz, new Date(start + h * 3_600_000));
        if (r.due) dueHours++;
        if (r.due && r.age === 0) openings++;
      }
      const expected = 4 * postingCadence(id);
      expect(openings).toBeGreaterThanOrEqual(expected - 1);
      expect(openings).toBeLessThanOrEqual(expected + 1);
      // Every opening carries DUE_WINDOW_HOURS due-hours, give or take the
      // windows cut by the span's edges.
      expect(dueHours).toBeGreaterThanOrEqual(openings * DUE_WINDOW_HOURS - (DUE_WINDOW_HOURS - 1));
      expect(dueHours).toBeLessThanOrEqual(openings * DUE_WINDOW_HOURS + (DUE_WINDOW_HOURS - 1));
    }
  });

  it('reports age so the caller can serve the oldest slot first', () => {
    const id = fleet[0]!;
    const tz = 'UTC';
    const start = Date.UTC(2026, 8, 7, 0, 0, 0);
    const ages: number[] = [];
    for (let h = 0; h < 7 * 24; h++) {
      const r = isDueForPost(id, tz, new Date(start + h * 3_600_000));
      if (r.due) ages.push(r.age!);
    }
    expect(ages.length).toBeGreaterThan(0);
    // Each window runs 0,1,2.
    for (let i = 0; i + 2 < ages.length; i += DUE_WINDOW_HOURS) {
      expect(ages.slice(i, i + 3)).toEqual([0, 1, 2]);
    }
  });

  it('does not depend on the minute the cron fires', () => {
    const id = fleet[1]!;
    const base = Date.UTC(2026, 8, 9, 14, 0, 0);
    const at0 = isDueForPost(id, 'America/Chicago', new Date(base)).due;
    const at37 = isDueForPost(id, 'America/Chicago', new Date(base + 37 * 60_000)).due;
    const at59 = isDueForPost(id, 'America/Chicago', new Date(base + 59 * 60_000)).due;
    expect(at37).toBe(at0);
    expect(at59).toBe(at0);
  });
});

describe('the fleet as a whole, one day', () => {
  it('a hundred-plus horses are due across a Tuesday, not the same hundred by id', () => {
    const fleet = syntheticFleet();
    const start = Date.UTC(2026, 8, 8, 0, 0, 0); // Tuesday
    const due = new Set<string>();
    for (let h = 0; h < 24; h++) {
      const now = new Date(start + h * 3_600_000);
      for (const id of fleet) {
        const tz = TZS[fleetHash(id, 'tz') % TZS.length];
        const r = isDueForPost(id, tz, now);
        if (r.due && r.age === 0) due.add(id);
      }
    }
    // ~1,650 slots a week / 7 = ~235 openings a day.
    expect(due.size).toBeGreaterThan(150);
    expect(due.size).toBeLessThan(350);
    // Not the lowest ids: the old engine's hundred were the 100 smallest.
    const sorted = [...fleet].sort();
    const lowest100 = new Set(sorted.slice(0, 100));
    let overlap = 0;
    for (const id of due) if (lowest100.has(id)) overlap++;
    expect(overlap).toBeLessThan(40);
  });
});

describe('isOnlineNow: hour-granular, whole fleet', () => {
  const fleet = syntheticFleet();

  it('admits far more than 8% of the fleet at a typical hour', () => {
    const now = new Date(Date.UTC(2026, 8, 8, 20, 0, 0));
    let online = 0;
    for (const id of fleet) {
      const tz = TZS[fleetHash(id, 'tz') % TZS.length];
      if (isOnlineNow(id, tz, now)) online++;
    }
    expect(online).toBeGreaterThan(250);
  });

  it('is identical at :00 and :43 of the same hour', () => {
    const base = Date.UTC(2026, 8, 8, 20, 0, 0);
    for (const id of fleet.slice(0, 200)) {
      const tz = TZS[fleetHash(id, 'tz') % TZS.length];
      expect(isOnlineNow(id, tz, new Date(base + 43 * 60_000))).toBe(isOnlineNow(id, tz, new Date(base)));
    }
  });

  it('never admits a horse outside its awake window', () => {
    for (const id of fleet.slice(0, 300)) {
      const { start, end } = getHorseActiveHours(id);
      for (let h = 0; h < 24; h++) {
        const now = new Date(Date.UTC(2026, 8, 8, h, 0, 0));
        const on = isOnlineNow(id, 'UTC', now);
        const awake = start <= end ? h >= start && h <= end : h >= start || h <= end;
        if (!awake) expect(on).toBe(false);
      }
    }
  });

  it('online day rate sits between 55% and 95%', () => {
    for (const id of fleet.slice(0, 200)) {
      const r = onlineDayRate(id);
      expect(r).toBeGreaterThanOrEqual(0.55);
      expect(r).toBeLessThanOrEqual(0.9501);
    }
  });
});

describe('clock helpers', () => {
  it('localClock converts to the horse timezone', () => {
    const now = new Date(Date.UTC(2026, 8, 8, 3, 30, 0)); // 03:30 UTC Tuesday
    const chicago = localClock(now, 'America/Chicago'); // 22:30 Monday CDT
    expect(chicago.hour).toBe(22);
    expect(chicago.weekday).toBe(1);
    expect(chicago.dayKey).toBe('2026-09-07');
    const manila = localClock(now, 'Asia/Manila'); // 11:30 Tuesday
    expect(manila.hour).toBe(11);
    expect(manila.weekday).toBe(2);
  });

  it('localClock falls back to UTC on a bad timezone', () => {
    const now = new Date(Date.UTC(2026, 8, 8, 3, 30, 0));
    expect(localClock(now, 'Not/AZone').hour).toBe(3);
    expect(localClock(now, null).hour).toBe(3);
  });

  it('isoWeek', () => {
    expect(isoWeek(2026, 9, 7)).toBe('2026-W37');
    expect(isoWeek(2026, 1, 1)).toBe('2026-W01');
    expect(isoWeek(2027, 1, 1)).toBe('2026-W53');
  });
});
