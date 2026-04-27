// @ts-nocheck — JS-port file, runtime behavior verified against monolith JS source

/**
 * GET/POST /cron/horse/:horseIndex
 *
 * Ported from pages/api/cron/horse/[horseIndex].js (431 LOC).
 *
 * Individual horse cron — fires once per horse (0-99). 75% poker
 * content, 25% sports content. Streak prevention: if last 3 posts are
 * all the same type, force-switch.
 *
 * Auth: /cron/* middleware chain (forwarded via fauxReq for original
 * handler's auth check pattern).
 */

import { createClient } from '@supabase/supabase-js';
import Parser from 'rss-parser';
import { generatePostCaption, generateNewsCaption, seedHorseMemory } from '../lib/content-engine/HumanVoiceEngine.js';
import { getRandomClip, CLIP_LIBRARY } from '../lib/content-engine/ClipLibrary.js';

let _supabase: any = null;
function getSupabase() {
  if (!_supabase) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://kuklfnapbkmacvwxktbh.supabase.co';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    _supabase = createClient(url, key);
  }
  return _supabase;
}


/**
 * INDIVIDUAL HORSE CRON - UNIQUE VOICE + MEDIA REQUIRED
 * 
 * RULES:
 * 1. EVERY post must have VIDEO or LINK attached (no text-only)
 * 2. 100 unique voice patterns - NO repetition
 * 3. NO emojis (except 1 in 20 posts)
 * 4. BANNED phrases: yo, check out, pretty cool, wild stuff, etc.
 * 
 * Content types: video_clip OR news_link ONLY
 */




// Validate YouTube video actually exists AND is embeddable before posting
// Returns false for: removed, age-restricted, embedding-disabled, private videos
async function validateYouTubeVideo(url) {
    if (!url) return false;
    const patterns = [
        /youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/,
        /youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/,
        /youtu\.be\/([a-zA-Z0-9_-]+)/,
        /youtube\.com\/embed\/([a-zA-Z0-9_-]+)/
    ];
    let videoId = null;
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) { videoId = match[1]; break; }
    }
    if (!videoId) return false;

    try {
        const response = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
        if (!response.ok) {
            // 401 = age-restricted, 403 = embedding disabled, 404 = not found
            return false;
        }
        // Parse the response body - embeddable videos MUST have an 'html' field with an iframe
        const body = await response.json();
        if (!body.html || !body.html.includes('iframe')) {
            return false;
        }
        return true;
    } catch {
        return false;
    }
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const rssParser = new Parser({
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    timeout: 8000
});

const POKER_NEWS_SOURCES = [
    { name: 'CardPlayer', rss: 'https://www.cardplayer.com/poker-news.rss' },
    { name: 'Upswing Poker', rss: 'https://upswingpoker.com/feed/' },
];

const SPORTS_NEWS_SOURCES = [
    { name: 'ESPN', rss: 'https://www.espn.com/espn/rss/news' },
    { name: 'ESPN NBA', rss: 'https://www.espn.com/espn/rss/nba/news' },
    { name: 'ESPN NFL', rss: 'https://www.espn.com/espn/rss/nfl/news' },
    { name: 'CBS Sports', rss: 'https://www.cbssports.com/rss/headlines/' },
];

async function getHorseSources(profileId) {
    const { data: sportsSources } = await getSupabase().from('sports_clips').select('source').limit(1000);
    const allSources = new Set();
    (sportsSources || []).forEach(s => s.source && allSources.add(s.source));
    const sourceList = [...allSources];
    if (sourceList.length === 0) return [];
    const hash = profileId.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const numSources = Math.max(10, Math.floor(sourceList.length / 100));
    const assigned = [];
    for (let i = 0; i < numSources; i++) {
        assigned.push(sourceList[(hash + i * 7) % sourceList.length]);
    }
    return assigned;
}

function convertToEmbedUrl(url) {
    if (!url) return url;
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
        /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    ];
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return `https://www.youtube.com/embed/${match[1]}`;
    }
    return url;
}

// POST VIDEO CLIP (with unique voice + GLOBAL DEDUPLICATION + POKER/SPORTS SUPPORT)
async function postVideoClip(horse, assignedSources, horseIndex, clipType = 'sports') {

    let clips = [];
    let clip = null;

    if (clipType === 'poker') {
        // Use ClipLibrary for poker clips
        if (typeof getRandomClip !== 'function') {
            console.warn(`   getRandomClip not available for poker clips`);
            return { success: false, error: 'ClipLibrary not available' };
        }

    // PERF: Build usedUrls ONCE before the loop (avoids re-querying up to 20x per horse)
        const since48h_poker = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
        const { data: recentPokerVideos } = await getSupabase()
            .from('social_posts')
            .select('media_urls')
            .eq('content_type', 'video')
            .gte('created_at', since48h_poker)
            .limit(100);
        const pokerUsedUrls = new Set();
        (recentPokerVideos || []).forEach(p => {
            if (p.media_urls) p.media_urls.forEach(url => pokerUsedUrls.add(url));
        });

        const maxAttempts = 20;
        for (let i = 0; i < maxAttempts; i++) {
            const candidate = getRandomClip();
            if (!candidate) continue;

            const videoId = candidate.video_id || candidate.id;
            const embedUrl = convertToEmbedUrl(candidate.source_url);

            if (!pokerUsedUrls.has(embedUrl) && !pokerUsedUrls.has(candidate.source_url)) {
                // VALIDATE: Check if video actually exists on YouTube
                const isValid = await validateYouTubeVideo(candidate.source_url);
                if (isValid) {
                    clip = candidate;
                    break;
                }
            }
        }

        if (!clip) {
            return { success: false, error: 'All poker clips already posted' };
        }

    } else {
        // Use sports_clips table for sports clips
        if (assignedSources.length > 0) {
            const { data } = await getSupabase().from('sports_clips').select('*').in('source', assignedSources).limit(200);
            if (data?.length) clips = data;
        }
        if (!clips.length) {
            const offset = Math.floor(Math.random() * 5000);
            const { data } = await getSupabase().from('sports_clips').select('*').range(offset, offset + 200);
            if (data?.length) clips = data;
        }
        if (!clips.length) return { success: false, error: 'No sports clips' };

        // GLOBAL DEDUPLICATION: Check which video URLs were already posted (last 48h)
        const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
        const { data: recentVideos } = await getSupabase()
            .from('social_posts')
            .select('media_urls')
            .eq('content_type', 'video')
            .gte('created_at', since48h)
                .limit(100);

        const usedUrls = new Set();
        (recentVideos || []).forEach(p => {
            if (p.media_urls) p.media_urls.forEach(url => usedUrls.add(url));
        });

        // Filter out already-posted clips
        const freshClips = clips.filter(c => {
            const embedUrl = convertToEmbedUrl(c.source_url);
            return !usedUrls.has(embedUrl) && !usedUrls.has(c.source_url);
        });

        if (!freshClips.length) {
            return { success: false, error: 'All sports clips already posted' };
        }

        // Pick random from FRESH clips only, with validation
        const maxValidationAttempts = 10;
        for (let i = 0; i < maxValidationAttempts && freshClips.length > 0; i++) {
            const idx = Math.floor(Math.random() * freshClips.length);
            const candidate = freshClips[idx];
            const isValid = await validateYouTubeVideo(candidate.source_url);
            if (isValid) {
                clip = candidate;
                break;
            } else {
                freshClips.splice(idx, 1); // Remove invalid clip from candidates
            }
        }

        if (!clip) {
            return { success: false, error: 'No valid sports clips found' };
        }
    }

    // Seed horse memory from recent posts (prevents cross-session repeats)
    const { data: recentCaptions } = await getSupabase()
        .from('social_posts')
        .select('content')
        .eq('author_id', horse.profile_id)
        .order('created_at', { ascending: false })
        .limit(15);
    if (recentCaptions?.length) {
        seedHorseMemory(horse.profile_id, recentCaptions.map(p => p.content?.split('\n')[0] || ''));
    }

    // Generate human-sounding caption — no API call, no cost
    const clipCategory = clip.category || (clipType === 'poker' ? 'massive_pot' : 'sports_highlight');
    const caption = generatePostCaption(clipCategory, horse.profile_id, clip.title || '');

    const { data: post, error } = await getSupabase().from('social_posts').insert({
        author_id: horse.profile_id,
        content: caption,
        content_type: 'video',
        media_urls: [convertToEmbedUrl(clip.source_url)],
        visibility: 'public',
        metadata: {
            clip_type: clipType,
            clip_id: clip.id || clip.video_id
        }
    }).select().maybeSingle();

    if (error) return { success: false, error: error.message };
    return { success: true, postId: post.id, type: `${clipType}_video`, caption: caption.slice(0, 50) };
}

// POST NEWS LINK (with unique voice + GLOBAL DEDUPLICATION)
async function postNewsLink(horse, horseIndex, newsType) {

    const sources = newsType === 'poker' ? POKER_NEWS_SOURCES : SPORTS_NEWS_SOURCES;
    const sourceIndex = horseIndex % sources.length;
    const source = sources[sourceIndex];

    try {
        const feed = await rssParser.parseURL(source.rss);
        const allArticles = (feed.items || []).slice(0, 20);
        if (!allArticles.length) return { success: false, error: 'No articles' };

        // GLOBAL DEDUPLICATION: Check which links were already posted (last 48h)
        const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
        const { data: recentPosts } = await getSupabase()
            .from('social_posts')
            .select('link_url')
            .not('link_url', 'is', null)
            .gte('created_at', since48h)
                .limit(100);

        const usedLinks = new Set((recentPosts || []).map(p => p.link_url));

        // Filter out already-posted articles
        const freshArticles = allArticles.filter(a => !usedLinks.has(a.link))
            .slice(0, 100);

        if (!freshArticles.length) {
            return { success: false, error: 'All articles already posted' };
        }

        // Pick random from FRESH articles only
        const article = freshArticles[Math.floor(Math.random() * freshArticles.length)];
        // Seed horse memory from recent posts (prevents cross-session repeats)
        const { data: recentNewsCaptions } = await getSupabase()
            .from('social_posts')
            .select('content')
            .eq('author_id', horse.profile_id)
            .order('created_at', { ascending: false })
            .limit(15);
        if (recentNewsCaptions?.length) {
            seedHorseMemory(horse.profile_id, recentNewsCaptions.map(p => p.content?.split('\n')[0] || ''));
        }

        // Generate human-sounding caption — no API call, no cost
        const caption = generateNewsCaption(article.title || '', horse.profile_id, newsType);
        const postContent = `${caption}\n\n${article.link}`;

        const { data: post, error } = await getSupabase().from('social_posts').insert({
            author_id: horse.profile_id,
            content: postContent,
            content_type: 'link',
            visibility: 'public',
            link_url: article.link,
            link_title: article.title,
            link_site_name: source.name,
            metadata: { news_type: newsType }  // Stored for streak prevention
        }).select().maybeSingle();

        if (error) return { success: false, error: error.message };
        return { success: true, postId: post.id, type: newsType + '_news', title: article.title?.slice(0, 40) };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// MAIN HANDLER - VIDEO or NEWS LINK only (no text-only posts)
async function pagesHandler(req: any, res: any) {
  try {
      // Verify cron secret
      if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
          return res.status(401).json({ error: 'Unauthorized' });
      }
      const { horseIndex } = req.query;
      const index = parseInt(horseIndex, 10);

      if (isNaN(index) || index < 0 || index > 99) {
          return res.status(400).json({ error: 'horseIndex must be 0-99' });
      }

      try {

          // Load ClipLibrary for poker video clips
          
          const { data: horses, error: horseError } = await getSupabase()
              .from('content_authors')
              .select('*')
              .eq('is_active', true)
              .not('profile_id', 'is', null)
              .order('profile_id')
                  .limit(100);

          if (horseError || !horses?.length || index >= horses.length) {
              return res.status(200).json({ success: false, error: 'No horse' });
          }

          const horse = horses[index];

          // STREAK PREVENTION: Check last 3 posts — if all same type, force-switch
          // Pure random 75/25 can produce 10-20 consecutive poker posts; this caps it at 3.
          let isPoker = Math.random() < 0.75;
          try {
            const { data: lastPosts } = await getSupabase()
              .from('social_posts')
              .select('metadata')
              .eq('author_id', horse.profile_id)
              .order('created_at', { ascending: false })
              .limit(3);

            if (lastPosts && lastPosts.length >= 3) {
              const recentTypes = lastPosts
                .map(p => {
                  // clip_type is set on video posts, news_type is set on link posts
                  const t = p.metadata?.clip_type || p.metadata?.news_type;
                  // Normalize to 'poker' or 'sports'
                  if (t === 'poker' || t === 'sports') return t;
                  return null;
                })
                .filter(Boolean);
              const allPoker = recentTypes.length >= 3 && recentTypes.every(t => t === 'poker');
              const allSports = recentTypes.length >= 3 && recentTypes.every(t => t === 'sports');
              if (allPoker) { isPoker = false; /* force sports break */ }
              else if (allSports) { isPoker = true; /* force poker break */ }
            }
          } catch (_streakErr) {
            // Streak check is best-effort — never fail the cron over this
          }

          const contentCategory = isPoker ? 'poker' : 'sports';

          const assignedSources = await getHorseSources(horse.profile_id);

          // Try news first, fallback to video clip of SAME CATEGORY
          let result;
          if (isPoker) {
              // POKER HOUR: Try poker news, fallback to poker video
              result = await postNewsLink(horse, index, 'poker');
              if (!result.success) {
                  result = await postVideoClip(horse, assignedSources, index, 'poker');
              }
          } else {
              // SPORTS HOUR: Try sports news, fallback to sports video
              result = await postNewsLink(horse, index, 'sports');
              if (!result.success) {
                  result = await postVideoClip(horse, assignedSources, index, 'sports');
              }
          }


          return res.status(200).json({
              success: result.success,
              horse: horse.name,
              horseIndex: index,
              contentCategory,
              ...result
          });

      } catch (error) {
          console.warn('Horse cron error:', error);
          return res.status(500).json({ success: false, error: error.message });
      }

  } catch (err) {
      try { console.warn('[horse-by-index] cron error:', err?.message || err); } catch (_) {}
    console.warn('[API Error]', err);
    if (!res.headersSent) return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
}


// ─── Hono adapters ───────────────────────────────────────────────────────
import type { Context } from 'hono';

/** Single-horse handler: GET /cron/horse/:horseIndex */
export async function horseByIndex(c: Context) {
  const horseIndex = c.req.param('horseIndex');
  let statusCode = 200;
  let payload: unknown = null;
  const fauxReq = {
    method: c.req.method,
    headers: {
      authorization: c.req.header('authorization') ?? '',
      'x-cron-secret': c.req.header('x-cron-secret') ?? '',
    },
    query: { horseIndex },
  };
  const fauxRes = {
    status(code: number) { statusCode = code; return fauxRes; },
    json(body: unknown) { payload = body; return fauxRes; },
    setHeader() {},
    headersSent: false,
  };
  await pagesHandler(fauxReq, fauxRes);
  return c.json(payload as any, statusCode as any);
}

/**
 * Batch handler: GET /cron/horse-batch/:horseIndex
 *
 * Each batch covers 10 horses (matching the original monolith logic):
 *   batchIndex 0 → horses 0-9
 *   batchIndex 1 → horses 10-19
 *   ...
 *   batchIndex 9 → horses 90-99
 *
 * The old single-horse passthrough (horseIndex === batchIndex) was a
 * regression: only 1 of 10 horses per batch was posting. This restores
 * the 10x throughput of the original [batchIndex].js handler.
 */
export async function horseBatch(c: Context) {
  const batchParam = c.req.param('horseIndex'); // route param name matches registered route
  const batch = parseInt(batchParam ?? '', 10);

  if (isNaN(batch) || batch < 0 || batch > 9) {
    return c.json({ error: 'batchIndex must be 0-9' }, 400);
  }

  const startIndex = batch * 10;
  const endIndex = startIndex + 9;
  const results: unknown[] = [];

  try {
    // Fetch all horses once for the batch
    const { data: horses, error: horseError } = await getSupabase()
      .from('content_authors')
      .select('*')
      .eq('is_active', true)
      .not('profile_id', 'is', null)
      .order('profile_id')
      .limit(100);

    if (horseError || !horses?.length) {
      return c.json({ success: false, error: 'No horses found' });
    }

    // Process each horse in the batch sequentially with a small delay
    for (let i = startIndex; i <= endIndex && i < horses.length; i++) {
      const horse = horses[i];
      if (!horse) continue;

      try {
        let statusCode = 200;
        let payload: unknown = null;
        const fauxReq = {
          method: c.req.method,
          headers: {
            authorization: c.req.header('authorization') ?? '',
            'x-cron-secret': c.req.header('x-cron-secret') ?? '',
          },
          // Override horses fetch in pagesHandler: pass exact horseIndex
          query: { horseIndex: String(i) },
        };
        const fauxRes = {
          status(code: number) { statusCode = code; return fauxRes; },
          json(body: unknown) { payload = body; return fauxRes; },
          setHeader() {},
          headersSent: false,
        };
        await pagesHandler(fauxReq, fauxRes);
        results.push(payload);
      } catch (err: any) {
        console.warn(`[horse-batch/${batch}] horse ${i} error:`, err?.message || err);
        results.push({ horse: horse?.name, index: i, success: false, error: err?.message });
      }

      // Small delay between horses to avoid DB + YouTube API rate limits
      await new Promise((r) => setTimeout(r, 500));
    }

    const successCount = results.filter((r: any) => r?.success).length;
    return c.json({
      success: true,
      batch,
      horsesRange: `${startIndex}-${endIndex}`,
      processed: results.length,
      succeeded: successCount,
      failed: results.length - successCount,
      results,
    });
  } catch (err: any) {
    console.warn(`[horse-batch/${batch}] fatal:`, err?.message || err);
    return c.json({ success: false, error: err?.message }, 500);
  }
}
