/**
 * GET/POST /cron/revalidate-poker-clips
 *
 * Asks YouTube whether each clip still exists, oldest answer first, and
 * writes the answer to the row.
 *
 * WHY THIS IS A CRON AND NOT A CHECK AT POST TIME. There was a validity check
 * at post time, and it was a Map in process memory with a TTL. It died with
 * every container, so every restart re-asked about the same videos, and no
 * answer ever outlived the process. Probing all 149 hard-coded clips on
 * 2026-09-06 found 36 dead - 22 deleted or private, 14 with embedding
 * disabled - and every one of them was still being offered to horses.
 *
 * A dead clip is not an error, it is a fact about the world that we should
 * only have to learn once. Learning it here keeps it out of the publisher's
 * critical path: the post-time check stays as a last guard, but on a healthy
 * pool it now almost always agrees with the row.
 *
 * BACKING OFF IS PART OF BEING CORRECT. YouTube answers 429 to a burst and
 * 403 to a suspected bot, and neither means the video is gone. Reading either
 * as "dead" would empty the pool in one run - the same shape of mistake as
 * the process-memory cache, but permanent. So a non-answer leaves the row
 * exactly as it was and stops the run.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { recordYouTubeVerification } from '../lib/content-engine/HorseVideoPublication.js';
import { verifyYouTubeMetadata } from '../lib/content-engine/YouTubeMetadataVerifier.js';

const CONFIG = {
  /** Per run. At 40 an hour the whole pool is re-checked well inside a week. */
  MAX_CHECKS: 40,
  DELAY_MS: 350,
  TIMEOUT_MS: 10_000,
  /** Do not re-ask about a clip answered inside this window. */
  RECHECK_AFTER_DAYS: 7,
  /**
   * Three 403 answers in a row indicate IP/bot throttling rather than
   * individual embed-disabled clips. Hold buffered 403 rows untouched and
   * stop the sweep.
   */
  MAX_CONSECUTIVE_403: 3,
  /**
   * Bounded yt-dlp metadata verification per hourly run so newly scraped
   * poker clips enter the shared youtube_embed_failures verification ledger
   * (fn_fresh_public_youtube_verification_ids) inside the route budget.
   */
  MAX_METADATA_CHECKS: 15,
  DEADLINE_MS: 90_000,
} as const;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Answer = 'ok' | 'dead' | 'forbidden' | 'no-answer';

/**
 * One oEmbed question.
 *
 * - `no-answer`: 429, 5xx, timeout, or network error. Always abort the sweep.
 * - `forbidden`: HTTP 403. May be a single video with embedding disabled OR
 *   an IP-level bot block; the caller buffers it until a subsequent clip
 *   proves YouTube is still answering (or aborts after MAX_CONSECUTIVE_403).
 * - `dead`: 404, 401, other non-ok status, or missing iframe payload.
 * - `ok`: 200 with iframe HTML.
 */
export async function askYouTube(videoId: string): Promise<Answer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { signal: controller.signal, headers: { 'User-Agent': UA } },
    );
    clearTimeout(timer);
    if (res.status === 429 || res.status >= 500) return 'no-answer';
    if (res.status === 403) return 'forbidden';
    if (res.status === 404 || res.status === 401) return 'dead';
    if (!res.ok) return 'dead';
    const body = (await res.json()) as { html?: string };
    return body.html?.includes('iframe') ? 'ok' : 'dead';
  } catch {
    clearTimeout(timer);
    return 'no-answer';
  }
}

async function markClip(
  clipId: string,
  ok: boolean,
  checkedAt: string,
): Promise<boolean> {
  const { error } = await getSupabase()
    .from('poker_clips')
    .update({ oembed_ok: ok, oembed_checked_at: checkedAt, is_active: ok })
    .eq('id', clipId);
  if (error) {
    console.warn('[revalidate-poker-clips] write failed:', error.message);
    return false;
  }
  return true;
}

export async function revalidatePokerClips(c: Context) {
  const started = Date.now();
  const cutoff = new Date(Date.now() - CONFIG.RECHECK_AFTER_DAYS * 86_400_000).toISOString();

  const { data, error } = await getSupabase()
    .from('poker_clips')
    .select('id, video_id, oembed_checked_at')
    .eq('is_active', true)
    .or('category.is.null,category.neq.slots')
    .or(`oembed_checked_at.is.null,oembed_checked_at.lt.${cutoff}`)
    .order('oembed_checked_at', { ascending: true, nullsFirst: true })
    .limit(CONFIG.MAX_CHECKS);

  if (error) {
    console.warn('[revalidate-poker-clips] read failed:', error.message);
    return c.json({ success: false, error: error.message }, 500);
  }

  const clips = (data ?? []) as { id: string; video_id: string }[];
  let checked = 0;
  let stillOk = 0;
  let retired = 0;
  let blocked = false;
  let stoppedEarlyDeadline = false;
  let consecutive403 = 0;
  let metadataChecked = 0;
  let metadataVerified = 0;
  let metadataRejected = 0;
  let metadataUnknown = 0;
  const metadataUnknownReasons: Record<string, number> = {};
  const recordMetadataUnknownReason = (reason: string | undefined) => {
    const key = reason && reason.trim() ? reason.trim() : 'unknown';
    metadataUnknownReasons[key] = (metadataUnknownReasons[key] ?? 0) + 1;
  };
  const pendingForbidden: Array<{ id: string; video_id: string; checkedAt: string }> = [];

  const flushPendingForbidden = async () => {
    while (pendingForbidden.length > 0) {
      const item = pendingForbidden.shift()!;
      checked++;
      retired++;
      await markClip(item.id, false, item.checkedAt);
      await recordYouTubeVerification(item.video_id, 'embed_disabled', item.checkedAt);
    }
  };

  for (const clip of clips) {
    if (Date.now() - started >= CONFIG.DEADLINE_MS) {
      stoppedEarlyDeadline = true;
      break;
    }

    const checkedAt = new Date().toISOString();
    const answer = await askYouTube(clip.video_id);

    if (answer === 'no-answer') {
      // Leave every buffered 403 and remaining row untouched.
      blocked = true;
      break;
    }

    if (answer === 'forbidden') {
      pendingForbidden.push({ id: clip.id, video_id: clip.video_id, checkedAt });
      consecutive403++;
      if (consecutive403 >= CONFIG.MAX_CONSECUTIVE_403) {
        blocked = true;
        break;
      }
      await delay(CONFIG.DELAY_MS);
      continue;
    }

    // YouTube positively answered (200/404/401), proving this IP is not
    // bot-blocked. Any preceding buffered 403s were single-video embed blocks.
    consecutive403 = 0;
    await flushPendingForbidden();

    if (answer === 'dead') {
      checked++;
      retired++;
      await markClip(clip.id, false, checkedAt);
      await recordYouTubeVerification(clip.video_id, 'unavailable', checkedAt);
      await delay(CONFIG.DELAY_MS);
      continue;
    }

    // oEmbed returned 200 with iframe. Within budget, run full public/embed
    // metadata verification so the clip qualifies in the shared verification
    // ledger used by the horse publishers.
    let finalOk = true;
    if (
      metadataChecked < CONFIG.MAX_METADATA_CHECKS
      && Date.now() - started < CONFIG.DEADLINE_MS
    ) {
      metadataChecked++;
      const metadata = await verifyYouTubeMetadata(clip.video_id);
      if (metadata.verdict === 'verified') {
        const recorded = await recordYouTubeVerification(clip.video_id, 'verified', checkedAt);
        if (recorded) metadataVerified++;
        else {
          metadataUnknown++;
          recordMetadataUnknownReason('verification_record_failed');
        }
      } else if (metadata.verdict === 'embed_disabled' || metadata.verdict === 'unavailable') {
        await recordYouTubeVerification(clip.video_id, metadata.verdict, checkedAt);
        finalOk = false;
        metadataRejected++;
      } else {
        metadataUnknown++;
        recordMetadataUnknownReason(metadata.reason);
      }
    }

    checked++;
    if (finalOk) stillOk++;
    else retired++;
    await markClip(clip.id, finalOk, checkedAt);
    await delay(CONFIG.DELAY_MS);
  }

  // If the entire candidate list consisted solely of 403s with zero positive
  // answers from YouTube, treat the run as blocked and leave rows untouched.
  if (pendingForbidden.length > 0 && checked === 0) {
    blocked = true;
  }

  const { count: poolSize } = await getSupabase()
    .from('poker_clips')
    .select('*', { count: 'exact', head: true })
    .eq('is_active', true)
    .or('category.is.null,category.neq.slots');

  return c.json({
    success: true,
    timestamp: new Date().toISOString(),
    ms: Date.now() - started,
    candidates: clips.length,
    checked,
    still_ok: stillOk,
    retired,
    pending_forbidden_held: pendingForbidden.length,
    metadata_checked: metadataChecked,
    metadata_verified: metadataVerified,
    metadata_rejected: metadataRejected,
    metadata_unknown: metadataUnknown,
    metadata_unknown_reasons: metadataUnknownReasons,
    stopped_early_blocked: blocked,
    stopped_early_deadline: stoppedEarlyDeadline,
    pool_size: poolSize ?? null,
  });
}
