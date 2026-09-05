/**
 * FleetScheduler: who is due to post, and who is online, across the WHOLE
 * fleet.
 *
 * WHY THIS EXISTS (2026-09-05, measured before it was written).
 *
 * The fleet is 1,000 horses. 640 had never posted, commented, liked or
 * reeled. Exactly 100 posted per day, and they were the 100 content_authors
 * rows with the lowest profile_id sorted as text - horse-by-index.ts did
 * `.order('profile_id').limit(100)` and batch N took rows 10N..10N+9. Nobody
 * chose those hundred; a UUID did.
 *
 * Engagement was worse. HorseScheduler.shouldHorseBeActive(id, minute, 2)
 * was written for four cron fires an hour (CRON_TRIGGERS = [8,23,38,53],
 * declared there and referenced nowhere). horses-social-all fires at :00
 * every two hours, so only horses whose hash slot is 58..2 ever pass the
 * gate: 58 of the 66 horses that commented in fourteen days sat in those five
 * slots. The other ~930 were locked out by arithmetic.
 *
 * THE MODEL.
 *
 * A horse is due to post at a time that is a pure function of its id and the
 * clock, in ITS OWN timezone, inside the awake window HorseScheduler already
 * gives it. The hourly cron does not pick horses; it asks "who is due now?"
 * across every active row. There is no batch, no cap on eligibility, and no
 * ordering by id.
 *
 *   - cadence: posts per week, weekly is the FLOOR (Dan: "weekly not daily").
 *     Most horses post once a week, some twice or three times, a few most
 *     days. A fleet that all posts exactly once on a fixed weekday is as
 *     detectable as one that never posts.
 *   - days: k distinct local weekdays, deterministic per horse.
 *   - hour: inside the awake window, deterministic per (horse, weekday), and
 *     nudged by an hour either way per ISO week so the same Tuesday is not
 *     the same Tuesday at the same hour every week.
 *   - due window: three hours from the due hour. A worker that was down for
 *     the due hour still catches the horse on the next fire. The caller's
 *     "already posted in the last 20h" guard is what makes the window safe
 *     to widen; see horse-posts.ts.
 *
 * "Online" (for likes, comments, replies, reactions) is hour-granular: inside
 * the awake window, on a day the horse is "on" at all. No minute slots.
 *
 * Every function here is pure and cheap; all 1,000 horses are evaluated on
 * every fire in well under a millisecond.
 */
import { getHorseActiveHours } from './HorseScheduler.js';

/** FNV-1a, 32-bit, salted. Different salts give independent decisions. */
export function fleetHash(profileId: string, salt: string): number {
  let h = 0x811c9dc5;
  const s = `${salt}:${profileId}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export type Cadence = 1 | 2 | 3 | 5;

/**
 * Posts per week. Weekly is the floor.
 *   60%  1 / week
 *   25%  2 / week
 *   10%  3 / week
 *    5%  5 / week
 * Fleet of 1,000 lands at roughly 1,000*(0.6+0.5+0.3+0.25) = 1,650 / week,
 * about 235 a day. Today the engine does 100.
 */
export function postingCadence(profileId: string): Cadence {
  const r = fleetHash(profileId, 'cadence') % 100;
  if (r < 60) return 1;
  if (r < 85) return 2;
  if (r < 95) return 3;
  return 5;
}

/** Local weekdays (0 = Sunday .. 6 = Saturday) on which this horse posts. */
export function postingDays(profileId: string): number[] {
  const k = postingCadence(profileId);
  const days: number[] = [];
  // Walk the week from a hashed start with a hashed stride so the k days are
  // spread rather than clustered (stride 3 for k=2 gives Mon/Thu, Tue/Fri...).
  const start = fleetHash(profileId, 'day-start') % 7;
  const stride = k === 1 ? 0 : k === 2 ? 3 : k === 3 ? 2 : 1;
  for (let i = 0; i < k; i++) days.push((start + i * stride) % 7);
  return [...new Set(days)].sort((a, b) => a - b);
}

/** The awake window as a list of local hours. */
function awakeHours(profileId: string): number[] {
  const { start, end } = getHorseActiveHours(profileId);
  const hours: number[] = [];
  if (start <= end) {
    for (let h = start; h <= end; h++) hours.push(h);
  } else {
    for (let h = start; h < 24; h++) hours.push(h);
    for (let h = 0; h <= end; h++) hours.push(h);
  }
  return hours;
}

/**
 * The local hour this horse posts on a given local weekday of a given ISO
 * week. Deterministic; the week nudges it by -1..+1 so it drifts.
 */
export function postingHour(profileId: string, weekday: number, isoWeekKey: string): number {
  const hours = awakeHours(profileId);
  // Skip the first and last hour of the window when it can spare them: the
  // "just woke up" hour posts too uniformly across the fleet.
  const usable = hours.length > 4 ? hours.slice(1, -1) : hours;
  const base = fleetHash(profileId, `hour:${weekday}`) % usable.length;
  const nudge = (fleetHash(profileId, `nudge:${isoWeekKey}`) % 3) - 1;
  const idx = Math.min(usable.length - 1, Math.max(0, base + nudge));
  return usable[idx]!;
}

/** Hours after the due hour during which the horse still counts as due. */
export const DUE_WINDOW_HOURS = 3;

export interface LocalClock {
  weekday: number; // 0..6, local
  hour: number; // 0..23, local
  dayKey: string; // YYYY-MM-DD local
  isoWeekKey: string; // YYYY-Www local
}

function formatParts(now: Date, tz: string): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    weekday: 'short',
  }).formatToParts(now);
}

/** Resolve the wall clock in the horse's timezone. Falls back to UTC. */
export function localClock(now: Date, timezone: string | null | undefined): LocalClock {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = formatParts(now, timezone && timezone.length > 0 ? timezone : 'UTC');
  } catch {
    parts = formatParts(now, 'UTC');
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  // Some engines print midnight as "24" under hour12:false.
  const hour = Number(get('hour')) % 24;
  const y = Number(get('year'));
  const m = Number(get('month'));
  const d = Number(get('day'));
  const dayKey = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { weekday: weekday < 0 ? 0 : weekday, hour, dayKey, isoWeekKey: isoWeek(y, m, d) };
}

/** ISO-8601 week key for a civil date. */
export function isoWeek(y: number, m: number, d: number): string {
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export interface DueResult {
  due: boolean;
  /** Local hour the slot opened, when due. */
  dueHour?: number;
  /** Hours since the slot opened, 0..DUE_WINDOW_HOURS-1. Higher = waited longer. */
  age?: number;
}

/**
 * Is this horse inside one of its posting windows right now?
 *
 * A window is [dueHour, dueHour + DUE_WINDOW_HOURS) on one of the horse's
 * posting weekdays, in local time. Windows can straddle midnight; a window
 * that opened at 23:00 on a posting day is still open at 01:00 the next day.
 */
export function isDueForPost(
  profileId: string,
  timezone: string | null | undefined,
  now: Date,
): DueResult {
  const clock = localClock(now, timezone);
  const days = postingDays(profileId);
  if (days.includes(clock.weekday)) {
    const h = postingHour(profileId, clock.weekday, clock.isoWeekKey);
    const age = clock.hour - h;
    if (age >= 0 && age < DUE_WINDOW_HOURS) return { due: true, dueHour: h, age };
  }
  const yesterday = (clock.weekday + 6) % 7;
  if (days.includes(yesterday)) {
    const prevClock = localClock(new Date(now.getTime() - 86_400_000), timezone);
    const h = postingHour(profileId, yesterday, prevClock.isoWeekKey);
    const age = clock.hour + 24 - h;
    if (age >= 0 && age < DUE_WINDOW_HOURS) return { due: true, dueHour: h, age };
  }
  return { due: false };
}

/** Share of days a horse is on the platform at all (likes, comments...). */
export function onlineDayRate(profileId: string): number {
  // 55% .. 95% of days, deterministic per horse.
  return 0.55 + (fleetHash(profileId, 'online-rate') % 41) / 100;
}

/**
 * Hour-granular engagement gate. True when the horse is inside its awake
 * window in its own timezone AND today is one of its online days. Replaces
 * the minute-slot gate that only ever admitted ~8% of the fleet.
 */
export function isOnlineNow(
  profileId: string,
  timezone: string | null | undefined,
  now: Date,
): boolean {
  const clock = localClock(now, timezone);
  const { start, end } = getHorseActiveHours(profileId);
  const awake =
    start <= end ? clock.hour >= start && clock.hour <= end : clock.hour >= start || clock.hour <= end;
  if (!awake) return false;
  const roll = fleetHash(profileId, `online:${clock.dayKey}`) % 100;
  return roll < onlineDayRate(profileId) * 100;
}

/** A compact, loggable description of one horse's plan. */
export function describePlan(profileId: string, timezone: string | null | undefined, now: Date) {
  const clock = localClock(now, timezone);
  const days = postingDays(profileId);
  return {
    cadence: postingCadence(profileId),
    days,
    hours: days.map((d) => postingHour(profileId, d, clock.isoWeekKey)),
    awake: getHorseActiveHours(profileId),
    onlineDayRate: onlineDayRate(profileId),
    timezone: timezone ?? 'UTC',
  };
}
