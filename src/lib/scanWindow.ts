/**
 * Shared scan-window resolution for the anti-cheat / integrity sweeps.
 *
 * WHY THIS EXISTS (2026-09-01)
 * ----------------------------
 * Open Claw shipped one bearer CRON_SECRET to two hosts that validate it
 * independently. Vercel's copy was rotated, the private workers VM's was not,
 * so every workers-routed cron 401'd from 2026-08-31 08:59:01 UTC until the
 * dispatcher redeployed at 2026-09-01 17:21:17 UTC.
 *
 * Four detection sweeps went dark for that whole period. Three of them
 * (collusion-scan, anti-cheat-chip-dump, anti-cheat-multi-account) look at a
 * rolling "last N hours ending NOW" window, so the moment they came back they
 * could only see the most recent 24 hours. The hours between the last good run
 * and 24h-before-the-first-recovered-run were never examined by anything and
 * never would be: 2026-08-31 08:30 -> 17:30 UTC, 106,238 hands of real play.
 *
 * The window was a hardcoded `Date.now()`. There was no way to ask a sweep to
 * look at a period that had already passed, so a missed sweep was permanently
 * missed. That is the defect this module closes.
 *
 * USAGE
 * -----
 *   GET /cron/collusion-scan
 *     -> unchanged: window is [now - defaultHours, now]
 *
 *   GET /cron/collusion-scan?since=2026-08-31T08:30:00Z&until=2026-08-31T17:30:00Z
 *     -> rescans exactly that historical window
 *
 *   ...&dry_run=1
 *     -> computes findings and reports them WITHOUT writing any flag rows.
 *        Use this first when rescanning a gap, so a human can see the shape of
 *        the result before a day of findings lands in the review queue.
 *
 * Params are also accepted from a JSON POST body, because Open Claw fires some
 * jobs as POST.
 */
import type { Context } from 'hono';

export interface ScanWindow {
  /** Inclusive lower bound. */
  start: Date;
  /** Exclusive upper bound. */
  end: Date;
  /** True when the caller supplied since/until rather than taking the default. */
  overridden: boolean;
  /** True when the caller asked for findings without writes. */
  dryRun: boolean;
}

export class ScanWindowError extends Error {}

/** Hard ceiling on an explicit window. A wider one would read the whole table. */
export const MAX_WINDOW_HOURS = 24 * 14;

function parseInstant(raw: string, label: string): Date {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new ScanWindowError(`${label} is not a valid ISO-8601 instant: ${raw}`);
  }
  return d;
}

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

/**
 * Resolve the window for a sweep from query params or JSON body, falling back
 * to the sweep's own rolling default when nothing is supplied.
 *
 * `defaultHours` reproduces the previous hardcoded behaviour exactly, so a
 * call with no params is byte-for-byte the old code path.
 */
export async function resolveScanWindow(
  c: Context,
  defaultHours: number,
  now: Date = new Date(),
): Promise<ScanWindow> {
  const q = c.req.query();
  let body: Record<string, unknown> = {};
  if (c.req.method === 'POST') {
    try {
      const parsed: unknown = await c.req.json();
      if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
    } catch {
      // No body, or not JSON. Query params still apply.
    }
  }

  const pick = (key: string): string | undefined => {
    const fromQuery = q[key];
    if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;
    const fromBody = body[key];
    if (typeof fromBody === 'string' && fromBody.length > 0) return fromBody;
    return undefined;
  };

  const dryRun = truthy(pick('dry_run')) || truthy(pick('dryRun'));
  const sinceRaw = pick('since');
  const untilRaw = pick('until');

  if (!sinceRaw && !untilRaw) {
    return {
      start: new Date(now.getTime() - defaultHours * 3600_000),
      end: now,
      overridden: false,
      dryRun,
    };
  }

  if (!sinceRaw) {
    throw new ScanWindowError('until was supplied without since');
  }

  const start = parseInstant(sinceRaw, 'since');
  const end = untilRaw ? parseInstant(untilRaw, 'until') : now;

  if (end.getTime() <= start.getTime()) {
    throw new ScanWindowError('until must be strictly after since');
  }
  const spanHours = (end.getTime() - start.getTime()) / 3600_000;
  if (spanHours > MAX_WINDOW_HOURS) {
    throw new ScanWindowError(
      `window of ${spanHours.toFixed(1)}h exceeds the ${MAX_WINDOW_HOURS}h ceiling`,
    );
  }

  return { start, end, overridden: true, dryRun };
}

/**
 * Flag dedupe cutoff, anchored to the END of the scanned window rather than to
 * wall-clock now. Rescanning a historical window must compare against the flags
 * that existed around that window, not against today's.
 */
export function dedupeSinceFor(window: ScanWindow, dedupeHours: number): Date {
  return new Date(window.end.getTime() - dedupeHours * 3600_000);
}
