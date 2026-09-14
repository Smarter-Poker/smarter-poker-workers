/**
 * GET/POST /cron/video-library-scraper
 *
 * Ported from pages/api/cron/video-library-scraper.js (2026-04-24).
 *
 * STATUS endpoint + report ingest for the daily video library scrape.
 *
 * The real Python scraper runs on the Open Claw host. This HTTP handler:
 *   - GET                 : status payload — total_videos + per-source + last_scrape
 *   - GET ?trigger=1      : log a manual-trigger audit row (does NOT run the scraper)
 *   - POST ?report=1      : ingest a scraper report into data_audit_log
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getSupabase } from '../lib/supabase.js';

export async function videoLibraryScraper(c: Context) {
  try {
    const supabase = getSupabase();
    const trigger = c.req.query('trigger');
    const report = c.req.query('report');

    // MODE 1: ingest a scrape report from the Python script
    if (report === '1' && c.req.method === 'POST') {
      let body: Record<string, unknown>;
      try {
        const raw = await c.req.text();
        if (raw.length > 32_000) throw new Error('report too large');
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('report must be an object');
        }
        body = parsed as Record<string, unknown>;
      } catch {
        return c.json({ success: false, accepted: false, error: 'Invalid scrape report' }, 400);
      }
      const counters = ['processed', 'failed', 'total_found', 'total_new', 'insert_failed', 'metadata_failed'];
      const started = typeof body.ran_at === 'string' ? Date.parse(body.ran_at) : NaN;
      const finished = typeof body.completed_at === 'string' ? Date.parse(body.completed_at) : NaN;
      if (typeof body.run_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.run_id)
        || !['full', 'source'].includes(String(body.scope))
        || counters.some((key) => !Number.isSafeInteger(body[key]) || Number(body[key]) < 0)
        || !Number.isFinite(started) || !Number.isFinite(finished) || started > finished
        || finished > Date.now() + 30_000 || Date.now() - finished > 300_000
        || typeof body.elapsed_s !== 'number' || !Number.isFinite(body.elapsed_s) || body.elapsed_s < 0
        || (body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.some((e) => typeof e !== 'string')))) {
        return c.json({ success: false, accepted: false, error: 'Missing, invalid or stale scrape result' }, 400);
      }
      const failed = Number(body.failed) > 0 || Number(body.insert_failed) > 0
        || Number(body.metadata_failed) > 0 || (Array.isArray(body.errors) && body.errors.length > 0);
      const proof = { ...body, scraper: 'video_library_scraper_v3', success: !failed,
        creators_processed: body.processed, creators_failed: body.failed };
      const row = { id: body.run_id, record_id: body.run_id, table_name: 'video_library_videos',
        action: 'scrape', scrape_proof: proof };
      const { data: inserted, error: auditError } = await supabase.from('data_audit_log')
        .insert(row).select('id').maybeSingle();
      if (auditError?.code === '23505') {
        const { data: previous, error: readError } = await supabase.from('data_audit_log')
          .select('id, record_id, table_name, action, scrape_proof').eq('id', body.run_id).maybeSingle();
        if (readError || !isDeepStrictEqual(previous, row)) {
          return c.json({ success: false, accepted: false, error: 'Scrape report identity conflict' }, 409);
        }
      } else if (auditError || inserted?.id !== body.run_id) {
        return c.json({ success: false, accepted: false, error: auditError?.message ?? 'Scrape report commit unconfirmed' }, 503);
      }
      if (failed) {
        const { data: alertId, error: alertError } = await supabase.rpc('fn_record_operational_alert', {
          p_source: 'video-library-scraper', p_event_key: body.run_id,
          p_alertname: 'VideoLibraryScrapeFailed', p_status: 'firing', p_severity: 'warning',
          p_payload: { report: proof, audit_id: body.run_id },
        });
        if (alertError || !Number.isSafeInteger(alertId) || Number(alertId) <= 0) {
          return c.json({ success: false, accepted: false, error: 'Operational alert receipt unconfirmed' }, 503);
        }
      }
      return c.json({ success: !failed, accepted: true, run_id: body.run_id, audit_id: body.run_id,
        creators_failed: body.failed, insert_failed: body.insert_failed, metadata_failed: body.metadata_failed,
        message: failed ? 'Scrape failures recorded' : 'Scrape completed and recorded' }, failed ? 503 : 200);
    }

    if (c.req.method !== 'GET') {
      return c.json({ success: false, accepted: false, error: 'POST requires report=1' }, 400);
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

    const readError = countResult.error || bySourceResult.error || lastAuditResult.error;
    if (readError) return c.json({ success: false, error: readError.message }, 503);

    const totalVideos = countResult.count ?? 0;

    const bySource: Record<string, number> = {};
    for (const row of (bySourceResult.data ?? []) as Array<{ source_id: string | null }>) {
      if (row.source_id) bySource[row.source_id] = (bySource[row.source_id] ?? 0) + 1;
    }

    const auditRows = (lastAuditResult.data ?? []) as Array<{ scrape_proof: string | Record<string, unknown> | null; created_at: string }>;
    const lastAudit = auditRows[0] ?? null;
    let lastScrape: {
      ran_at?: string;
      creators_processed?: number;
      creators_failed?: number;
      total_found?: number;
      total_new?: number;
      elapsed_s?: number;
      success?: boolean;
      run_id?: string;
      completed_at?: string;
      metadata_failed?: number;
      insert_failed?: number;
    } | null = null;
    if (lastAudit) {
      try {
        const proof = (typeof lastAudit.scrape_proof === 'string'
          ? JSON.parse(lastAudit.scrape_proof) : lastAudit.scrape_proof ?? {}) as Record<string, unknown>;
        lastScrape = {
          ran_at: (proof.ran_at as string | undefined) ?? lastAudit.created_at,
          creators_processed: proof.creators_processed as number | undefined,
          creators_failed: proof.creators_failed as number | undefined,
          total_found: proof.total_found as number | undefined,
          total_new: ((proof.total_new ?? proof.total_imported) as number | undefined),
          elapsed_s: proof.elapsed_s as number | undefined,
          success: proof.success as boolean | undefined,
          run_id: proof.run_id as string | undefined,
          completed_at: proof.completed_at as string | undefined,
          metadata_failed: proof.metadata_failed as number | undefined,
          insert_failed: proof.insert_failed as number | undefined,
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
