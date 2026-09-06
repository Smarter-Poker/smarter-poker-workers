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

const CONFIG = {
  /** Per run. At 40 an hour the whole pool is re-checked well inside a week. */
  MAX_CHECKS: 40,
  DELAY_MS: 350,
  TIMEOUT_MS: 10_000,
  /** Do not re-ask about a clip answered inside this window. */
  RECHECK_AFTER_DAYS: 7,
} as const;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Answer = 'ok' | 'dead' | 'no-answer';

/** One oEmbed question. `no-answer` means ask again later, never "dead". */
export async function askYouTube(videoId: string): Promise<Answer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { signal: controller.signal, headers: { 'User-Agent': UA } },
    );
    clearTimeout(timer);
    // 429 and 5xx are us being throttled. 403 is usually "embedding disabled"
    // for one video, but in a sweep it is far more often bot detection, and
    // treating a block as 40 dead videos is how a pool empties itself.
    if (res.status === 429 || res.status === 403 || res.status >= 500) return 'no-answer';
    if (res.status === 404 || res.status === 401) return 'dead';
    if (!res.ok) return 'dead';
    const body = (await res.json()) as { html?: string };
    return body.html?.includes('iframe') ? 'ok' : 'dead';
  } catch {
    clearTimeout(timer);
    return 'no-answer';
  }
}

export async function revalidatePokerClips(c: Context) {
  const started = Date.now();
  const cutoff = new Date(Date.now() - CONFIG.RECHECK_AFTER_DAYS * 86_400_000).toISOString();

  const { data, error } = await getSupabase()
    .from('poker_clips')
    .select('id, video_id, oembed_checked_at')
    .eq('is_active', true)
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

  for (const clip of clips) {
    const answer = await askYouTube(clip.video_id);
    if (answer === 'no-answer') {
      // Leave every remaining row untouched. A blocked run must not look like
      // a run that found nothing wrong, so it says so in the result.
      blocked = true;
      break;
    }
    checked++;
    const ok = answer === 'ok';
    if (ok) stillOk++;
    else retired++;
    const { error: wErr } = await getSupabase()
      .from('poker_clips')
      .update({ oembed_ok: ok, oembed_checked_at: new Date().toISOString(), is_active: ok })
      .eq('id', clip.id);
    if (wErr) console.warn('[revalidate-poker-clips] write failed:', wErr.message);
    await delay(CONFIG.DELAY_MS);
  }

  const { count: poolSize } = await getSupabase()
    .from('poker_clips')
    .select('*', { count: 'exact', head: true })
    .eq('is_active', true);

  return c.json({
    success: true,
    timestamp: new Date().toISOString(),
    ms: Date.now() - started,
    candidates: clips.length,
    checked,
    still_ok: stillOk,
    retired,
    stopped_early_blocked: blocked,
    pool_size: poolSize ?? null,
  });
}
