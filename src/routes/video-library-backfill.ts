/**
 * GET/POST /cron/video-library-backfill
 *
 * Ported from World Hub pages/api/cron/video-library-backfill.js (2026-04-24).
 * Port pattern: Phase 2B.2 — source handler logic preserved, wired to Hono.
 *
 * GET:
 *   Returns status payload — count of videos that still need backfill
 *   (views_count=0 OR published_at>=today) + last 3 backfill records.
 *
 * POST with ?report=1:
 *   Accepts a backfill report from scripts/video_library_scraper.py
 *   (Open Claw fires the python script every Saturday 23:00 UTC).
 *
 * Auth: /cron/* middleware chain (requireCronSecret + ipAllowlist).
 */
import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { getSupabase } from '../lib/supabase.js';

export async function videoLibraryBackfill(c: Context) {
  try {
    const supabase = getSupabase();
    const report = c.req.query('report');

    // ── MODE 1: Receive backfill report ──────────────────────────────────
    if (report === '1' && c.req.method === 'POST') {
      let body: { updated?: number; failed?: number } = {};
      try {
        body = await c.req.json<typeof body>();
      } catch {
        /* empty body acceptable */
      }

      try {
        await supabase.from('data_audit_log').insert({
          record_id: randomUUID(),
          table_name: 'video_library_videos',
          action: 'backfill',
          scrape_proof: JSON.stringify({
            scraper: 'video_library_scraper_v3_backfill',
            updated: body.updated ?? 0,
            failed: body.failed ?? 0,
            reported_at: new Date().toISOString(),
          }),
        });
        console.log('[video-library-backfill] report received and logged');
      } catch (auditErr) {
        console.warn(
          '[video-library-backfill] audit log failed:',
          auditErr instanceof Error ? auditErr.message : String(auditErr),
        );
      }

      return c.json({ success: true, message: 'Backfill report logged' });
    }

    // ── MODE 2: Status check ─────────────────────────────────────────────
    const today = new Date().toISOString().slice(0, 10);

    const [needsFixResult, lastBackfillResult] = await Promise.all([
      // count=exact + head=true returns just the count, no rows
      supabase
        .from('video_library_videos')
        .select('id', { count: 'exact', head: true })
        .or(`views_count.eq.0,published_at.gte.${today}T00:00:00Z`),
      supabase
        .from('data_audit_log')
        .select('scrape_proof, created_at')
        .eq('table_name', 'video_library_videos')
        .eq('action', 'backfill')
        .order('created_at', { ascending: false })
        .limit(3),
    ]);

    const lastBackfills = (lastBackfillResult.data ?? []).map((row: { scrape_proof: string | null }) => {
      try {
        return JSON.parse(row.scrape_proof ?? '{}');
      } catch {
        return {};
      }
    });

    return c.json({
      success: true,
      timestamp: new Date().toISOString(),
      needs_backfill: needsFixResult.count ?? 0,
      last_backfills: lastBackfills,
      note: 'Backfill runs Saturdays 23:00 UTC via: python3 scripts/video_library_scraper.py --backfill',
    });
  } catch (err) {
    console.error(
      '[video-library-backfill] fatal:',
      err instanceof Error ? err.message : String(err),
    );
    return c.json(
      { success: false, error: err instanceof Error ? err.message : 'unknown' },
      500,
    );
  }
}
