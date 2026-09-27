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
import { isUninformativeTitle } from '../lib/content-engine/PostBrief.js';

const CONFIG = {
  MAX_CLIPS_PER_CHANNEL: 10,
  MAX_TOTAL_CLIPS: 100,
  REQUEST_TIMEOUT: 15000,
  REQUEST_DELAY: 1500,
  // The route already spends 57 seconds on its deliberate inter-channel
  // pacing. Keep fallback metadata inside a further 24-second worst-case
  // budget so a changed YouTube page cannot turn one run into an unbounded
  // chain of external requests.
  OEMBED_TIMEOUT: 3000,
  MAX_OEMBED_FALLBACKS_PER_RUN: 8,
} as const;

export interface SportsChannel {
  name: string;
  handle: string;
  sport: string;
  category: string;
}

export interface Clip {
  video_id: string;
  source_url: string;
  title: string;
  source: string;
  sport_type: string;
  category: string;
  channel_handle: string;
}

export interface ShortsCandidate {
  videoId: string;
  title: string | null;
}

export interface OEmbedFallbackState {
  remaining: number;
  attempted: number;
  resolved: number;
  cache: Map<string, string | null>;
}

export interface ChannelScrapeResult {
  clips: Clip[];
  rejectedMissingTitle: number;
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
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function at(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function textFrom(value: unknown): string {
  if (typeof value === 'string') return cleanText(value);
  if (!isRecord(value)) return '';
  for (const key of ['simpleText', 'content']) {
    if (typeof value[key] === 'string') return cleanText(value[key]);
  }
  if (Array.isArray(value.runs)) {
    return cleanText(value.runs
      .map((run) => isRecord(run) && typeof run.text === 'string' ? run.text : '')
      .join(''));
  }
  return textFrom(at(value, 'accessibilityData', 'label'));
}

function validVideoId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value) ? value : null;
}

function idFromShortsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return validVideoId(value.match(/(?:^|\/)shorts\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/)?.[1]);
}

function rendererVideoId(renderer: Record<string, unknown>): string | null {
  const candidates = [
    renderer.videoId,
    at(renderer, 'navigationEndpoint', 'reelWatchEndpoint', 'videoId'),
    at(renderer, 'navigationEndpoint', 'watchEndpoint', 'videoId'),
    at(renderer, 'onTap', 'innertubeCommand', 'reelWatchEndpoint', 'videoId'),
    at(renderer, 'onTap', 'innertubeCommand', 'watchEndpoint', 'videoId'),
  ];
  for (const candidate of candidates) {
    const id = validVideoId(candidate);
    if (id) return id;
  }

  const urls = [
    at(renderer, 'navigationEndpoint', 'commandMetadata', 'webCommandMetadata', 'url'),
    at(renderer, 'onTap', 'innertubeCommand', 'commandMetadata', 'webCommandMetadata', 'url'),
  ];
  for (const url of urls) {
    const id = idFromShortsUrl(url);
    if (id) return id;
  }

  if (typeof renderer.entityId === 'string') {
    return validVideoId(renderer.entityId.match(/shorts-shelf-item-([A-Za-z0-9_-]{11})$/)?.[1]);
  }
  return null;
}

function stripAccessibilitySuffix(value: string): string {
  return cleanText(value.replace(
    /,\s*(?:[\d.,]+\s*)?(?:[KMB]|thousand|million|billion)?\s*views?\s*-\s*play short\s*$/i,
    '',
  ));
}

function rendererTitle(renderer: Record<string, unknown>, modern: boolean): string | null {
  const candidates = modern
    ? [
        at(renderer, 'overlayMetadata', 'primaryText'),
        renderer.title,
        renderer.headline,
      ]
    : [
        renderer.headline,
        renderer.title,
        at(renderer, 'overlayMetadata', 'primaryText'),
      ];
  for (const candidate of candidates) {
    const title = textFrom(candidate);
    if (title) return title;
  }
  if (typeof renderer.accessibilityText === 'string') {
    return stripAccessibilitySuffix(renderer.accessibilityText) || null;
  }
  return null;
}

/**
 * Return the JSON object assigned to ytInitialData without executing page
 * JavaScript. A brace-aware scanner is used because titles may themselves
 * contain braces or escaped quotes.
 */
function assignedInitialData(html: string): unknown[] {
  const assignments = [
    /(?:^|[^A-Za-z0-9_$])(?:var\s+)?ytInitialData\s*=\s*/g,
    /window\[["']ytInitialData["']\]\s*=\s*/g,
  ];
  const starts = new Set<number>();
  for (const pattern of assignments) {
    for (const match of html.matchAll(pattern)) {
      const brace = html.indexOf('{', (match.index ?? 0) + match[0].length);
      if (brace >= 0) starts.add(brace);
    }
  }

  const parsed: unknown[] = [];
  for (const start of starts) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = start; i < html.length; i++) {
      const char = html[i]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') {
        quoted = true;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            parsed.push(JSON.parse(html.slice(start, i + 1)) as unknown);
          } catch {
            // A malformed or changed payload is not permission to guess by
            // pairing unrelated regex matches. Fail this payload closed.
          }
          break;
        }
      }
    }
  }
  return parsed;
}

/**
 * Parse only renderer-scoped Shorts metadata. The previous implementation
 * built one global video-id array and one global title array, then paired the
 * Nth members. YouTube player-menu titles live in the same HTML, so that
 * positional join corrupted thousands of rows. Here the ID and title must be
 * siblings inside one recognised renderer object.
 */
export function parseYouTubeShortsPage(html: string): ShortsCandidate[] {
  const candidates = new Map<string, ShortsCandidate>();

  const addRenderer = (value: unknown, modern: boolean) => {
    if (!isRecord(value)) return;
    const videoId = rendererVideoId(value);
    if (!videoId) return;
    const title = rendererTitle(value, modern);
    const prior = candidates.get(videoId);
    if (!prior || (!prior.title && title)) candidates.set(videoId, { videoId, title });
  };

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isRecord(value)) return;
    addRenderer(value.reelItemRenderer, false);
    addRenderer(value.shortsLockupViewModel, true);
    for (const child of Object.values(value)) visit(child);
  };

  for (const payload of assignedInitialData(html)) visit(payload);
  return [...candidates.values()];
}

export function isUsableSportsClipTitle(title: string | null | undefined, source: string): boolean {
  const cleaned = cleanText(title);
  return !!cleaned && !isUninformativeTitle(cleaned, source);
}

export function createOEmbedFallbackState(
  limit = CONFIG.MAX_OEMBED_FALLBACKS_PER_RUN,
): OEmbedFallbackState {
  return {
    remaining: Math.max(0, Math.floor(limit)),
    attempted: 0,
    resolved: 0,
    cache: new Map(),
  };
}

async function fetchOEmbedTitle(videoId: string, source: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.OEMBED_TIMEOUT);
  timeout.unref?.();
  try {
    const response = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`,
      {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      },
    );
    if (!response.ok) return null;
    const payload = await response.json() as unknown;
    if (!isRecord(payload) || payload.provider_name !== 'YouTube' || payload.type !== 'video') return null;
    const title = cleanText(typeof payload.title === 'string' ? payload.title : '');
    return isUsableSportsClipTitle(title, source) ? title : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[scrape-sports-clips] oEmbed metadata unavailable for ${videoId}: ${message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fallbackTitle(
  videoId: string,
  source: string,
  state: OEmbedFallbackState,
): Promise<string | null> {
  if (state.cache.has(videoId)) return state.cache.get(videoId) ?? null;
  if (state.remaining <= 0) return null;
  state.remaining -= 1;
  state.attempted += 1;
  const title = await fetchOEmbedTitle(videoId, source);
  state.cache.set(videoId, title);
  if (title) state.resolved += 1;
  return title;
}

export async function scrapeChannelShorts(
  channel: SportsChannel,
  fallbackState: OEmbedFallbackState,
): Promise<ChannelScrapeResult> {
  const clips: Clip[] = [];
  let rejectedMissingTitle = 0;
  const shortsUrl = `https://www.youtube.com/${channel.handle}/shorts`;
  const html = await fetchPage(shortsUrl);
  if (!html) return { clips, rejectedMissingTitle };

  const candidates = parseYouTubeShortsPage(html).slice(0, CONFIG.MAX_CLIPS_PER_CHANNEL);
  for (const candidate of candidates) {
    const videoId = candidate.videoId;
    let title = cleanText(candidate.title);
    if (!isUsableSportsClipTitle(title, channel.name)) {
      title = await fallbackTitle(videoId, channel.name, fallbackState) ?? '';
    }
    if (!isUsableSportsClipTitle(title, channel.name)) {
      rejectedMissingTitle += 1;
      continue;
    }
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

  return { clips, rejectedMissingTitle };
}

export async function saveClips(
  clips: Clip[],
): Promise<{ saved: number; skipped: number; repaired: number; failed: number }> {
  let saved = 0;
  let skipped = 0;
  let repaired = 0;
  let failed = 0;
  const supabase = getSupabase();

  if (clips.length === 0) return { saved, skipped, repaired, failed };

  const candidateUrls = [...new Set(clips.map((clip) => clip.source_url))];
  const { data: existingData, error: existingError } = await supabase
    .from('sports_clips')
    .select('source_url, title')
    .in('source_url', candidateUrls);
  if (existingError) throw new Error(`sports_clips inventory read failed: ${existingError.message}`);
  const existing = (existingData ?? []) as Array<{ source_url: string; title: string | null }>;
  const existingByUrl = new Map(existing.map((clip) => [clip.source_url, clip.title]));

  for (const clip of clips) {
    if (existingByUrl.has(clip.source_url)) {
      const existingTitle = existingByUrl.get(clip.source_url);
      if (!isUsableSportsClipTitle(existingTitle, clip.source)
        && isUsableSportsClipTitle(clip.title, clip.source)) {
        const { error } = await supabase
          .from('sports_clips')
          .update({ title: clip.title })
          .eq('source_url', clip.source_url);
        if (error) {
          failed += 1;
          console.warn('[scrape-sports-clips] title repair error:', error.message);
        } else {
          repaired += 1;
          existingByUrl.set(clip.source_url, clip.title);
        }
      } else {
        skipped += 1;
      }
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
      existingByUrl.set(clip.source_url, clip.title);
    } else if (error) {
      failed += 1;
      console.warn('[scrape-sports-clips] insert error:', error.message);
    }
  }

  return { saved, skipped, repaired, failed };
}

export async function scrapeSportsClips(c: Context) {
  try {
    const dryRun = c.req.query('dry_run') === '1';
    const allClips: Clip[] = [];
    const fallbackState = createOEmbedFallbackState();
    let rejectedMissingTitle = 0;

    for (const channel of SPORTS_CHANNELS) {
      if (allClips.length >= CONFIG.MAX_TOTAL_CLIPS) break;
      const result = await scrapeChannelShorts(channel, fallbackState);
      const remaining = CONFIG.MAX_TOTAL_CLIPS - allClips.length;
      allClips.push(...result.clips.slice(0, remaining));
      rejectedMissingTitle += result.rejectedMissingTitle;
      await delay(CONFIG.REQUEST_DELAY);
    }

    const { saved, skipped, repaired, failed } = dryRun
      ? { saved: 0, skipped: 0, repaired: 0, failed: 0 }
      : await saveClips(allClips);

    return c.json({
      success: true,
      dry_run: dryRun,
      timestamp: new Date().toISOString(),
      channels_scraped: SPORTS_CHANNELS.length,
      found: allClips.length,
      saved,
      skipped,
      repaired,
      failed,
      rejected_missing_title: rejectedMissingTitle,
      oembed_fallbacks_attempted: fallbackState.attempted,
      oembed_fallbacks_resolved: fallbackState.resolved,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[scrape-sports-clips] fatal:', msg);
    return c.json({ success: false, error: msg }, 500);
  }
}
