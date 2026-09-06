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
import { engineEnabled } from '../lib/content-engine/Fleet.js';
import { fleetHash } from '../lib/content-engine/FleetScheduler.js';
import { pokerChannelIndex } from '../lib/content-engine/ClipSupply.js';

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

/** How many library videos become reels in one run. */
const BRIDGE_LIMIT = 40;

/**
 * Turn the newest library videos into reels - the half of this job that has
 * not run since 2026-04-22.
 *
 * WHY IT STOPPED. The bridge lives in a python script the dispatcher lists as
 * a SCRIPT_JOB, and SCRIPT_JOBS not in WORKERS_PREFERRED are SKIPPED on the
 * secondary host - which is the only host that fires. So the library gained
 * 1,573 videos while the reels feed gained none, and the daily job reported
 * itself as running the whole time. (A 2026-09-04 pass corrected the script's
 * flag from --sync-captions to --limit 100, which was right and still changed
 * nothing, because the script never executes on that host.)
 *
 * THE ATTRIBUTION IS PART OF THE FIX. The April run put all 200 reels on ONE
 * horse, vegasgrinder85, in one day. A single account posting 200 reels in an
 * afternoon is the behaviour this whole programme exists to end, so the bridge
 * now spreads them across the fleet, deterministically by video id, and caps
 * each run at 40. Reels arrive at the pace a person would produce them.
 *
 * ONLY registered poker channels. The library also carries slots content -
 * Brian Christopher Slots, Lady Luck HQ, The Big Jackpot - and a slots pull in
 * a poker feed is exactly the off-key content this phase is about.
 */
export async function bridgeLibraryToReels(dryRun: boolean): Promise<{
  candidates: number;
  created: number;
  skipped_existing: number;
  authors: number;
}> {
  const supabase = getSupabase();

  const [{ byName: poker, rawNames }, { data: horseRows }] = await Promise.all([
    pokerChannelIndex(),
    supabase.from('profiles').select('id').eq('is_horse', true).limit(1000),
  ]);
  const horses = ((horseRows ?? []) as Array<{ id: string }>).map((h) => h.id);
  if (!poker.size || !horses.length) return { candidates: 0, created: 0, skipped_existing: 0, authors: 0 };

  // Filter to poker sources IN THE QUERY, not after. The library's slots
  // channels publish daily, so they dominate any "newest N" window: reading
  // the newest 400 rows and filtering afterwards surfaced 21 poker videos,
  // and the bridge looked finished when it had barely started.
  const { data: videos, error } = await supabase
    .from('video_library_videos')
    .select('youtube_video_id, video_url, title, source_name, thumbnail_url, published_at')
    .not('youtube_video_id', 'is', null)
    .in('source_name', rawNames)
    .order('published_at', { ascending: false, nullsFirst: false })
    .limit(1200);
  if (error) {
    console.warn('[video-library-reels] library read failed:', error.message);
    return { candidates: 0, created: 0, skipped_existing: 0, authors: 0 };
  }

  const eligible = ((videos ?? []) as Array<Record<string, string | null>>).filter(
    (v) => v.source_name && poker.has(v.source_name.toLowerCase()) && v.title,
  );
  if (!eligible.length) return { candidates: 0, created: 0, skipped_existing: 0, authors: 0 };

  // Which are already reels? One read, not one per video.
  const ids = eligible.map((v) => v.youtube_video_id!) as string[];
  const have = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data: existing, error: exErr } = await supabase
      .from('social_reels')
      .select('youtube_video_id')
      .in('youtube_video_id', ids.slice(i, i + 200));
    if (exErr) {
      // Never create a duplicate reel because a read failed. Stop instead.
      console.warn('[video-library-reels] existing-reel check failed:', exErr.message);
      return { candidates: eligible.length, created: 0, skipped_existing: have.size, authors: 0 };
    }
    for (const r of (existing ?? []) as Array<{ youtube_video_id: string | null }>) {
      if (r.youtube_video_id) have.add(r.youtube_video_id);
    }
  }

  const todo = eligible.filter((v) => !have.has(v.youtube_video_id!)).slice(0, BRIDGE_LIMIT);
  if (!todo.length) {
    return { candidates: eligible.length, created: 0, skipped_existing: have.size, authors: 0 };
  }

  const authors = new Set<string>();
  const rows = todo.map((v) => {
    const author = horses[fleetHash(v.youtube_video_id!, 'reel-author') % horses.length]!;
    authors.add(author);
    return {
      author_id: author,
      video_url: v.video_url ?? `https://www.youtube.com/watch?v=${v.youtube_video_id}`,
      thumbnail_url: v.thumbnail_url,
      caption: (v.title ?? '').slice(0, 300),
      source_type: 'video_library',
      is_public: true,
    };
  });

  if (dryRun) {
    return { candidates: eligible.length, created: 0, skipped_existing: have.size, authors: authors.size };
  }

  // The yt-intercept BEFORE trigger fills youtube_video_id and
  // original_youtube_url from video_url, which is why those are not set here.
  const { data: inserted, error: insErr } = await supabase
    .from('social_reels')
    .insert(rows)
    .select('id');
  if (insErr) {
    console.warn('[video-library-reels] bridge insert failed:', insErr.message);
    return { candidates: eligible.length, created: 0, skipped_existing: have.size, authors: authors.size };
  }
  const created = (inserted ?? []) as Array<{ id: string }>;

  // ...and the same trigger also sets media_status='queued', which enrols the
  // reel in the yt-dlp download pipeline. That pipeline is blocked by
  // YouTube's anti-bot response - it is what left 144 reels queued and
  // invisible from 2026-08-05 to today. Feeding it more would recreate the
  // defect this phase just cleared, so the reels are flipped to the shape that
  // plays: source_type youtube, video_url pointing at YouTube, ready. It is
  // the shape 11,124 working reels already have, and the same principle the
  // fallback trigger encodes - a local copy is an optimisation, being
  // watchable is the product. If the download pipeline is ever unblocked it
  // can still upgrade these in place.
  if (created.length) {
    const { error: readyErr } = await supabase
      .from('social_reels')
      .update({ media_status: 'ready' })
      .in('id', created.map((r) => r.id))
      .eq('media_status', 'queued');
    if (readyErr) console.warn('[video-library-reels] could not mark ready:', readyErr.message);
  }

  return {
    candidates: eligible.length,
    created: created.length,
    skipped_existing: have.size,
    authors: authors.size,
  };
}

export async function videoLibraryReels(c: Context) {
  try {
    if (!(await engineEnabled())) {
      return c.json({
        success: true,
        skipped: 'engine_disabled',
        timestamp: new Date().toISOString(),
      });
    }

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

    // The bridge runs AFTER the caption sync, so a reel created this run is
    // not immediately re-read by it. This is the half of the job that had not
    // run since 2026-04-22.
    const bridge = await bridgeLibraryToReels(dryRun);
    console.log(
      `[video-library-reels] bridge — candidates=${bridge.candidates} created=${bridge.created} across ${bridge.authors} horses`,
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
      bridge,
    });
  } catch (err) {
    console.error('[video-library-reels] fatal:', err instanceof Error ? err.message : String(err));
    return c.json({ success: false, error: err instanceof Error ? err.message : 'unknown' }, 500);
  }
}
