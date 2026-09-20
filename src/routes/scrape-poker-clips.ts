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
 * YouTube says does not exist (404/410), or whose real feed is empty, has a
 * failure counted - but only in a run where YouTube was demonstrably
 * answering - and is deactivated after DEACTIVATE_AFTER consecutive such
 * failures. A good read clears the count. So a registry seeded generously
 * converges on what is really there, a blocked or throttled run cannot retire
 * anything, and the rows that died say so in a column.
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

/**
 * What one request to YouTube established.
 *
 *   ok        - YouTube answered with a page or feed we can read.
 *   missing   - YouTube said the thing does not exist: 404 or 410. This is the
 *               ONLY response that counts as evidence against a source.
 *   no-answer - everything else: 429 and 5xx (throttled), 403 (bot detection;
 *               revalidate-poker-clips reads it the same way), any other
 *               status, a timeout, a dropped connection, the ~755-byte throttle
 *               page, and - for callers that check the document - a 200 that is
 *               not what was asked for, such as a consent or bot-check page.
 *               None of these says anything about the channel.
 *
 * 2026-09-20: this used to report only `throttled`, and every status that was
 * neither 429 nor 5xx came back as `throttled: false`, which the caller charged
 * to the channel. From 2026-09-08 every 05:20 UTC run read zero videos from all
 * 25 channels it visited and each of those reads was charged; with a good read
 * never clearing the count (see sourcePatch), live channels were retired.
 */
export type ReadOutcome = 'ok' | 'missing' | 'no-answer';

async function fetchText(
  url: string,
): Promise<{ body: string | null; throttled: boolean; outcome: ReadOutcome }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': UA } });
    clearTimeout(timer);
    if (res.status === 404 || res.status === 410) {
      return { body: null, throttled: false, outcome: 'missing' };
    }
    if (!res.ok) return { body: null, throttled: true, outcome: 'no-answer' };
    const body = await res.text();
    // A 200 this small is the throttle page, not a channel.
    if (body.length < THROTTLE_PAGE_BYTES) return { body: null, throttled: true, outcome: 'no-answer' };
    return { body, throttled: false, outcome: 'ok' };
  } catch {
    clearTimeout(timer);
    // A timeout or a dropped connection is not evidence about the channel.
    return { body: null, throttled: true, outcome: 'no-answer' };
  }
}

/**
 * Resolve @handle to the UC... channel id, once. Both shapes appear in the
 * channel page; either is fine and the first hit wins.
 */
export async function resolveChannelId(
  handle: string,
): Promise<{ channelId: string | null; throttled: boolean; outcome: ReadOutcome }> {
  const { body: html, throttled, outcome } = await fetchText(`https://www.youtube.com/${handle}`);
  if (!html) return { channelId: null, throttled, outcome };
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
  const channelId = m?.[1] ?? null;
  // A full-size page that names no channel is a consent wall, a bot check or a
  // layout we do not recognise. Only a 404/410 says the handle is gone.
  return { channelId, throttled: false, outcome: channelId ? 'ok' : 'no-answer' };
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

/**
 * A 200 is only a feed if it is one. A consent page, a bot check or an HTML
 * error page served with 200 parses to zero entries, and zero entries from a
 * page that is not a feed says nothing about the channel.
 */
export function isAtomFeed(body: string): boolean {
  return /<feed[\s>]/.test(body) && body.includes('http://www.w3.org/2005/Atom');
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

/**
 * What this run learned about one source.
 *
 *   ok        - a real feed was read. Clears the failure count, because
 *               consecutive means consecutive. 2026-09-20: it never did. A good
 *               read left the count where it was, so "six consecutive failures"
 *               meant six failures ever, and every channel the bad 05:20 runs
 *               visited walked toward retirement however many 17:20 runs read
 *               it perfectly. last_ok_at is set only here - it used to be set
 *               by a throttled run too, which made a non-answer look like a
 *               good read.
 *   failed    - YouTube positively said the handle or channel does not exist,
 *               or served a real feed with nothing in it. Counts toward
 *               retirement, and is only recorded in a run where YouTube was
 *               demonstrably answering (see scrapePokerClips).
 *   no-answer - nothing was learned. The failure count, last_ok_at and
 *               clips_found are left exactly as they were.
 */
export type SourceReading =
  | { kind: 'ok'; found: number; channelId: string | null; newest: string | null }
  | { kind: 'failed'; channelId: string | null }
  | { kind: 'no-answer'; channelId: string | null };

export function sourcePatch(
  source: Pick<SourceRow, 'channel_id' | 'consecutive_failures'>,
  reading: SourceReading,
  nowMs: number,
): { patch: Record<string, unknown>; retired: boolean; dormantDays: number | null } {
  const now = new Date(nowMs).toISOString();
  const patch: Record<string, unknown> = { last_scraped_at: now, updated_at: now };
  if (reading.channelId && reading.channelId !== source.channel_id) patch.channel_id = reading.channelId;
  if (reading.kind === 'no-answer') return { patch, retired: false, dormantDays: null };

  if (reading.kind === 'failed') {
    const failures = source.consecutive_failures + 1;
    patch.consecutive_failures = failures;
    patch.clips_found = 0;
    // A handle YouTube says is gone, or a channel with nothing in its feed, six
    // readable runs in a row, is retired rather than retried forever. The row
    // stays, with the count that retired it, so the registry can be read.
    const retired = failures >= CONFIG.DEACTIVATE_AFTER;
    if (retired) patch.is_active = false;
    return { patch, retired, dormantDays: null };
  }

  patch.consecutive_failures = 0;
  patch.clips_found = reading.found;
  patch.last_ok_at = now;
  // Answering with nothing recent is its own kind of dead.
  if (reading.newest) {
    const ageDays = (nowMs - Date.parse(reading.newest)) / 86_400_000;
    if (Number.isFinite(ageDays) && ageDays > CONFIG.DORMANT_AFTER_DAYS) {
      patch.is_active = false;
      return { patch, retired: true, dormantDays: Math.round(ageDays) };
    }
  }
  return { patch, retired: false, dormantDays: null };
}

/** Applies one reading. Returns true only when this write retired the source. */
async function markSource(source: SourceRow, reading: SourceReading): Promise<boolean> {
  const { patch, retired, dormantDays } = sourcePatch(source, reading, Date.now());
  if (dormantDays !== null) {
    console.warn(`[scrape-poker-clips] ${source.name} dormant: newest upload ${dormantDays} days old`);
  }
  const { error } = await getSupabase().from('content_sources').update(patch).eq('id', source.id);
  if (error) {
    console.warn('[scrape-poker-clips] source update failed:', error.message);
    return false;
  }
  return retired;
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
  let feedsRead = 0;
  // Evidence against a source is held until the end of the walk, because
  // whether it counts depends on what the whole run could read.
  const accused: Array<{ source: SourceRow; channelId: string | null }> = [];

  for (const source of sources) {
    scanned++;
    let channelId = source.channel_id;
    if (!channelId && source.handle) {
      const r = await resolveChannelId(source.handle);
      await delay(CONFIG.REQUEST_DELAY_MS);
      if (r.outcome === 'missing') {
        accused.push({ source, channelId: null });
        continue;
      }
      if (r.outcome !== 'ok' || !r.channelId) {
        throttled++;
        await markSource(source, { kind: 'no-answer', channelId: null });
        continue;
      }
      channelId = r.channelId;
      resolved++;
    }
    if (!channelId) {
      // Neither a handle nor a channel id: nothing can ever be read from this row.
      accused.push({ source, channelId: null });
      continue;
    }

    const feed = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
    if (feed.outcome === 'missing') {
      accused.push({ source, channelId });
      await delay(CONFIG.REQUEST_DELAY_MS);
      continue;
    }
    if (!feed.body || !isAtomFeed(feed.body)) {
      throttled++;
      await markSource(source, { kind: 'no-answer', channelId });
      await delay(CONFIG.REQUEST_DELAY_MS);
      continue;
    }
    const clips = parseChannelFeed(feed.body, CONFIG.MAX_CLIPS_PER_SOURCE);
    if (!clips.length) {
      // A real feed with nothing in it: the channel publishes nothing we can read.
      accused.push({ source, channelId });
      await delay(CONFIG.REQUEST_DELAY_MS);
      continue;
    }
    feedsRead++;
    found += clips.length;

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

    const newest = clips.reduce<string | null>(
      (acc, cl) => (cl.published_at && (!acc || cl.published_at > acc) ? cl.published_at : acc),
      null,
    );
    if (await markSource(source, { kind: 'ok', found: clips.length, channelId, newest })) retired++;
    await delay(CONFIG.REQUEST_DELAY_MS);
  }

  // A run that could not read one feed or resolve one handle learned nothing
  // about any channel: YouTube was not answering it. Every 05:20 UTC run from
  // 2026-09-08 to 2026-09-20 read zero videos from all 25 channels it visited,
  // and charging those reads to the channels is what retired them. Evidence
  // against a source counts only in a run that demonstrably could read.
  const youtubeAnswered = feedsRead > 0 || resolved > 0;
  let failuresCharged = 0;
  let failuresWithheld = 0;
  for (const { source, channelId } of accused) {
    if (youtubeAnswered) {
      failuresCharged++;
      if (await markSource(source, { kind: 'failed', channelId })) retired++;
    } else {
      failuresWithheld++;
      await markSource(source, { kind: 'no-answer', channelId });
    }
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
    feeds_read: feedsRead,
    youtube_answered: youtubeAnswered,
    failures_charged: failuresCharged,
    failures_withheld: failuresWithheld,
  });
}
