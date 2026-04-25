/**
 * GET/POST /cron/scrape-sports-clips
 *
 * Ported from pages/api/cron/scrape-sports-clips.js (247 lines).
 *
 * Scrapes sports YouTube Shorts (NBA/NFL/MLB/NHL/Soccer) from a curated
 * list of 38 channels and inserts clips into sports_clips. Polite scraping
 * via 1.5s delay between channels. Caps at MAX_TOTAL_CLIPS=100 per run.
 *
 * Idempotence: existing-URL set lookup prevents duplicate inserts. Running
 * twice in a row inserts at most a handful of newly-published shorts the
 * second time (channels publish slowly relative to cron cadence).
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const CONFIG = {
  MAX_CLIPS_PER_CHANNEL: 10,
  MAX_TOTAL_CLIPS: 100,
  REQUEST_TIMEOUT: 15000,
  REQUEST_DELAY: 1500,
} as const;

interface SportsChannel {
  name: string;
  handle: string;
  sport: string;
  category: string;
}

interface Clip {
  video_id: string;
  source_url: string;
  title: string;
  source: string;
  sport_type: string;
  category: string;
  channel_handle: string;
}

const SPORTS_CHANNELS: SportsChannel[] = [
  // NBA (10)
  { name: 'ESPN NBA', handle: '@ESPN', sport: 'nba', category: 'highlight' },
  { name: 'NBA', handle: '@NBA', sport: 'nba', category: 'highlight' },
  { name: 'House of Highlights', handle: '@HouseofHighlights', sport: 'nba', category: 'dunk' },
  { name: 'Bleacher Report NBA', handle: '@BleacherReport', sport: 'nba', category: 'highlight' },
  { name: 'NBA on TNT', handle: '@NBAonTNT', sport: 'nba', category: 'analysis' },
  { name: 'Lakers', handle: '@Lakers', sport: 'nba', category: 'highlight' },
  { name: 'Warriors', handle: '@Warriors', sport: 'nba', category: 'highlight' },
  { name: 'Celtics', handle: '@Celtics', sport: 'nba', category: 'highlight' },
  { name: 'Heat', handle: '@MiamiHeat', sport: 'nba', category: 'highlight' },
  { name: 'Bucks', handle: '@Bucks', sport: 'nba', category: 'highlight' },
  // NFL (10)
  { name: 'ESPN NFL', handle: '@ESPN', sport: 'nfl', category: 'highlight' },
  { name: 'NFL', handle: '@NFL', sport: 'nfl', category: 'touchdown' },
  { name: 'NFL Films', handle: '@NFLFilms', sport: 'nfl', category: 'highlight' },
  { name: 'Chiefs', handle: '@Chiefs', sport: 'nfl', category: 'touchdown' },
  { name: 'Cowboys', handle: '@DallasCowboys', sport: 'nfl', category: 'touchdown' },
  { name: 'Eagles', handle: '@Eagles', sport: 'nfl', category: 'touchdown' },
  { name: '49ers', handle: '@49ers', sport: 'nfl', category: 'touchdown' },
  { name: 'Bills', handle: '@BuffaloBills', sport: 'nfl', category: 'touchdown' },
  { name: 'Ravens', handle: '@Ravens', sport: 'nfl', category: 'touchdown' },
  { name: 'Packers', handle: '@packers', sport: 'nfl', category: 'touchdown' },
  // MLB (5)
  { name: 'ESPN MLB', handle: '@ESPN', sport: 'mlb', category: 'highlight' },
  { name: 'MLB', handle: '@MLB', sport: 'mlb', category: 'highlight' },
  { name: 'Yankees', handle: '@Yankees', sport: 'mlb', category: 'highlight' },
  { name: 'Dodgers', handle: '@Dodgers', sport: 'mlb', category: 'highlight' },
  { name: 'Red Sox', handle: '@RedSox', sport: 'mlb', category: 'highlight' },
  // NHL (5)
  { name: 'ESPN NHL', handle: '@ESPN', sport: 'nhl', category: 'goal' },
  { name: 'NHL', handle: '@NHL', sport: 'nhl', category: 'goal' },
  { name: 'Bruins', handle: '@NHLBruins', sport: 'nhl', category: 'goal' },
  { name: 'Maple Leafs', handle: '@MapleLeafs', sport: 'nhl', category: 'goal' },
  { name: 'Rangers', handle: '@NYRangers', sport: 'nhl', category: 'goal' },
  // Soccer (5)
  { name: 'ESPN FC', handle: '@ESPNFC', sport: 'soccer', category: 'goal' },
  { name: 'UEFA', handle: '@UEFA', sport: 'soccer', category: 'goal' },
  { name: 'Premier League', handle: '@PremierLeague', sport: 'soccer', category: 'goal' },
  { name: 'LaLiga', handle: '@LaLiga', sport: 'soccer', category: 'goal' },
  { name: 'MLS', handle: '@MLS', sport: 'soccer', category: 'goal' },
  // General Sports (3)
  { name: 'SportsCenter', handle: '@SportsCenter', sport: 'general', category: 'highlight' },
  { name: 'FOX Sports', handle: '@FOXSports', sport: 'general', category: 'highlight' },
  { name: 'CBS Sports', handle: '@CBSSports', sport: 'general', category: 'highlight' },
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    return await response.text();
  } catch (error) {
    clearTimeout(timeout);
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[scrape-sports-clips] failed to fetch ${url}: ${msg}`);
    return null;
  }
}

function cleanText(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/\\u0026/g, '&')
    .replace(/\\u003c/g, '<')
    .replace(/\\u003e/g, '>')
    .replace(/\\"/g, '"')
    .replace(/\\/g, '')
    .replace(/\n/g, ' ')
    .trim();
}

async function scrapeChannelShorts(channel: SportsChannel): Promise<Clip[]> {
  const clips: Clip[] = [];
  const shortsUrl = `https://www.youtube.com/${channel.handle}/shorts`;
  const html = await fetchPage(shortsUrl);
  if (!html) return clips;

  const shortIdPattern = /\/shorts\/([a-zA-Z0-9_-]{11})/g;
  const matches = [...html.matchAll(shortIdPattern)];
  const uniqueIds = [...new Set(matches.map((m) => m[1]).filter((id): id is string => !!id))];

  const titlePattern = /"title":\s*\{"runs":\s*\[\{"text":\s*"([^"]+)"\}\]/g;
  const titles = [...html.matchAll(titlePattern)]
    .map((m) => cleanText(m[1]))
    .filter((t) => t.length > 0);

  for (let i = 0; i < Math.min(uniqueIds.length, CONFIG.MAX_CLIPS_PER_CHANNEL); i++) {
    const videoId = uniqueIds[i];
    if (!videoId) continue;
    const title = titles[i] ?? `${channel.name} ${channel.sport.toUpperCase()} Clip`;
    clips.push({
      video_id: videoId,
      source_url: `https://www.youtube.com/shorts/${videoId}`,
      title: title.substring(0, 200),
      source: channel.name,
      sport_type: channel.sport,
      category: channel.category,
      channel_handle: channel.handle,
    });
  }

  return clips;
}

async function saveClips(clips: Clip[]): Promise<{ saved: number; skipped: number }> {
  let saved = 0;
  let skipped = 0;
  const supabase = getSupabase();

  const { data: existingData } = await supabase.from('sports_clips').select('source_url');
  const existing = (existingData ?? []) as Array<{ source_url: string }>;
  const existingUrls = new Set(existing.map((c) => c.source_url));

  for (const clip of clips) {
    if (existingUrls.has(clip.source_url)) {
      skipped++;
      continue;
    }
    const { data, error } = await supabase
      .from('sports_clips')
      .insert({
        video_id: clip.video_id,
        source_url: clip.source_url,
        title: clip.title,
        source: clip.source,
        sport_type: clip.sport_type,
        category: clip.category,
        channel_handle: clip.channel_handle,
      })
      .select()
      .maybeSingle();

    if (data && !error) {
      saved++;
      existingUrls.add(clip.source_url);
    } else if (error) {
      console.warn('[scrape-sports-clips] insert error:', error.message);
    }
  }

  return { saved, skipped };
}

export async function scrapeSportsClips(c: Context) {
  try {
    const allClips: Clip[] = [];

    for (const channel of SPORTS_CHANNELS) {
      if (allClips.length >= CONFIG.MAX_TOTAL_CLIPS) break;
      const clips = await scrapeChannelShorts(channel);
      allClips.push(...clips);
      await delay(CONFIG.REQUEST_DELAY);
    }

    const { saved, skipped } = await saveClips(allClips);

    return c.json({
      success: true,
      timestamp: new Date().toISOString(),
      channels_scraped: SPORTS_CHANNELS.length,
      found: allClips.length,
      saved,
      skipped,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[scrape-sports-clips] fatal:', msg);
    return c.json({ success: false, error: msg }, 500);
  }
}
