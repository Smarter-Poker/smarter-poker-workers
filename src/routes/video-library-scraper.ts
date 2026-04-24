/**
 * GET/POST /cron/video-library-scraper
 *
 * Ported from pages/api/cron/video-library-scraper.js (2026-04-24).
 *
 * STATUS endpoint + report ingest for the daily video library scrape.
 *
 * The REAL scraper is scripts/video_library_scraper.py (runs on Dan's Mac
 * via Open Claw, yt-dlp can't execute on Vercel/Docker). This HTTP handler:
 *   - GET                 : status payload — total_videos + per-source + last_scrape
 *   - GET ?trigger=1      : log a manual-trigger audit row (does NOT run the scraper)
 *   - POST ?report=1      : ingest a scraper report into data_audit_log
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { getSupabase } from '../lib/supabase.js';

export async function videoLibraryScraper(c: Context) {
  try {
    const supabase = getSupabase();
    const trigger = c.req.query('trigger');
    const report = c.req.query('report');

    // MODE 1: ingest a scrape report from the Python script
    if (report === '1' && c.req.method === 'POST') {
      let body: Record<string, unknown> = {};
      try {
        body = (await c.req.json()) as Record<string, unknown>;
      } catch {
        /* empty body is acceptable */
      }
      try {
        await supabase.from('data_audit_log').insert({
          record_id: randomUUID(),
          table_name: 'video_library_videos',
          action: 'scrape',
          scrape_proof: JSON.stringify({
            scraper: 'video_library_scraper_v2_py',
            ...body,
            reported_at: new Date().toISOString(),
          }),
        });
        console.log('[video-library-scraper] report received and logged');
      } catch (auditErr) {
        console.warn(
          '[video-library-scraper] audit log failed:',
          auditErr instanceof Error ? auditErr.message : String(auditErr),
        );
      }
      return c.json({ success: true, message: 'Report logged' });
    }

    // MODE 2: status check
    const [countResult, bySourceResult, lastAuditResult] = await Promise.all([
      supabase.from('video_library_videos').select('id', { count: 'exact', head: true }),
      supabase.from('video_library_videos').select('source_id'),
      supabase
        .from('data_audit_log')
        .select('scrape_proof, created_at')
        .eq('table_name', 'video_library_videos')
        .eq('action', 'scrape')
        .order('created_at', { ascending: false })
        .limit(1),
    ]);

    const totalVideos = countResult.count ?? 0;

    const bySource: Record<string, number> = {};
    for (const row of (bySourceResult.data ?? []) as Array<{ source_id: string | null }>) {
      if (row.source_id) bySource[row.source_id] = (bySource[row.source_id] ?? 0) + 1;
    }

    const auditRows = (lastAuditResult.data ?? []) as Array<{ scrape_proof: string | null; created_at: string }>;
    const lastAudit = auditRows[0] ?? null;
    let lastScrape: {
      ran_at?: string;
      creators_processed?: number;
      creators_failed?: number;
      total_found?: number;
      total_new?: number;
      elapsed_s?: number;
    } | null = null;
    if (lastAudit) {
      try {
        const proof = JSON.parse(lastAudit.scrape_proof ?? '{}') as Record<string, unknown>;
        lastScrape = {
          ran_at: (proof.ran_at as string | undefined) ?? lastAudit.created_at,
          creators_processed: proof.creators_processed as number | undefined,
          creators_failed: proof.creators_failed as number | undefined,
          total_found: proof.total_found as number | undefined,
          total_new: ((proof.total_new ?? proof.total_imported) as number | undefined),
          elapsed_s: proof.elapsed_s as number | undefined,
        };
      } catch {
        lastScrape = { ran_at: lastAudit.created_at };
      }
    }

    // Log trigger request if asked
    if (trigger === '1') {
      try {
        await supabase.from('data_audit_log').insert({
          record_id: randomUUID(),
          table_name: 'video_library_videos',
          action: 'scrape_trigger',
          scrape_proof: JSON.stringify({
            triggered_by: 'manual_api_call',
            triggered_at: new Date().toISOString(),
            note: 'Python scraper should be triggered separately via Open Claw',
          }),
        });
      } catch {
        /* best-effort */
      }
      console.log('[video-library-scraper] manual trigger logged — run: python3 scripts/video_library_scraper.py');
    }

    return c.json({
      success: true,
      timestamp: new Date().toISOString(),
      total_videos: totalVideos,
      creators: Object.keys(bySource).length,
      by_source: bySource,
      last_scrape: lastScrape,
      note: 'Real ingestion runs via python3 scripts/video_library_scraper.py (yt-dlp engine). This endpoint reports status only.',
    });
  } catch (err) {
    console.error(
      '[video-library-scraper] fatal:',
      err instanceof Error ? err.message : String(err),
    );
    return c.json(
      { success: false, error: err instanceof Error ? err.message : 'unknown' },
      500,
    );
  }
}
