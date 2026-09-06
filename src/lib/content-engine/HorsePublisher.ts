/**
 * HorsePublisher: publish one post for one horse.
 *
 * Extracted from routes/horse-by-index.ts on 2026-09-05 so that the hourly
 * fleet route (routes/horse-posts.ts) and the legacy batch route share ONE
 * publish path. The batch route stays registered only for the hand-over
 * window between the workers deploy and the dispatcher deploy; both paths
 * carry the same 20-hour guard, so a horse reached by both in the same hour
 * still posts once.
 *
 * What changed from the batch-era body, and why:
 *   - Dedup reads the content ledgers (ContentLedger.ts), not an unordered
 *     `limit(100)` over social_posts. The old window saw about half of what
 *     was posted; the ledger sees all of it, for 90 days.
 *   - The news source is picked by a hash of the horse, not by its index in
 *     a 100-row page that no longer exists.
 *   - Every publish writes its asset and its caption to the ledgers.
 *   - Captions are drawn through pickFreshPhrase(), which retries the pool
 *     when the ledger has seen the sentence recently and reports a
 *     collision when it gives up, so the result JSON (and therefore
 *     cron_execution_log.result) shows how often the pools are running dry.
 *     That number is the Phase 2 and 3 yardstick.
 *
 * Still true, unchanged: no language model is called anywhere in here.
 * Every caption is a phrase pool draw. Zero cost, and the reason Phase 3
 * exists.
 */
import Parser from 'rss-parser';
import { getSupabase } from '../supabase.js';
import { seedHorseMemory } from './HumanVoiceEngine.js';
import { writeCaption, writeGrounded, summarise, recordBrief, type AuthorHorse } from './VoiceWriter.js';
import { isUninformativeTitle } from './PostBrief.js';
import { getRandomClip } from './ClipLibrary.js';
import {
  assetKeyFor,
  filterUnusedAssets,
  recordAssetUse,
  recordPhrase,
  normalizePhrase,
} from './ContentLedger.js';
import { fleetHash } from './FleetScheduler.js';

export interface FleetHorse {
  id: number | string;
  name: string;
  profile_id: string;
  timezone?: string | null;
  is_active?: boolean;
  /** Phase 2: needed to write in this horse's voice and to tag a friend. */
  alias?: string | null;
  location?: string | null;
  stakes?: string | null;
  specialty?: string | null;
}

export interface PublishResult {
  success: boolean;
  horse: string;
  profile_id: string;
  type?: string;
  postId?: string;
  caption?: string;
  collided?: boolean;
  error?: string;
  skipped?: 'posted_recently';
  /** Phase 2: how well the words matched the subject, and what grounded them. */
  relevance?: number;
  grounding?: string[];
  drafts?: number;
  belowFloor?: boolean;
  tagged?: string;
  briefSummary?: string;
}

/** A horse that has posted inside this many hours is not due again. */
export const RECENT_POST_GUARD_HOURS = 20;

const rssParser = new Parser({
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  timeout: 8000,
});

/**
 * One fetch per feed per ten minutes, not one per horse. Measured
 * 2026-09-05: with ~30 horses due an hour the four sports feeds were
 * fetched thirty times an hour each and ESPN answered 429, CBS 403.
 * A failed fetch is cached too (as empty) so the fleet does not hammer a
 * host that just refused it.
 */
type FeedItem = { title?: string; link?: string };
const feedCache = new Map<string, { items: FeedItem[]; at: number; error?: string }>();
const FEED_TTL_MS = 10 * 60_000;

export async function fetchFeed(url: string): Promise<FeedItem[]> {
  const cached = feedCache.get(url);
  if (cached && Date.now() - cached.at < FEED_TTL_MS) {
    if (cached.error) throw new Error(cached.error);
    return cached.items;
  }
  try {
    const feed = await rssParser.parseURL(url);
    const items = (feed.items ?? []) as FeedItem[];
    feedCache.set(url, { items, at: Date.now() });
    bumpSupplyStat('rss_ok');
    return items;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    feedCache.set(url, { items: [], at: Date.now(), error: msg });
    bumpSupplyStat(`rss_fail_${msg.replace(/[^0-9a-z]+/gi, '_').slice(0, 24)}`);
    throw e;
  }
}

/** Test hook. */
export function _resetFeedCache(): void {
  feedCache.clear();
}

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


interface SportsClipRow {
  id: string | number;
  video_id?: string;
  source_url: string;
  title?: string | null;
  source?: string | null;
  category?: string | null;
  sport_type?: string | null;
}

interface LibraryClip {
  id?: string;
  video_id?: string;
  source_url: string;
  title?: string;
  category?: string;
}

/**
 * YouTube validity, with the throttle in mind.
 *
 * Measured 2026-09-05 11:10 to 19:10: every hourly fleet fire failed every
 * sports clip with "No valid sports clips found". The route validated up to
 * ten candidates per horse per hour through YouTube's oEmbed endpoint, from
 * one VM IP, and YouTube started answering 429. A 429 is not "this video is
 * gone"; treating it as one silenced the whole fleet for eight hours.
 *
 *   ok       -> oEmbed returned an embeddable iframe
 *   bad      -> oEmbed said 401/403/404 (age-gated, embed-disabled, removed)
 *   unknown  -> throttled (429), network error, or we are inside a backoff
 *
 * Results are cached in-process for a day (an optimisation, not a memory:
 * the ledger is the memory). After a 429 nothing is asked for 15 minutes.
 */
export type YtValidity = 'ok' | 'bad' | 'unknown';
const validityCache = new Map<string, { v: YtValidity; at: number }>();
/**
 * Real titles, straight from YouTube, keyed by asset. oEmbed already tells us
 * the title on the call we make anyway, and half the stored titles are the
 * player's menu rather than the clip, so we keep it and repair the row.
 */
const oembedTitles = new Map<string, string>();
export function cachedOembedTitle(url: string | null | undefined): string | null {
  const key = assetKeyFor(url);
  return (key && oembedTitles.get(key)) || null;
}
const VALIDITY_TTL_MS = 24 * 3_600_000;
let oembedBackoffUntil = 0;
let consecutive403 = 0;
export const OEMBED_BACKOFF_MS = 15 * 60_000;

/**
 * Per-run supply telemetry, surfaced in the route's result JSON so a run
 * that publishes nothing says WHY in cron_execution_log. Added after eight
 * hourly fires (11:10 to 19:10, 2026-09-05) reported "No valid sports clips
 * found" while every sampled clip answered 200 from inside the container:
 * the statuses seen during the burst were never recorded anywhere.
 */
const supplyStats: Record<string, number> = {};
export function bumpSupplyStat(key: string): void {
  supplyStats[key] = (supplyStats[key] ?? 0) + 1;
}
export function takeSupplyStats(): Record<string, number> {
  const out = { ...supplyStats, oembed_backoff_active: Date.now() < oembedBackoffUntil ? 1 : 0 };
  for (const k of Object.keys(supplyStats)) delete supplyStats[k];
  return out;
}

export async function youtubeValidity(url: string | null | undefined): Promise<YtValidity> {
  if (!url) return 'bad';
  const key = assetKeyFor(url);
  if (!key || !key.startsWith('yt:')) {
    bumpSupplyStat('yt_not_youtube');
    return 'bad';
  }
  const cached = validityCache.get(key);
  if (cached && Date.now() - cached.at < VALIDITY_TTL_MS && cached.v !== 'unknown') {
    bumpSupplyStat(`yt_cache_${cached.v}`);
    return cached.v;
  }
  if (Date.now() < oembedBackoffUntil) {
    bumpSupplyStat('yt_backoff_unknown');
    return 'unknown';
  }
  const videoId = key.slice(3);
  try {
    const response = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' } },
    );
    bumpSupplyStat(`yt_http_${response.status}`);
    if (response.status === 429 || response.status >= 500) {
      oembedBackoffUntil = Date.now() + OEMBED_BACKOFF_MS;
      console.warn(`[horse-publisher] YouTube oEmbed ${response.status}; backing off 15 minutes`);
      return 'unknown';
    }
    if (response.status === 403) {
      // 403 is "embedding disabled" for ONE video, but three in a row from
      // one IP is bot detection. Do not let a block read as dead videos.
      consecutive403 += 1;
      if (consecutive403 >= 3) {
        oembedBackoffUntil = Date.now() + OEMBED_BACKOFF_MS;
        console.warn('[horse-publisher] YouTube oEmbed 403 x3; treating as a block, backing off 15 minutes');
        return 'unknown';
      }
      return 'bad';
    }
    consecutive403 = 0;
    let v: YtValidity;
    if (!response.ok) {
      v = 'bad';
    } else {
      const body = (await response.json()) as { html?: string; title?: string };
      if (body.title && body.title.trim()) oembedTitles.set(key, body.title.trim());
      v = body.html && body.html.includes('iframe') ? 'ok' : 'bad';
    }
    validityCache.set(key, { v, at: Date.now() });
    return v;
  } catch (e) {
    bumpSupplyStat('yt_fetch_error');
    console.warn('[horse-publisher] YouTube oEmbed fetch error:', e instanceof Error ? e.message : e);
    return 'unknown';
  }
}

/** Back-compat boolean: ok is true, bad is false, unknown is the caller's call. */
export async function validateYouTubeVideo(url: string | null | undefined): Promise<boolean> {
  return (await youtubeValidity(url)) === 'ok';
}

/** Test hook. */
export function _resetValidityCache(): void {
  validityCache.clear();
  oembedTitles.clear();
  oembedBackoffUntil = 0;
  consecutive403 = 0;
}

export function convertToEmbedUrl(url: string): string {
  const key = assetKeyFor(url);
  if (key && key.startsWith('yt:')) return `https://www.youtube.com/embed/${key.slice(3)}`;
  return url;
}

/** Deterministic slice of sports sources for this horse. */
async function getHorseSources(profileId: string): Promise<string[]> {
  const { data } = await getSupabase().from('sports_clips').select('source').limit(1000);
  const all = [...new Set(((data ?? []) as { source: string | null }[]).map((s) => s.source).filter(Boolean))] as string[];
  if (all.length === 0) return [];
  const hash = fleetHash(profileId, 'sports-sources');
  const n = Math.max(10, Math.floor(all.length / 100));
  const assigned: string[] = [];
  for (let i = 0; i < n; i++) assigned.push(all[(hash + i * 7) % all.length]!);
  return assigned;
}

/** Has this horse posted inside the guard window? */
export async function postedRecently(profileId: string, hours = RECENT_POST_GUARD_HOURS): Promise<boolean> {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const { data, error } = await getSupabase()
    .from('social_posts')
    .select('id')
    .eq('author_id', profileId)
    .gte('created_at', since)
    .limit(1);
  if (error) {
    console.warn('[horse-publisher] recent-post guard read failed:', error.message);
    return false;
  }
  return (data ?? []).length > 0;
}

async function seedMemoryFromHistory(profileId: string): Promise<void> {
  const { data } = await getSupabase()
    .from('social_posts')
    .select('content')
    .eq('author_id', profileId)
    .order('created_at', { ascending: false })
    .limit(15);
  if (data?.length) {
    seedHorseMemory(
      profileId,
      (data as { content: string | null }[]).map((p) => p.content?.split('\n')[0] || ''),
    );
  }
}

async function postVideoClip(
  horse: FleetHorse,
  clipType: 'poker' | 'sports',
  fleet: AuthorHorse[],
): Promise<PublishResult> {
  const base = { horse: horse.name, profile_id: horse.profile_id };
  let clip: LibraryClip | SportsClipRow | null = null;

  if (clipType === 'poker') {
    // Candidate set: 20 draws from the library, filtered through the ledger
    // in ONE read, then validated in order.
    const candidates: LibraryClip[] = [];
    for (let i = 0; i < 20; i++) {
      const c = getRandomClip() as LibraryClip | null;
      if (c) candidates.push(c);
    }
    const keys = candidates.map((c) => assetKeyFor(c.source_url)).filter(Boolean) as string[];
    const usable = await filterUnusedAssets(keys, horse.profile_id);
    for (const c of candidates) {
      const k = assetKeyFor(c.source_url);
      if (!k || !usable.has(k)) continue;
      // The library was hand-verified; only a definite "bad" drops it.
      if ((await youtubeValidity(c.source_url)) !== 'bad') {
        clip = c;
        break;
      }
      usable.delete(k);
    }
    if (!clip) return { ...base, success: false, error: 'All poker clips already posted' };
  } else {
    const supa = getSupabase();
    const assigned = await getHorseSources(horse.profile_id);
    // Newest first. Measured 2026-09-05 20:17 (supply telemetry): the
    // unordered .limit(200) returned the OLDEST rows, January shorts of
    // which 24 answered 404 and 11 answered 401 in one run, and the ledger
    // left under ten fresh candidates per horse. The scraper adds clips
    // daily; the newest 400 of a horse's sources are the live pool.
    let clips: SportsClipRow[] = [];
    if (assigned.length > 0) {
      const { data } = await supa
        .from('sports_clips')
        .select('*')
        .in('source', assigned)
        .order('created_at', { ascending: false })
        .limit(400);
      if (data?.length) clips = data as SportsClipRow[];
    }
    const freshOf = async (rows: SportsClipRow[]) => {
      const keys = rows.map((c) => assetKeyFor(c.source_url)).filter(Boolean) as string[];
      const usable = await filterUnusedAssets(keys, horse.profile_id);
      return rows.filter((c) => {
        const k = assetKeyFor(c.source_url);
        return !!k && usable.has(k);
      });
    };
    let fresh = clips.length ? await freshOf(clips) : [];
    if (fresh.length < 10) {
      // The horse's own sources are thin; widen to the platform's newest.
      const { data } = await supa
        .from('sports_clips')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(600);
      if (data?.length) fresh = await freshOf(data as SportsClipRow[]);
      bumpSupplyStat('sports_widened_to_platform');
    }
    if (!fresh.length) return { ...base, success: false, error: 'All sports clips already posted' };
    bumpSupplyStat('sports_fresh_candidates_' + (fresh.length >= 50 ? '50plus' : fresh.length >= 10 ? '10to49' : 'under10'));

    // Three candidates, not ten: sports_clips rows come from the channel
    // scraper and are trusted unless oEmbed definitely says otherwise.
    for (let i = 0; i < 3 && fresh.length > 0; i++) {
      const idx = Math.floor(Math.random() * fresh.length);
      const candidate = fresh[idx]!;
      if ((await youtubeValidity(candidate.source_url)) !== 'bad') {
        clip = candidate;
        break;
      }
      fresh.splice(idx, 1);
    }
    if (!clip) return { ...base, success: false, error: 'No valid sports clips found' };
  }

  await seedMemoryFromHistory(horse.profile_id);

  // Phase 2: the caption is written from a brief of THIS clip - its title,
  // channel and sport - not drawn from a pool keyed on a category. See
  // PostBrief.ts for what the old path produced.
  // Prefer the title YouTube just gave us over the one the scraper stored,
  // and repair the row while we are here (self-healing, bounded, one write).
  const storedTitle = (clip as LibraryClip).title || '';
  const realTitle = cachedOembedTitle(clip.source_url);
  let title = storedTitle;
  if (realTitle && isUninformativeTitle(storedTitle, (clip as SportsClipRow).source ?? undefined)
      && !isUninformativeTitle(realTitle, (clip as SportsClipRow).source ?? undefined)) {
    title = realTitle;
    if (clipType === 'sports' && (clip as SportsClipRow).id) {
      const { error: fixErr } = await getSupabase()
        .from('sports_clips')
        .update({ title: realTitle })
        .eq('id', (clip as SportsClipRow).id);
      if (fixErr) console.warn('[horse-publisher] title repair failed:', fixErr.message);
      else bumpSupplyStat('title_repaired');
    }
  }
  const written = await writeCaption(
    horse as AuthorHorse,
    {
      kind: 'video',
      title,
      source: (clip as SportsClipRow).source ?? undefined,
      domainHint: clipType,
      sportHint: (clip as SportsClipRow).sport_type ?? (clip as LibraryClip).category ?? null,
    },
    fleet,
  );
  const picked = { text: written.text, norm: normalizePhrase(written.text), collided: written.stale };

  const embedUrl = convertToEmbedUrl(clip.source_url);
  const { data: post, error } = await getSupabase()
    .from('social_posts')
    .insert({
      author_id: horse.profile_id,
      content: picked.text,
      content_type: 'video',
      media_urls: [embedUrl],
      visibility: 'public',
      metadata: {
        clip_type: clipType,
        clip_id: (clip as SportsClipRow).id ?? (clip as LibraryClip).video_id,
        scheduler: 'fleet',
      },
    })
    .select('id')
    .maybeSingle();

  if (error) return { ...base, success: false, error: error.message };
  const postId = (post as { id: string } | null)?.id ?? null;
  const key = assetKeyFor(clip.source_url);
  if (key) await recordAssetUse(key, horse.profile_id, postId);
  await recordPhrase(picked.norm, horse.profile_id, postId);
  if (postId) await recordBrief(postId, written.brief);
  return {
    ...base,
    success: true,
    postId: postId ?? undefined,
    type: `${clipType}_video`,
    caption: picked.text.slice(0, 60),
    collided: picked.collided,
    relevance: written.relevance,
    grounding: written.grounding,
    drafts: written.attempts,
    belowFloor: written.belowFloor,
    tagged: written.tagged?.alias,
    briefSummary: summarise(written.brief),
  };
}

async function postNewsLink(
  horse: FleetHorse,
  newsType: 'poker' | 'sports',
  fleet: AuthorHorse[],
): Promise<PublishResult> {
  const base = { horse: horse.name, profile_id: horse.profile_id };
  const sources = newsType === 'poker' ? POKER_NEWS_SOURCES : SPORTS_NEWS_SOURCES;
  const source = sources[fleetHash(horse.profile_id, `news:${newsType}`) % sources.length]!;

  try {
    const articles = (await fetchFeed(source.rss)).slice(0, 20).filter((a) => !!a.link);
    if (!articles.length) return { ...base, success: false, error: 'No articles' };

    const keys = articles.map((a) => assetKeyFor(a.link)).filter(Boolean) as string[];
    const usable = await filterUnusedAssets(keys, horse.profile_id);
    const fresh = articles.filter((a) => {
      const k = assetKeyFor(a.link);
      return !!k && usable.has(k);
    });
    if (!fresh.length) return { ...base, success: false, error: 'All articles already posted' };

    const article = fresh[Math.floor(Math.random() * fresh.length)]!;
    await seedMemoryFromHistory(horse.profile_id);

    const written = await writeCaption(
      horse as AuthorHorse,
      { kind: 'link', title: article.title ?? '', source: source.name, domainHint: newsType },
      fleet,
    );
    const picked = { text: written.text, norm: normalizePhrase(written.text), collided: written.stale };
    const content = `${picked.text}\n\n${article.link}`;

    const { data: post, error } = await getSupabase()
      .from('social_posts')
      .insert({
        author_id: horse.profile_id,
        content,
        content_type: 'link',
        visibility: 'public',
        link_url: article.link,
        link_title: article.title,
        link_site_name: source.name,
        metadata: { news_type: newsType, scheduler: 'fleet' },
      })
      .select('id')
      .maybeSingle();

    if (error) return { ...base, success: false, error: error.message };
    const postId = (post as { id: string } | null)?.id ?? null;
    const key = assetKeyFor(article.link);
    if (key) await recordAssetUse(key, horse.profile_id, postId);
    await recordPhrase(picked.norm, horse.profile_id, postId);
    if (postId) await recordBrief(postId, written.brief);
    return {
      ...base,
      success: true,
      postId: postId ?? undefined,
      type: `${newsType}_news`,
      caption: (article.title ?? '').slice(0, 60),
      collided: picked.collided,
      relevance: written.relevance,
      grounding: written.grounding,
      drafts: written.attempts,
      belowFloor: written.belowFloor,
      tagged: written.tagged?.alias,
      briefSummary: summarise(written.brief),
    };
  } catch (e) {
    return { ...base, success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * A post about the horse's own poker. Text only: the subject is the hand, and
 * there is no asset to attach until the Phase 9 renderer exists.
 *
 * The "no text-only posts" rule this lifts was written when a text post meant
 * a sentence from a pool with nothing behind it. A hand recap is the opposite
 * of that: it is the most specific thing the fleet can publish.
 */
async function postGrounded(horse: FleetHorse): Promise<PublishResult> {
  const base = { horse: horse.name, profile_id: horse.profile_id };
  const written = await writeGrounded(horse as AuthorHorse);
  if (!written || !written.text) return { ...base, success: false, error: 'No hand worth telling' };

  const { data: post, error } = await getSupabase()
    .from('social_posts')
    .insert({
      author_id: horse.profile_id,
      content: written.text,
      content_type: 'text',
      visibility: 'public',
      metadata: { clip_type: 'poker', scheduler: 'fleet', grounded: true, grounding: written.grounding },
    })
    .select('id')
    .maybeSingle();

  if (error) return { ...base, success: false, error: error.message };
  const postId = (post as { id: string } | null)?.id ?? null;
  await recordPhrase(normalizePhrase(written.text), horse.profile_id, postId);
  if (postId) await recordBrief(postId, written.brief);
  return {
    ...base,
    success: true,
    postId: postId ?? undefined,
    type: 'grounded_hand',
    caption: written.text.slice(0, 60),
    relevance: written.relevance,
    grounding: written.grounding,
    drafts: written.attempts,
    belowFloor: false,
    briefSummary: summarise(written.brief),
  };
}

/**
 * Publish one post for this horse. 75/25 poker/sports with streak
 * prevention (three of a kind forces a switch), news first, video fallback.
 * Honours the recent-post guard so the hourly fleet route and the legacy
 * batch route cannot double up.
 */
export async function publishForHorse(
  horse: FleetHorse,
  opts: { skipGuard?: boolean; fleet?: AuthorHorse[] } = {},
): Promise<PublishResult> {
  const base = { horse: horse.name, profile_id: horse.profile_id };
  if (!opts.skipGuard && (await postedRecently(horse.profile_id))) {
    return { ...base, success: false, skipped: 'posted_recently' };
  }

  let isPoker = Math.random() < 0.75;
  try {
    const { data: lastPosts } = await getSupabase()
      .from('social_posts')
      .select('metadata')
      .eq('author_id', horse.profile_id)
      .order('created_at', { ascending: false })
      .limit(3);
    const types = ((lastPosts ?? []) as { metadata: Record<string, unknown> | null }[])
      .map((p) => (p.metadata?.clip_type ?? p.metadata?.news_type) as string | undefined)
      .filter((t): t is 'poker' | 'sports' => t === 'poker' || t === 'sports');
    if (types.length >= 3 && types.every((t) => t === 'poker')) isPoker = false;
    else if (types.length >= 3 && types.every((t) => t === 'sports')) isPoker = true;
  } catch {
    /* streak check is best effort */
  }

  // Preferred category first (news, then video), then the OTHER category.
  // Measured on the first hourly fleet fire (2026-09-05 09:10): 26 due, 18
  // failed "All poker clips already posted" because the ledger correctly
  // refused all 150 hard-coded poker clips. A due horse that stays silent is
  // the old failure in a new shape, so the other category is the fallback
  // until Phase 4 gives poker a real supply. The result type records which
  // category actually published, so the skew is visible in
  // cron_execution_log.result.by_type.
  const preferred: 'poker' | 'sports' = isPoker ? 'poker' : 'sports';
  const other: 'poker' | 'sports' = isPoker ? 'sports' : 'poker';
  const attempts: string[] = [];

  // Phase 3: the horse's own poker.
  //
  // Grounded posts cannot repeat and cannot be about nothing - two horses did
  // not play the same hand, and there are 204,474 of them a week across the
  // fleet. They lead most of the time, but not always: a feed of nothing but
  // hand recaps is its own kind of monotony, and the clips and articles give
  // it texture. The split is a hash of the horse and the day, so it is stable
  // across a retry and varies across the fleet.
  const groundedFirst = fleetHash(`${horse.profile_id}:${new Date().toISOString().slice(0, 10)}`, 'grounded') % 100 < 60;
  if (groundedFirst) {
    const grounded = await postGrounded(horse);
    if (grounded.success) return grounded;
    attempts.push(`grounded: ${grounded.error}`);
  }

  for (const kind of [preferred, other]) {
    let result = await postNewsLink(horse, kind, opts.fleet ?? []);
    if (result.success) return result;
    attempts.push(`${kind}_news: ${result.error}`);
    result = await postVideoClip(horse, kind, opts.fleet ?? []);
    if (result.success) return result;
    attempts.push(`${kind}_video: ${result.error}`);
  }

  // The media pools are exhausted for this horse. Its own poker is the
  // fallback that never is.
  if (!groundedFirst) {
    const grounded = await postGrounded(horse);
    if (grounded.success) return grounded;
    attempts.push(`grounded: ${grounded.error}`);
  }

  return { ...base, success: false, error: attempts.join(' | ') };
}
