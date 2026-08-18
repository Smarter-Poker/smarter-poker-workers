/**
 * GET/POST /cron/video-library-reels
 *
 * Ported from World Hub scripts/video_library_to_reels.py --sync-captions
 * (the `sync_captions()` function, lines 359-425). Port pattern: Phase 2B.2 —
 * source logic preserved, wired to Hono.
 *
 * WHY THIS ROUTE EXISTS AT ALL
 * This job has run 72 times since 2026-05-04 and succeeded ZERO times. It was
 * the only entry in the dispatcher's WORKERS_PREFERRED map with no route on
 * this service, so every firing 404'd. Its handler had lived in World Hub as
 * pages/api/cron/video-library-reels.js, added 6abfc11dbc (2026-04-25) and
 * deleted 60a07b0b29 (2026-04-27) in a "delete 7 dead-code cron handlers"
 * batch that ported the others here and missed this one.
 *
 * There is a second, older bug in the same job worth knowing, because it
 * explains why restoring the route is not sufficient on the Mac path: the
 * dispatcher's SCRIPT_JOBS entry passed `--sync-captions` to
 * video_library_scraper.py, whose argparse does not accept that flag — it
 * belongs to video_library_to_reels.py. Fixed 2026-08-15 by adding
 * SCRIPT_JOB_SCRIPTS, but SCRIPT_JOBS are skipped entirely on the
 * secondary/Hetzner dispatcher, so on the host that actually fires, only this
 * HTTP route can do the work.
 *
 * WHAT IT DOES
 * Reels created from the video library carry the YouTube title as their
 * caption. When a creator renames a video, video_library_videos.title updates
 * on the next scrape but the reel's caption keeps the old text forever. This
 * reconciles the two.
 *
 *   1. Load social_reels where source_type = 'video_library'
 *   2. Extract the 11-char YouTube id from each video_url
 *      (watch?v= | /embed/ | /shorts/)
 *   3. Load video_library_videos (youtube_video_id, title)
 *   4. Where the title differs from the caption, update the caption
 *
 * Idempotent: a second run immediately after a first updates nothing, because
 * the comparison is exact-match on the trimmed strings.
 *
 * QUERY PARAMS
 *   ?dry_run=1   report what would change, write nothing
 *   ?limit=N     cap rows fetched per table (default 5000, matching the python)
 *
 * Auth: /cron/* middleware chain (requireCronSecret + ipAllowlist).
 */
import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { getSupabase } from '../lib/supabase.js';

const DEFAULT_LIMIT = 5000;
const ID_PATTERNS = ['watch?v=', '/embed/', '/shorts/'] as const;

interface ReelRow {
  id: string;
  video_url: string | null;
  caption: string | null;
}

interface VideoRow {
  youtube_video_id: string | null;
  title: string | null;
}

/**
 * Pull the 11-character YouTube id out of a watch / embed / shorts URL.
 * Mirrors the python exactly, including the 11-char truncation — do not
 * "improve" this into a regex without first checking the stored URL shapes.
 */
export function extractYouTubeId(url: string | null | undefined): string | null {
  if (!url) return null;
  for (const pattern of ID_PATTERNS) {
    const idx = url.indexOf(pattern);
    if (idx === -1) continue;
    const tail = url.slice(idx + pattern.length);
    const id = tail.split('&')[0]?.split('?')[0]?.slice(0, 11) ?? '';
    return id.length > 0 ? id : null;
  }
  return null;
}

export async function videoLibraryReels(c: Context) {
  try {
    const supabase = getSupabase();
    const dryRun = c.req.query('dry_run') === '1';
    const limit = Number(c.req.query('limit')) || DEFAULT_LIMIT;

    const [reelsResult, videosResult] = await Promise.all([
      supabase
        .from('social_reels')
        .select('id, video_url, caption')
        .eq('source_type', 'video_library')
        .limit(limit),
      supabase.from('video_library_videos').select('youtube_video_id, title').limit(limit),
    ]);

    if (reelsResult.error) {
      throw new Error(`social_reels read failed: ${reelsResult.error.message}`);
    }
    if (videosResult.error) {
      throw new Error(`video_library_videos read failed: ${videosResult.error.message}`);
    }

    const reels = (reelsResult.data ?? []) as ReelRow[];
    const videos = (videosResult.data ?? []) as VideoRow[];

    // youtube id -> reel. Later duplicates win, matching the python's dict
    // assignment order.
    const reelById = new Map<string, ReelRow>();
    for (const reel of reels) {
      const id = extractYouTubeId(reel.video_url);
      if (id) reelById.set(id, reel);
    }

    let mismatched = 0;
    let updated = 0;
    let skipped = 0;
    const failures: Array<{ videoId: string; error: string }> = [];

    for (const video of videos) {
      const videoId = video.youtube_video_id ?? '';
      const newTitle = (video.title ?? '').trim();
      const reel = videoId ? reelById.get(videoId) : undefined;

      if (!reel || !newTitle) {
        skipped++;
        continue;
      }

      const oldCaption = (reel.caption ?? '').trim();
      if (oldCaption === newTitle) {
        skipped++;
        continue;
      }

      mismatched++;
      if (dryRun) {
        updated++;
        continue;
      }

      const { error } = await supabase
        .from('social_reels')
        .update({ caption: newTitle })
        .eq('id', reel.id);

      if (error) {
        failures.push({ videoId, error: error.message });
        console.warn(
          `[video-library-reels] caption update failed for ${videoId}: ${error.message}`,
        );
      } else {
        updated++;
      }
    }

    // Same audit shape as video-library-backfill, so the whole family reads
    // consistently in data_audit_log.
    if (!dryRun && mismatched > 0) {
      try {
        await supabase.from('data_audit_log').insert({
          record_id: randomUUID(),
          table_name: 'social_reels',
          action: 'caption_sync',
          scrape_proof: JSON.stringify({
            scraper: 'video_library_to_reels_sync_captions',
            mismatched,
            updated,
            skipped,
            failed: failures.length,
            reported_at: new Date().toISOString(),
          }),
        });
      } catch (auditErr) {
        console.warn(
          '[video-library-reels] audit log failed:',
          auditErr instanceof Error ? auditErr.message : String(auditErr),
        );
      }
    }

    console.log(
      `[video-library-reels] caption sync done — mismatched=${mismatched} updated=${updated} skipped=${skipped} failed=${failures.length}${dryRun ? ' (dry run)' : ''}`,
    );

    return c.json({
      success: true,
      dry_run: dryRun,
      timestamp: new Date().toISOString(),
      reels_scanned: reels.length,
      reels_with_video_id: reelById.size,
      videos_scanned: videos.length,
      mismatched,
      updated,
      skipped,
      failed: failures.length,
      failures: failures.slice(0, 10),
    });
  } catch (err) {
    console.error('[video-library-reels] fatal:', err instanceof Error ? err.message : String(err));
    return c.json({ success: false, error: err instanceof Error ? err.message : 'unknown' }, 500);
  }
}
