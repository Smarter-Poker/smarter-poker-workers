/**
 * GET/POST /cron/horse/:horseIndex and /cron/horse-batch/:horseIndex
 *
 * LEGACY, kept only for the hand-over window (2026-09-05). These routes
 * were the whole posting engine: ten batches a day over the 100 lowest-UUID
 * content_authors rows, one post each, 100 posts a day from the same 100
 * horses while 900 never spoke. That selection is gone. The hourly
 * /cron/horse-posts route (routes/horse-posts.ts) now decides who is due
 * across the whole fleet.
 *
 * Until the Hetzner dispatcher is redeployed without the batch schedule,
 * these routes still fire. They now publish through the SAME HorsePublisher
 * as the fleet route, which carries a 20-hour recent-post guard, so a horse
 * reached by both in one day posts once. When the dispatcher no longer
 * references horse-batch/*, delete this file and its two registrations in
 * src/index.ts.
 *
 * The horse for index N is still the Nth row of the old ordering so the
 * hand-over changes nothing for the horses that were already posting; it
 * only stops them double-posting.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { engineEnabled } from '../lib/content-engine/Fleet.js';
import { publishForHorse, type FleetHorse } from '../lib/content-engine/HorsePublisher.js';

async function legacyHundred(): Promise<FleetHorse[]> {
  const { data, error } = await getSupabase()
    .from('content_authors')
    .select('id, name, profile_id, timezone, is_active')
    .eq('is_active', true)
    .not('profile_id', 'is', null)
    .order('profile_id')
    .limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []) as FleetHorse[];
}

/** Single-horse handler: GET /cron/horse/:horseIndex */
export async function horseByIndex(c: Context) {
  const index = parseInt(c.req.param('horseIndex') ?? '', 10);
  if (isNaN(index) || index < 0 || index > 99) {
    return c.json({ error: 'horseIndex must be 0-99' }, 400);
  }
  try {
    if (!(await engineEnabled())) return c.json({ success: true, skipped: 'engine_disabled' });
    const horses = await legacyHundred();
    const horse = horses[index];
    if (!horse) return c.json({ success: false, error: 'No horse' });
    const result = await publishForHorse(horse);
    return c.json({ ...result, horseIndex: index, legacy: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[horse-by-index] error:', msg);
    return c.json({ success: false, error: msg }, 500);
  }
}

/** Batch handler: GET /cron/horse-batch/:horseIndex (batch 0..9 = 10 horses) */
export async function horseBatch(c: Context) {
  const batch = parseInt(c.req.param('horseIndex') ?? '', 10);
  if (isNaN(batch) || batch < 0 || batch > 9) {
    return c.json({ error: 'batchIndex must be 0-9' }, 400);
  }
  try {
    if (!(await engineEnabled())) return c.json({ success: true, skipped: 'engine_disabled' });
    const horses = await legacyHundred();
    const start = batch * 10;
    const results = [];
    for (let i = start; i < start + 10 && i < horses.length; i++) {
      const horse = horses[i]!;
      try {
        results.push(await publishForHorse(horse));
      } catch (err) {
        results.push({
          success: false,
          horse: horse.name,
          profile_id: horse.profile_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return c.json({
      success: true,
      legacy: true,
      batch,
      processed: results.length,
      succeeded: results.filter((r) => r.success).length,
      skipped_recent: results.filter((r) => 'skipped' in r && r.skipped === 'posted_recently').length,
      results,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[horse-batch/${batch}] fatal:`, msg);
    return c.json({ success: false, error: msg }, 500);
  }
}
