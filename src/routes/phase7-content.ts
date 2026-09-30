/**
 * GET/POST /cron/phase7-content
 *
 * Phase 7 of the Fleet Content Programme: interactive poker content. One
 * fire reveals the puzzles that are due, then publishes new puzzles (nuts,
 * pot odds, what would you do) and story posts (live tournament, throwback
 * hand, human thread, rail a human), each behind its own horse_post_modes
 * row. Every Phase 7 mode ships disabled; `?preview=1` composes samples
 * with zero content writes and is the only path that composes while a mode
 * is off. The reveal step runs whenever the fleet engine is on, because a
 * reveal is owed to the people who already answered.
 *
 * Registered exactly like /cron/phase6-content (src/index.ts): behind the
 * IP allowlist and the cron secret, with the cron middleware writing this
 * request's JSON result to cron_execution_log. The run itself lives in
 * src/lib/content-engine/Phase7Content.ts.
 */
import type { Context } from 'hono';
import { engineEnabled } from '../lib/content-engine/Fleet.js';
import { previewPhase7, runPhase7 } from '../lib/content-engine/Phase7Content.js';

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return String(error);
}

export async function phase7Content(c: Context) {
  const preview = c.req.query('preview') === '1' || c.req.query('dry_run') === '1';
  // `at` steers a preview only. A live run reads the real clock, so a
  // puzzle's "earlier today" is true on the day it is posted.
  const atValue = preview ? c.req.query('at') : undefined;
  const now = atValue ? new Date(atValue) : new Date();
  if (Number.isNaN(now.getTime())) return c.json({ success: false, error: 'invalid_at' }, 400);
  try {
    if (!preview) {
      // The master switch first. A disabled fleet reveals nothing, publishes
      // nothing and reads nothing; the run is logged as a deliberate no-op.
      if (!(await engineEnabled())) {
        return c.json({ success: true, skipped: 'engine_disabled', preview: false, timestamp: now.toISOString() });
      }
      return c.json(await runPhase7({ now }));
    }
    return c.json(await previewPhase7({ now }));
  } catch (error) {
    const text = message(error);
    console.warn('[phase7-content] failed:', text);
    return c.json({ success: false, error: text }, 500);
  }
}
