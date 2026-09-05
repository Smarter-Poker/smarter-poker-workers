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
import {
  generatePostCaption,
  generateNewsCaption,
  seedHorseMemory,
} from './HumanVoiceEngine.js';
import { getRandomClip } from './ClipLibrary.js';
import {
  assetKeyFor,
  filterUnusedAssets,
  recordAssetUse,
  recordPhrase,
  pickFreshPhrase,
} from './ContentLedger.js';
import { fleetHash } from './FleetScheduler.js';

export interface FleetHorse {
  id: number | string;
  name: string;
  profile_id: string;
  timezone?: string | null;
  is_active?: boolean;
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
}

/** A horse that has posted inside this many hours is not due again. */
export const RECENT_POST_GUARD_HOURS = 20;

const rssParser = new Parser({
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  timeout: 8000,
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

const POKER_CAPTION_KEYS = new Set([
  'massive_pot',
  'bluff',
  'bad_beat',
  'soul_read',
  'table_drama',
  'celebrity',
  'funny',
  'educational',
  'vlog',
  'tournament',
  'high_stakes',
]);

interface SportsClipRow {
  id: string | number;
  video_id?: string;
  source_url: string;
  title?: string | null;
  source?: string | null;
  category?: string | null;
}

interface LibraryClip {
  id?: string;
  video_id?: string;
  source_url: string;
  title?: string;
  category?: string;
}

/** True when the video exists AND is embeddable (oEmbed returns an iframe). */
export async function validateYouTubeVideo(url: string | null | undefined): Promise<boolean> {
  if (!url) return false;
  const key = assetKeyFor(url);
  if (!key || !key.startsWith('yt:')) return false;
  const videoId = key.slice(3);
  try {
    const response = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
    );
    if (!response.ok) return false;
    const body = (await response.json()) as { html?: string };
    return !!body.html && body.html.includes('iframe');
  } catch {
    return false;
  }
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
      if (await validateYouTubeVideo(c.source_url)) {
        clip = c;
        break;
      }
      usable.delete(k);
    }
    if (!clip) return { ...base, success: false, error: 'All poker clips already posted' };
  } else {
    const supa = getSupabase();
    const assigned = await getHorseSources(horse.profile_id);
    let clips: SportsClipRow[] = [];
    if (assigned.length > 0) {
      const { data } = await supa.from('sports_clips').select('*').in('source', assigned).limit(200);
      if (data?.length) clips = data as SportsClipRow[];
    }
    if (!clips.length) {
      const offset = Math.floor(Math.random() * 5000);
      const { data } = await supa.from('sports_clips').select('*').range(offset, offset + 200);
      if (data?.length) clips = data as SportsClipRow[];
    }
    if (!clips.length) return { ...base, success: false, error: 'No sports clips' };

    const keys = clips.map((c) => assetKeyFor(c.source_url)).filter(Boolean) as string[];
    const usable = await filterUnusedAssets(keys, horse.profile_id);
    const fresh = clips.filter((c) => {
      const k = assetKeyFor(c.source_url);
      return !!k && usable.has(k);
    });
    if (!fresh.length) return { ...base, success: false, error: 'All sports clips already posted' };

    for (let i = 0; i < 10 && fresh.length > 0; i++) {
      const idx = Math.floor(Math.random() * fresh.length);
      const candidate = fresh[idx]!;
      if (await validateYouTubeVideo(candidate.source_url)) {
        clip = candidate;
        break;
      }
      fresh.splice(idx, 1);
    }
    if (!clip) return { ...base, success: false, error: 'No valid sports clips found' };
  }

  await seedMemoryFromHistory(horse.profile_id);

  const clipCategory =
    clipType === 'sports'
      ? 'sports_highlight'
      : clip.category && POKER_CAPTION_KEYS.has(clip.category)
        ? clip.category
        : 'massive_pot';
  const title = (clip as LibraryClip).title || '';
  const picked = await pickFreshPhrase(
    () => generatePostCaption(clipCategory, horse.profile_id, title),
    horse.profile_id,
  );

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
  return {
    ...base,
    success: true,
    postId: postId ?? undefined,
    type: `${clipType}_video`,
    caption: picked.text.slice(0, 60),
    collided: picked.collided,
  };
}

async function postNewsLink(
  horse: FleetHorse,
  newsType: 'poker' | 'sports',
): Promise<PublishResult> {
  const base = { horse: horse.name, profile_id: horse.profile_id };
  const sources = newsType === 'poker' ? POKER_NEWS_SOURCES : SPORTS_NEWS_SOURCES;
  const source = sources[fleetHash(horse.profile_id, `news:${newsType}`) % sources.length]!;

  try {
    const feed = await rssParser.parseURL(source.rss);
    const articles = (feed.items ?? []).slice(0, 20).filter((a) => !!a.link);
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

    const picked = await pickFreshPhrase(
      () => generateNewsCaption(article.title || '', horse.profile_id, newsType),
      horse.profile_id,
    );
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
    return {
      ...base,
      success: true,
      postId: postId ?? undefined,
      type: `${newsType}_news`,
      caption: (article.title ?? '').slice(0, 60),
      collided: picked.collided,
    };
  } catch (e) {
    return { ...base, success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Publish one post for this horse. 75/25 poker/sports with streak
 * prevention (three of a kind forces a switch), news first, video fallback.
 * Honours the recent-post guard so the hourly fleet route and the legacy
 * batch route cannot double up.
 */
export async function publishForHorse(
  horse: FleetHorse,
  opts: { skipGuard?: boolean } = {},
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

  const kind = isPoker ? 'poker' : 'sports';
  let result = await postNewsLink(horse, kind);
  if (!result.success) result = await postVideoClip(horse, kind);
  return result;
}
