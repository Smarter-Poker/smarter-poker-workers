/**
 * GET/POST /cron/scrape-poker-clips
 *
 * Keeps `poker_clips` renewing, the way `sports_clips` already does. Phase 4
 * of the fleet content programme; the numbers that forced it are in
 * ClipSupply.ts.
 *
 * WHY RSS AND NOT THE PAGE HTML. The sports scraper this is modelled on
 * fetches `youtube.com/@handle/shorts` and regexes the HTML, pairing the Nth
 * video id with the Nth title string it finds. That pairing is positional and
 * nothing guarantees the two lists correspond - which is exactly where
 * "Bleacher Report NBA NBA Clip" came from, the fallback title used when the
 * title list runs short, and how a brief ended up naming "Keyboard" as a
 * person. YouTube publishes a real Atom feed per channel:
 *
 *   https://www.youtube.com/feeds/videos.xml?channel_id=UC...
 *
 * No API key, no quota, correct titles, real publish dates, and each entry
 * carries its own id so a title can never be attached to the wrong video.
 * `content-health-check` has been reading one of these for the PokerNews
 * channel since Phase 2, so this is the platform's own proven pattern.
 *
 * THE HANDLE PROBLEM. The feed is keyed on `UC...` and people write
 * `@HustlerCasinoLive`. Resolving one to the other is a page fetch, so it is
 * done ONCE per source and cached in `content_sources.channel_id`. A source
 * whose handle cannot be resolved has its failure counted, and is deactivated
 * after DEACTIVATE_AFTER consecutive failures - so a registry seeded
 * generously converges on what is really there, and says which rows died in a
 * column rather than failing silently every hour.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { pokerChannelIndex } from '../lib/content-engine/ClipSupply.js';

const CONFIG = {
  MAX_SOURCES_PER_RUN: 25,
  MAX_CLIPS_PER_SOURCE: 15,
  REQUEST_TIMEOUT_MS: 12_000,
  REQUEST_DELAY_MS: 900,
  /** A source is retired after this many consecutive empty or failed runs. */
  DEACTIVATE_AFTER: 6,
  /**
   * A channel whose newest upload is older than this is dormant, not a
   * source. The first production run found Stones Gambling Hall last
   * uploading in 2018, Poker Night in America in 2013 and the Asian Poker
   * Tour in 2008 - all answering perfectly well, all returning a feed of
   * genuinely old videos. A supply that renews with 2008 uploads has not
   * renewed; it has just moved the frozen list into a table. Their clips are
   * real and are kept, but we stop asking them every day.
   */
  DORMANT_AFTER_DAYS: 540,
} as const;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

interface SourceRow {
  id: string;
  name: string;
  handle: string | null;
  channel_id: string | null;
  category: string | null;
  consecutive_failures: number;
}

interface FoundClip {
  video_id: string;
  title: string;
  published_at: string | null;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A page fetch that distinguishes "not there" from "not answered".
 *
 * YouTube answers a burst of channel-page requests with a ~755-byte throttle
 * page: HTTP 200, no channel data, indistinguishable from a 404 if you only
 * look at whether you got a string back. Measured 2026-09-06 while checking
 * the registry: after roughly sixty rapid requests EVERY handle came back
 * "missing", including @LiveattheBike and @PhilHellmuth, which plainly exist -
 * the same three that had resolved fine minutes earlier.
 *
 * Reading that as "the channel is gone" would have retired most of the
 * registry in six runs. It is exactly the mistake revalidate-poker-clips is
 * written to avoid on the clip side ("a 429 or 403 is never read as dead"),
 * arriving at the source level instead.
 */
const THROTTLE_PAGE_BYTES = 5_000;

async function fetchText(url: string): Promise<{ body: string | null; throttled: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': UA } });
    clearTimeout(timer);
    if (res.status === 429 || res.status >= 500) return { body: null, throttled: true };
    if (!res.ok) return { body: null, throttled: false };
    const body = await res.text();
    // A 200 this small is the throttle page, not a channel.
    if (body.length < THROTTLE_PAGE_BYTES) return { body: null, throttled: true };
    return { body, throttled: false };
  } catch {
    clearTimeout(timer);
    // A timeout or a dropped connection is not evidence about the channel.
    return { body: null, throttled: true };
  }
}

/**
 * Resolve @handle to the UC... channel id, once. Both shapes appear in the
 * channel page; either is fine and the first hit wins.
 */
export async function resolveChannelId(
  handle: string,
): Promise<{ channelId: string | null; throttled: boolean }> {
  const { body: html, throttled } = await fetchText(`https://www.youtube.com/${handle}`);
  if (!html) return { channelId: null, throttled };
  // og:url first: it is the page's own canonical statement of which channel
  // this is, and it survives the layout changes that move the JSON blobs
  // around. Measured 2026-09-06 on @JonathanLittle - a real channel whose
  // page carried no "channelId" key at all, so a resolver checking only that
  // would have called it missing and retired it after six runs.
  const m =
    html.match(/og:url"\s+content="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/) ??
    html.match(/"channelId":"(UC[A-Za-z0-9_-]{22})"/) ??
    html.match(/"externalId":"(UC[A-Za-z0-9_-]{22})"/) ??
    html.match(/channel\/(UC[A-Za-z0-9_-]{22})/);
  return { channelId: m?.[1] ?? null, throttled: false };
}

/**
 * Parse a YouTube channel Atom feed.
 *
 * Deliberately entry-by-entry rather than two independent regexes over the
 * whole document: the id and the title must come from the SAME <entry> or we
 * reproduce the positional-pairing bug this route exists to avoid.
 */
export function parseChannelFeed(xml: string, max: number): FoundClip[] {
  const out: FoundClip[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    if (out.length >= max) break;
    const entry = m[1]!;
    const id = entry.match(/<yt:videoId>([A-Za-z0-9_-]{11})<\/yt:videoId>/)?.[1];
    if (!id) continue;
    const rawTitle = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '';
    const title = decodeEntities(rawTitle).trim();
    if (!title) continue;
    const published = entry.match(/<published>([^<]+)<\/published>/)?.[1] ?? null;
    out.push({ video_id: id, title: title.slice(0, 200), published_at: published });
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/**
 * Sources to scrape this run: least recently scraped first, so the whole
 * registry is walked over a day rather than the first 25 rows every hour.
 */
async function dueSources(): Promise<SourceRow[]> {
  const { data, error } = await getSupabase()
    .from('content_sources')
    .select('id, name, handle, channel_id, category, consecutive_failures')
    .eq('domain', 'poker')
    .eq('is_active', true)
    .order('last_scraped_at', { ascending: true, nullsFirst: true })
    .limit(CONFIG.MAX_SOURCES_PER_RUN);
  if (error) {
    console.warn('[scrape-poker-clips] source read failed:', error.message);
    return [];
  }
  return (data ?? []) as SourceRow[];
}

async function markSource(
  source: SourceRow,
  found: number,
  channelId: string | null,
  newestPublished?: string | null,
  throttled = false,
): Promise<void> {
  const now = new Date().toISOString();
  // A run we were throttled out of says nothing about the channel. Recording
  // it as a failure is how a rate limit retires a registry.
  const failed = found === 0 && !throttled;
  const failures = failed ? source.consecutive_failures + 1 : source.consecutive_failures;
  const patch: Record<string, unknown> = {
    last_scraped_at: now,
    consecutive_failures: failures,
    clips_found: found,
    updated_at: now,
  };
  if (channelId && channelId !== source.channel_id) patch.channel_id = channelId;
  if (!failed) patch.last_ok_at = now;
  // A handle nobody can resolve, or a channel that has published nothing we
  // can read six runs running, is retired rather than retried forever. The
  // row stays, with the count that retired it, so the registry can be read.
  if (failures >= CONFIG.DEACTIVATE_AFTER) patch.is_active = false;
  // Answering with nothing recent is its own kind of dead.
  if (newestPublished) {
    const ageDays = (Date.now() - Date.parse(newestPublished)) / 86_400_000;
    if (Number.isFinite(ageDays) && ageDays > CONFIG.DORMANT_AFTER_DAYS) {
      patch.is_active = false;
      console.warn(
        `[scrape-poker-clips] ${source.name} dormant: newest upload ${Math.round(ageDays)} days old`,
      );
    }
  }

  const { error } = await getSupabase().from('content_sources').update(patch).eq('id', source.id);
  if (error) console.warn('[scrape-poker-clips] source update failed:', error.message);
}

/**
 * Harvest the video library we already maintain.
 *
 * `video_library_videos` holds 1,773 poker videos, scraped continuously and
 * updated today. 896 of them come from channels already in this registry and
 * had never reached a horse - the fleet was scraping YouTube for videos that
 * were sitting in our own database. Nobody built the join, so nobody noticed.
 *
 * ONLY registered POKER channels are imported. The library also carries slots
 * content - Brian Christopher Slots, Lady Luck HQ, The Big Jackpot, 370 videos
 * between them - and a slots pull in a poker horse's feed is exactly the kind
 * of off-key content this phase exists to stop. Matching on the registry is
 * what keeps that line, and it is the registry's job: a source is poker
 * because a row says so.
 */
export async function importFromVideoLibrary(): Promise<{ found: number; saved: number }> {
  const supa = getSupabase();

  // Names AND aliases: the library says "WSOP" where the registry says "World
  // Series of Poker", and 172 videos sat behind that spelling.
  const { byName, rawNames } = await pokerChannelIndex();
  if (!byName.size) return { found: 0, saved: 0 };

  // Filtered in the query for the same reason the reels bridge is: the
  // library's slots channels publish daily and would otherwise fill any
  // "newest N" window before a poker video appeared in it.
  const { data: videos, error: vErr } = await supa
    .from('video_library_videos')
    .select('youtube_video_id, video_url, title, source_name, published_at, thumbnail_url')
    .not('youtube_video_id', 'is', null)
    .in('source_name', rawNames)
    .order('published_at', { ascending: false, nullsFirst: false })
    .limit(1500);
  if (vErr) {
    console.warn('[scrape-poker-clips] video library read failed:', vErr.message);
    return { found: 0, saved: 0 };
  }

  const rows: Record<string, unknown>[] = [];
  for (const v of (videos ?? []) as Array<Record<string, string | null>>) {
    const src = v.source_name ? byName.get(v.source_name.toLowerCase()) : undefined;
    if (!src || !v.youtube_video_id || !v.title) continue;
    rows.push({
      video_id: v.youtube_video_id,
      source_url: v.video_url ?? `https://www.youtube.com/watch?v=${v.youtube_video_id}`,
      title: v.title.slice(0, 200),
      source: src.name,
      source_id: src.id,
      channel_handle: src.handle,
      category: src.category ?? 'clip',
      published_at: v.published_at,
      thumbnail_url: v.thumbnail_url,
      source_type: 'youtube',
      origin: 'video_library',
    });
  }
  if (!rows.length) return { found: 0, saved: 0 };

  // In chunks. A single upsert of ~1,000 rows failed with a bare
  // "TypeError: fetch failed" - the payload, not the data - and a failure that
  // reports nothing about which row was at fault is one nobody can debug. 200
  // is comfortably inside the limit and turns one all-or-nothing request into
  // five that each say what they did.
  //
  // ignoreDuplicates keeps a tombstoned dead video dead: the library does not
  // know we already proved that id is gone.
  const CHUNK = 200;
  let saved = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const { error, count } = await supa
      .from('poker_clips')
      .upsert(batch, { onConflict: 'video_id', ignoreDuplicates: true, count: 'exact' });
    if (error) {
      console.warn(
        `[scrape-poker-clips] library import chunk ${i / CHUNK + 1} failed:`,
        error.message,
      );
      continue;
    }
    saved += count ?? 0;
  }
  return { found: rows.length, saved };
}

export async function scrapePokerClips(c: Context) {
  const started = Date.now();
  const sources = await dueSources();
  let scanned = 0;
  let found = 0;
  let saved = 0;
  let resolved = 0;
  let retired = 0;
  let throttled = 0;

  for (const source of sources) {
    scanned++;
    let channelId = source.channel_id;
    let wasThrottled = false;
    if (!channelId && source.handle) {
      const r = await resolveChannelId(source.handle);
      channelId = r.channelId;
      wasThrottled = r.throttled;
      if (channelId) resolved++;
      if (r.throttled) throttled++;
      await delay(CONFIG.REQUEST_DELAY_MS);
    }
    if (!channelId) {
      await markSource(source, 0, null, null, wasThrottled);
      if (!wasThrottled && source.consecutive_failures + 1 >= CONFIG.DEACTIVATE_AFTER) retired++;
      continue;
    }

    const feed = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
    if (feed.throttled) throttled++;
    const clips = feed.body ? parseChannelFeed(feed.body, CONFIG.MAX_CLIPS_PER_SOURCE) : [];
    found += clips.length;

    if (clips.length) {
      // Upsert on video_id: a channel's feed is its most recent uploads, so
      // every run re-sees what the last one already stored. ignoreDuplicates
      // keeps the tombstoned dead ones dead - a video we proved is gone must
      // not be resurrected by the feed still listing it.
      const rows = clips.map((clip) => ({
        video_id: clip.video_id,
        source_url: `https://www.youtube.com/watch?v=${clip.video_id}`,
        title: clip.title,
        source: source.name,
        source_id: source.id,
        channel_handle: source.handle,
        category: source.category ?? 'clip',
        published_at: clip.published_at,
        source_type: 'youtube',
        origin: 'scraper',
      }));
      const { error, count } = await getSupabase()
        .from('poker_clips')
        .upsert(rows, { onConflict: 'video_id', ignoreDuplicates: true, count: 'exact' });
      if (error) console.warn('[scrape-poker-clips] upsert failed:', error.message);
      else saved += count ?? 0;
    }

    const newest = clips.reduce<string | null>(
      (acc, cl) => (cl.published_at && (!acc || cl.published_at > acc) ? cl.published_at : acc),
      null,
    );
    await markSource(source, clips.length, channelId, newest, feed.throttled);
    if (
      clips.length === 0
        ? !feed.throttled && source.consecutive_failures + 1 >= CONFIG.DEACTIVATE_AFTER
        : !!newest && (Date.now() - Date.parse(newest)) / 86_400_000 > CONFIG.DORMANT_AFTER_DAYS
    ) {
      retired++;
    }
    await delay(CONFIG.REQUEST_DELAY_MS);
  }

  // Second phase: the library we already maintain, which no join had ever
  // reached. Cheap (one read, one upsert) and it runs even when the channel
  // walk found nothing new.
  const library = await importFromVideoLibrary();

  const { count: poolSize } = await getSupabase()
    .from('poker_clips')
    .select('*', { count: 'exact', head: true })
    .eq('is_active', true);

  return c.json({
    success: true,
    timestamp: new Date().toISOString(),
    ms: Date.now() - started,
    sources_scanned: scanned,
    handles_resolved: resolved,
    sources_retired: retired,
    requests_throttled: throttled,
    clips_found: found,
    clips_saved: saved,
    library_candidates: library.found,
    library_saved: library.saved,
    pool_size: poolSize ?? null,
  });
}
