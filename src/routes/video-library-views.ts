/**
 * GET/POST /cron/video-library-views
 *
 * Ported from World Hub pages/api/cron/video-library-views.js (2026-04-24).
 * Port pattern: Phase 2B.2 — source handler logic preserved, wired to Hono.
 *
 * GET (or any non-report POST):
 *   Returns status payload — top 5 videos by view count, last 3 refresh
 *   records from data_audit_log. Used by monitors.
 *
 * POST with ?report=1:
 *   Accepts a refresh report from scripts/video_library_scraper.py
 *   (Open Claw fires the python script every Friday 22:00 UTC). Writes
 *   one row to data_audit_log capturing updated/failed counts.
 *
 * Auth: /cron/* middleware chain (requireCronSecret + ipAllowlist) runs
 *       BEFORE this handler. This code assumes the request is authed.
 */
import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { getSupabase } from '../lib/supabase.js';

interface VideoRow {
  youtube_video_id: string;
  source_id: string | null;
  title: string | null;
  views_count: number | null;
  updated_at: string | null;
}

export async function videoLibraryViews(c: Context) {
  try {
    const supabase = getSupabase();
    const report = c.req.query('report');

    // ── MODE 1: Receive refresh report from the Python scraper ───────────
    if (report === '1' && c.req.method === 'POST') {
      let body: { updated?: number; failed?: number } = {};
      try {
        body = await c.req.json<typeof body>();
      } catch {
        // body may be empty / invalid JSON — treat as zero counts, still log
      }

      try {
        await supabase.from('data_audit_log').insert({
          record_id: randomUUID(),
          table_name: 'video_library_videos',
          action: 'views_refresh',
          scrape_proof: JSON.stringify({
            scraper: 'video_library_scraper_v3_refresh',
            updated: body.updated ?? 0,
            failed: body.failed ?? 0,
            reported_at: new Date().toISOString(),
          }),
        });
        console.log('[video-library-views] report received and logged');
      } catch (auditErr) {
        console.warn(
          '[video-library-views] audit log failed:',
          auditErr instanceof Error ? auditErr.message : String(auditErr),
        );
      }

      return c.json({ success: true, message: 'View refresh report logged' });
    }

    // ── MODE 2: Status check ─────────────────────────────────────────────
    const [topVideosResult, lastRefreshResult] = await Promise.all([
      supabase
        .from('video_library_videos')
        .select('youtube_video_id, source_id, title, views_count, updated_at')
        .order('views_count', { ascending: false })
        .limit(5),
      supabase
        .from('data_audit_log')
        .select('scrape_proof, created_at')
        .eq('table_name', 'video_library_videos')
        .eq('action', 'views_refresh')
        .order('created_at', { ascending: false })
        .limit(3),
    ]);

    const lastRefreshes = (lastRefreshResult.data ?? []).map((row: { scrape_proof: string | null }) => {
      try {
        return JSON.parse(row.scrape_proof ?? '{}');
      } catch {
        return {};
      }
    });

    return c.json({
      success: true,
      timestamp: new Date().toISOString(),
      top_5_videos: (topVideosResult.data ?? []) as VideoRow[],
      last_refreshes: lastRefreshes,
      note: 'View refresh runs Fridays 22:00 UTC via: python3 scripts/video_library_scraper.py --refresh-views',
    });
  } catch (err) {
    console.error(
      '[video-library-views] fatal:',
      err instanceof Error ? err.message : String(err),
    );
    return c.json(
      { success: false, error: err instanceof Error ? err.message : 'unknown' },
      500,
    );
  }
}
