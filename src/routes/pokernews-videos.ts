/**
 * GET/POST /cron/pokernews-videos
 *
 * Ported from pages/api/cron/pokernews-videos.js (156 lines).
 *
 * Every 2 hours: fetch latest videos from PokerNews YouTube RSS feed,
 * dedup against social_reels.video_url, insert new rows attributed to
 * the PokerNews content_author.
 *
 * Idempotent by construction — dedup check on video_url per feed item.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import Parser from 'rss-parser';
import { getSupabase } from '../lib/supabase.js';

const POKERNEWS_CHANNEL_ID = 'UCSu1ww_wgD0XD66C1ESrIGQ';
const RSS_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${POKERNEWS_CHANNEL_ID}`;

const parser = new Parser({
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  },
});

interface Results {
  found: number;
  imported: number;
  skipped: number;
  errors: string[];
}

async function ingestLatestVideos(): Promise<Results> {
  const results: Results = { found: 0, imported: 0, skipped: 0, errors: [] };
  const supabase = getSupabase();

  let feed;
  try {
    feed = await Promise.race([
      parser.parseURL(RSS_URL),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('RSS fetch timeout (15s)')), 15000)),
    ]);
  } catch (fetchErr) {
    const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    console.warn('[pokernews-videos] RSS fetch failed (non-fatal):', msg);
    results.errors.push(`RSS fetch failed: ${msg}`);
    return results;
  }

  results.found = feed.items.length;

  // This feed is official PokerNews content. Never make an arbitrary horse
  // appear to have published it when the official author is not configured.
  const { data: author } = await supabase
    .from('content_authors')
    .select('id, profile_id')
    .ilike('name', '%PokerNews%')
    .not('profile_id', 'is', null)
    .maybeSingle();

  const authorTyped = author as { id: string; profile_id: string | null } | null;
  if (!authorTyped?.profile_id) {
    throw new Error('PokerNews content_author is not configured; refusing arbitrary attribution');
  }
  const profileId = authorTyped.profile_id;

  for (const item of feed.items) {
    const videoUrl = item.link;
    const title = item.title;
    const publishedAt = item.isoDate;

    if (!videoUrl) continue;

    const { data: existing } = await supabase
      .from('social_reels')
      .select('id')
      .eq('video_url', videoUrl)
      .maybeSingle();

    if (existing) {
      results.skipped++;
      continue;
    }

    const { error } = await supabase.from('social_reels').insert({
      video_url: videoUrl,
      caption: title,
      is_public: true,
      created_at: publishedAt,
      author_id: profileId,
    });

    if (error) {
      results.errors.push(`Failed to insert "${title}": ${error.message}`);
      console.warn('[pokernews-videos] insert error:', error.message);
    } else {
      results.imported++;
    }
  }

  return results;
}

export async function pokernewsVideos(c: Context) {
  try {
    const results = await ingestLatestVideos();
    return c.json({ success: true, timestamp: new Date().toISOString(), results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[pokernews-videos] fatal:', msg);
    return c.json({ success: false, error: msg }, 500);
  }
}
