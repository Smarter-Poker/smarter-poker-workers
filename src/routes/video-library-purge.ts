/**
 * GET/POST /cron/video-library-purge
 *
 * Ported from pages/api/cron/video-library-purge.js (2026-04-24).
 *
 * STATUS endpoint + report ingest for the weekly dead-video purge.
 * Real purge runs via: python3 scripts/video_library_scraper.py --purge
 * (Sunday 00:00 UTC via Open Claw on Dan's Mac).
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { getSupabase } from '../lib/supabase.js';

export async function videoLibraryPurge(c: Context) {
  try {
    const supabase = getSupabase();
    const report = c.req.query('report');

    // MODE 1: ingest purge report
    if (report === '1' && c.req.method === 'POST') {
      let body: { checked?: number; dead?: number; purged?: number } = {};
      try {
        body = (await c.req.json()) as typeof body;
      } catch {
        /* empty body acceptable */
      }
      try {
        await supabase.from('data_audit_log').insert({
          record_id: randomUUID(),
          table_name: 'video_library_videos',
          action: 'purge',
          scrape_proof: JSON.stringify({
            scraper: 'video_library_scraper_v3_purge',
            checked: body.checked ?? 0,
            dead: body.dead ?? 0,
            purged: body.purged ?? 0,
            reported_at: new Date().toISOString(),
          }),
        });
        console.log('[video-library-purge] report received and logged');
      } catch (auditErr) {
        console.warn(
          '[video-library-purge] audit log failed:',
          auditErr instanceof Error ? auditErr.message : String(auditErr),
        );
      }
      return c.json({ success: true, message: 'Purge report logged' });
    }

    // MODE 2: status check
    const [countResult, lastPurgeResult] = await Promise.all([
      supabase.from('video_library_videos').select('id', { count: 'exact', head: true }),
      supabase
        .from('data_audit_log')
        .select('scrape_proof, created_at')
        .eq('table_name', 'video_library_videos')
        .eq('action', 'purge')
        .order('created_at', { ascending: false })
        .limit(5),
    ]);

    const lastPurges = (lastPurgeResult.data ?? []).map(
      (row: { scrape_proof: string | null }) => {
        try {
          return JSON.parse(row.scrape_proof ?? '{}');
        } catch {
          return {};
        }
      },
    );

    return c.json({
      success: true,
      timestamp: new Date().toISOString(),
      total_videos: countResult.count ?? 0,
      last_purges: lastPurges,
      note: 'Purge runs Sundays 00:00 UTC via: python3 scripts/video_library_scraper.py --purge',
    });
  } catch (err) {
    console.error(
      '[video-library-purge] fatal:',
      err instanceof Error ? err.message : String(err),
    );
    return c.json(
      { success: false, error: err instanceof Error ? err.message : 'unknown' },
      500,
    );
  }
}
