import { describe, it, expect } from 'vitest';
import type { Context } from 'hono';
import {
  resolveScanWindow,
  dedupeSinceFor,
  ScanWindowError,
  MAX_WINDOW_HOURS,
} from './scanWindow.js';

/**
 * Cover for the gap-rescan window.
 *
 * The bug this closes: from 2026-08-31 08:59 to 2026-09-01 17:21 UTC every
 * workers-routed cron 401'd on a stale CRON_SECRET. collusion-scan,
 * anti-cheat-chip-dump and anti-cheat-multi-account all scanned a rolling
 * "last 24h ending NOW", so when they recovered they could only see the most
 * recent 24 hours and the head of the outage - 2026-08-31 08:30 to 17:30,
 * 106,238 hands - was permanently unexamined by anything.
 *
 * The rules under test:
 *   1. no params  -> byte-identical to the old rolling behaviour
 *   2. since/until -> exactly that historical window, so a gap is rescannable
 *   3. a nonsense window is REFUSED rather than silently coerced
 *   4. dedupe is anchored to the window's end, not to wall-clock now
 */

const NOW = new Date('2026-09-01T20:00:00.000Z');

function ctx(
  query: Record<string, string> = {},
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): Context {
  return {
    req: {
      method,
      query: () => query,
      json: async () => {
        if (body === undefined) throw new Error('no body');
        return body;
      },
    },
  } as unknown as Context;
}

describe('resolveScanWindow', () => {
  it('defaults to the rolling last N hours ending now, exactly as before', async () => {
    const w = await resolveScanWindow(ctx(), 24, NOW);
    expect(w.end.toISOString()).toBe(NOW.toISOString());
    expect(w.start.toISOString()).toBe('2026-08-31T20:00:00.000Z');
    expect(w.overridden).toBe(false);
    expect(w.dryRun).toBe(false);
  });

  it('rescans the exact outage window when since and until are supplied', async () => {
    const w = await resolveScanWindow(
      ctx({ since: '2026-08-31T08:30:00Z', until: '2026-08-31T17:30:00Z' }),
      24,
      NOW,
    );
    expect(w.start.toISOString()).toBe('2026-08-31T08:30:00.000Z');
    expect(w.end.toISOString()).toBe('2026-08-31T17:30:00.000Z');
    expect(w.overridden).toBe(true);
  });

  it('accepts the window from a JSON POST body, because Open Claw posts', async () => {
    const w = await resolveScanWindow(
      ctx({}, 'POST', { since: '2026-08-31T08:30:00Z', dry_run: '1' }),
      24,
      NOW,
    );
    expect(w.start.toISOString()).toBe('2026-08-31T08:30:00.000Z');
    expect(w.end.toISOString()).toBe(NOW.toISOString());
    expect(w.dryRun).toBe(true);
  });

  it('treats dry_run as opt-in and off by default', async () => {
    expect((await resolveScanWindow(ctx(), 24, NOW)).dryRun).toBe(false);
    expect((await resolveScanWindow(ctx({ dry_run: 'true' }), 24, NOW)).dryRun).toBe(true);
    expect((await resolveScanWindow(ctx({ dry_run: '0' }), 24, NOW)).dryRun).toBe(false);
  });

  it('refuses an unparseable instant rather than scanning Invalid Date', async () => {
    await expect(resolveScanWindow(ctx({ since: 'yesterday' }), 24, NOW)).rejects.toBeInstanceOf(
      ScanWindowError,
    );
  });

  it('refuses until without since', async () => {
    await expect(
      resolveScanWindow(ctx({ until: '2026-08-31T17:30:00Z' }), 24, NOW),
    ).rejects.toBeInstanceOf(ScanWindowError);
  });

  it('refuses a backwards window', async () => {
    await expect(
      resolveScanWindow(
        ctx({ since: '2026-08-31T17:30:00Z', until: '2026-08-31T08:30:00Z' }),
        24,
        NOW,
      ),
    ).rejects.toBeInstanceOf(ScanWindowError);
  });

  it('refuses a window wider than the ceiling, which would read the whole table', async () => {
    const since = new Date(NOW.getTime() - (MAX_WINDOW_HOURS + 1) * 3600_000).toISOString();
    await expect(
      resolveScanWindow(ctx({ since, until: NOW.toISOString() }), 24, NOW),
    ).rejects.toBeInstanceOf(ScanWindowError);
  });
});

describe('dedupeSinceFor', () => {
  it('anchors dedupe to the end of the scanned window, not to wall-clock now', async () => {
    const w = await resolveScanWindow(
      ctx({ since: '2026-08-31T08:30:00Z', until: '2026-08-31T17:30:00Z' }),
      24,
      NOW,
    );
    expect(dedupeSinceFor(w, 24).toISOString()).toBe('2026-08-30T17:30:00.000Z');
  });
});
