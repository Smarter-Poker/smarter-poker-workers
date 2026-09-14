/**
 * GET/POST /cron/pokernews-videos
 *
 * Ported from pages/api/cron/pokernews-videos.js (156 lines).
 *
 * Every 3 hours: fetch latest videos from PokerNews YouTube RSS feed,
 * dedup against social_reels.video_url, insert new rows attributed to
 * the PokerNews content_author.
 *
 * Checks existing video URLs before inserting. A failed lookup is unknown,
 * never permission to insert. Any failed item makes the run a partial failure.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import Parser from 'rss-parser';
import { getSupabase } from '../lib/supabase.js';
import { withDeadline } from '../lib/withDeadline.js';

const POKERNEWS_CHANNEL_ID = 'UCSu1ww_wgD0XD66C1ESrIGQ';
const RSS_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${POKERNEWS_CHANNEL_ID}`;

const parser = new Parser({
  timeout: 15000,
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
    feed = await withDeadline(parser.parseURL(RSS_URL), 15000, 'PokerNews RSS fetch');
  } catch (fetchErr) {
    const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    console.warn('[pokernews-videos] RSS fetch failed:', msg);
    results.errors.push(`RSS fetch failed: ${msg}`);
    return results;
  }

  results.found = feed.items.length;

  // This feed is official PokerNews content. Never make an arbitrary horse
  // appear to have published it when the official author is not configured.
  const { data: author, error: authorError } = await supabase
    .from('content_authors')
    .select('id, profile_id')
    .ilike('name', '%PokerNews%')
    .not('profile_id', 'is', null)
    .maybeSingle();

  if (authorError) throw new Error(`PokerNews author lookup failed: ${authorError.message}`);

  const authorTyped = author as { id: string; profile_id: string | null } | null;
  if (!authorTyped?.profile_id) {
    throw new Error('PokerNews content_author is not configured; refusing arbitrary attribution');
  }
  const profileId = authorTyped.profile_id;

  for (const item of feed.items) {
    const videoUrl = item.link;
    const title = item.title;
    const publishedAt = item.isoDate;

    if (!videoUrl) {
      results.errors.push('Feed item has no video URL');
      continue;
    }

    const { data: existing, error: lookupError } = await supabase
      .from('social_reels')
      .select('id')
      .eq('video_url', videoUrl)
      .maybeSingle();

    if (lookupError) {
      results.errors.push(`Video lookup failed: ${lookupError.message}`);
      continue;
    }

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
    const success = results.errors.length === 0;
    // The common cron middleware records HTTP failures as failed runs. A
    // failed feed or partial import must never refresh its last-success time.
    return c.json({ success, timestamp: new Date().toISOString(), results }, success ? 200 : 503);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[pokernews-videos] fatal:', msg);
    return c.json({ success: false, error: msg }, 500);
  }
}
