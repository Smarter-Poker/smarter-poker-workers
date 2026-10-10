/**
 * HorsePublisher: publish one post for one horse.
 *
 * Extracted from routes/horse-by-index.ts on 2026-09-05 so that the hourly
 * fleet route (routes/horse-posts.ts) and the legacy batch route shared ONE
 * publish path. The batch route was deleted on 2026-09-21 (recertification
 * G1: nothing had called it since 2026-09-06); horse-posts is the only caller.
 *
 * DUPLICATES ARE REFUSED BY THE DATABASE, NOT BY THIS PROCESS (recertification
 * F1 and F2, 2026-09-21). Every post this file inserts carries
 * metadata.publication_key = 'fleet:<profile id>:<slot>', where the slot is
 * the local date and hour at which FleetScheduler opened the horse's posting
 * window. The unique index uq_social_posts_metadata_publication_key lets one
 * insert per horse per slot succeed; a second run inside the same window gets
 * 23505, which is counted as a duplicate and writes no ledger rows. The
 * 20-hour recent-post guard stays as the cheap first check and fails closed:
 * when it cannot be read the horse is skipped and the reason is counted. The
 * social_posts.publication_key COLUMN is not used; a CHECK reserves it for
 * the video library.
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
 * Model captions remain explicitly disabled until the service-only budget
 * contract is configured and qualified. When enabled, VoiceWriter reserves
 * worst-case cost first and keeps every relevance, freshness and publication
 * gate below intact; deterministic composition remains the safe fallback.
 */
import Parser from 'rss-parser';
import { getSupabase } from '../supabase.js';
import { postModeEnabled } from './Fleet.js';
import { topicsFor } from './SocialTopics.js';
import { seedHorseMemory } from './HumanVoiceEngine.js';
import { writeCaption, writeGrounded, summarise, recordBrief, type AuthorHorse, type ModelAttemptContext } from './VoiceWriter.js';
import { briefForAsset, isUninformativeTitle } from './PostBrief.js';
import { hasSpecificTake } from './Composer.js';
import {
  candidateClips,
  newsSources,
  platformCandidateClips,
  recordValidity,
  sliceForHorse,
  sportsShareFor,
  type SupplyClip,
} from './ClipSupply.js';
import {
  assetKeyFor,
  filterUnusedAssets,
  ledgerReadFailureTotal,
  recordPhrase,
  normalizePhrase,
} from './ContentLedger.js';
import { fleetHash, isDueForPost, localClock } from './FleetScheduler.js';
import {
  publishHorseVideoAtomically,
  readFreshSharedYouTubeVerificationIds,
  recordYouTubeVerification,
  type HorseVideoTopic,
} from './HorseVideoPublication.js';
import { verifyYouTubeMetadata } from './YouTubeMetadataVerifier.js';
import { captionModelIdempotencyKey, takeModelWriterStats } from './ModelWriter.js';
import { extractArticleImageUrl, safeArticleUrl } from './NewsImage.js';
import { publishHorseNewsAtomically } from './HorseNewsPublication.js';

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

/**
 * Why nothing was published when that was the right answer rather than a
 * failure: the horse posted inside the guard window, the guard could not be
 * read (fail closed), another run already filled this slot (23505 on the slot
 * key), the bounded caption candidates are all inside the semantic reuse
 * window, or the horse has no scheduled slot open.
 */
export type PublishSkip =
  | 'posted_recently'
  | 'guard_unreadable'
  | 'duplicate_slot'
  | 'caption_exhausted'
  | 'supply_exhausted'
  | 'mode_disabled'
  | 'content_exhausted'
  | 'no_slot';

export interface PublishResult {
  success: boolean;
  horse: string;
  profile_id: string;
  type?: string;
  postId?: string;
  reelId?: string;
  created?: boolean;
  caption?: string;
  collided?: boolean;
  error?: string;
  outcome?: 'unknown';
  skipped?: PublishSkip;
  /** metadata.publication_key this attempt used or collided with. */
  publicationKey?: string;
  /** Phase 2: how well the words matched the subject, and what grounded them. */
  relevance?: number;
  grounding?: string[];
  drafts?: number;
  belowFloor?: boolean;
  tagged?: string;
  briefSummary?: string;
}

export interface SharedHorseVideoSupply {
  poker: SupplyClip[];
  sports: SupplyClip[];
}

export interface SharedHorseVideoSupplyCount {
  scanned: number;
  verified: number;
  /** Fresh positive assets whose stored metadata can ground a safe caption. */
  captionable: number;
}

export type PreparedSharedHorseVideoSupply =
  | {
      status: 'ok';
      supply: SharedHorseVideoSupply;
      availableTypes: HorseVideoTopic[];
      counts: Partial<Record<HorseVideoTopic, SharedHorseVideoSupplyCount>>;
    }
  | { status: 'unknown'; error: string };

/** A horse that has posted inside this many hours is not due again. */
export const RECENT_POST_GUARD_HOURS = 20;

/**
 * The scheduled slot a fleet post fills: the horse's LOCAL date and the hour
 * at which FleetScheduler opened its posting window, for example
 * '2026-09-21T14'. Null when the horse is not due at `now`.
 *
 * It names the schedule, not the clock. Every run inside one three-hour
 * window (a slow run and the next hourly fire, or a retry) names the same
 * slot, so they build the same publication key and only one can insert.
 */
export function fleetSlotId(
  profileId: string,
  timezone: string | null | undefined,
  now: Date,
): string | null {
  const due = isDueForPost(profileId, timezone, now);
  if (!due.due || due.dueHour === undefined) return null;
  const clock = localClock(now, timezone);
  // isDueForPost tries today's window first. A window that opened late
  // yesterday is still open just after midnight, and then its hour is later
  // than the local hour now.
  const day = due.dueHour <= clock.hour ? clock.dayKey : previousDayKey(clock.dayKey);
  return `${day}T${String(due.dueHour).padStart(2, '0')}`;
}

/** Civil-date arithmetic, so a 23-hour or 25-hour DST day cannot skew the key. */
function previousDayKey(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** metadata.publication_key of a fleet post: one per horse per slot. */
export function fleetPublicationKey(profileId: string, slotId: string): string {
  return `fleet:${profileId}:${slotId}`;
}

/**
 * Postgres unique_violation. On a fleet insert only the slot-key index can
 * raise it (the other unique indexes on social_posts cover video_library
 * rows), so it means another run already published this horse's slot.
 */
function isDuplicateSlot(error: { code?: string } | null | undefined): boolean {
  return error?.code === '23505';
}

/**
 * The atomic video RPC's definite failure, read as a slot clash or not.
 *
 * A duplicate on the slot index inside the RPC names that index in its
 * message; the RPC's own 23505 ('horse has already used this video asset')
 * does not, so the code alone cannot tell them apart. With a code, it must be
 * unique_violation and the message must name the index. Without one (an
 * older result shape), the message alone decides, as before.
 */
function isDuplicateSlotPublication(published: { code?: string; error?: string }): boolean {
  const message = published.error ?? '';
  if (!/publication_key/.test(message)) return false;
  if (published.code) return published.code === '23505';
  return isDuplicateSlotMessage(message);
}

/**
 * The atomic RPC is the authoritative semantic ledger check. A concurrent
 * writer can therefore reject a caption that looked fresh during the earlier
 * read. This exact, definite guard rejection is safe to retry with another
 * bounded candidate; transport uncertainty and every other database failure
 * remain terminal for the attempt.
 */
function isSemanticReusePublication(
  published: { outcome?: 'unknown'; error?: string },
): boolean {
  return published.outcome !== 'unknown'
    && /caption violates the semantic reuse window/i.test(published.error ?? '');
}

/** The message-only fallback: Postgres's unique_violation text naming the slot index. */
function isDuplicateSlotMessage(message: string | undefined): boolean {
  return !!message && /duplicate key value/i.test(message) && /publication_key/.test(message);
}

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
type FeedItem = { title?: string; link?: string } & Record<string, unknown>;
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

/**
 * The last-resort feeds, used ONLY when the registry cannot be read.
 *
 * Phase 4 moved news into `content_sources` so the seven sources
 * `content-health-check` monitors - with fallback URLs and auto-repair - are
 * the ones horses actually read. These literals are no longer the list; they
 * are what keeps a horse posting if Postgres is unreachable at that instant,
 * which is the one failure the registry cannot help with.
 */
const FALLBACK_NEWS_SOURCES: Record<'poker' | 'sports', Array<{ name: string; rss: string }>> = {
  poker: [
    { name: 'CardPlayer', rss: 'https://www.cardplayer.com/poker-news.rss' },
    { name: 'PokerNews', rss: 'https://www.pokernews.com/rss.php' },
  ],
  sports: [
    { name: 'ESPN', rss: 'https://www.espn.com/espn/rss/news' },
    { name: 'CBS Sports', rss: 'https://www.cbssports.com/rss/headlines/' },
  ],
};


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
 *   ok       -> oEmbed returned an iframe AND pinned yt-dlp proved that the
 *               video is public/unlisted, age-free, and playable in embeds
 *   bad      -> either verifier proved private, paid/auth gated, age/region
 *               restricted, embed-disabled, removed, or Made-for-Kids when
 *               that optional yt-dlp metadata is present
 *   unknown  -> throttled, network/runtime/parser error, or active backoff
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
export const YOUTUBE_OEMBED_TIMEOUT_MS = 8_000;

/** Bound ledger reads when one caption-ready asset is stale for this horse. */
export const MAX_VIDEO_CAPTION_CANDIDATES = 6;
/** Bound live verifier work in the ordinary mixed publisher. */
export const MAX_LIVE_VIDEO_CANDIDATES = 3;

/** Randomised without replacement, so one bad/stale clip cannot monopolise an attempt. */
function takeRandomCandidates<T>(rows: readonly T[], limit: number): T[] {
  const remaining = [...rows];
  const selected: T[] = [];
  while (selected.length < limit && remaining.length > 0) {
    const index = Math.floor(Math.random() * remaining.length);
    selected.push(remaining.splice(index, 1)[0]!);
  }
  return selected;
}

/**
 * Per-run supply telemetry, surfaced in the route's result JSON so a run
 * that publishes nothing says WHY in cron_execution_log. Added after eight
 * hourly fires (11:10 to 19:10, 2026-09-05) reported "No valid sports clips
 * found" while every sampled clip answered 200 from inside the container:
 * the statuses seen during the burst were never recorded anywhere.
 */
const supplyStats: Record<string, number> = {};
export function bumpSupplyStat(key: string, amount = 1): void {
  supplyStats[key] = (supplyStats[key] ?? 0) + amount;
}
export function takeSupplyStats(): Record<string, number> {
  const out = {
    ...supplyStats,
    ...takeModelWriterStats(),
    oembed_backoff_active: Date.now() < oembedBackoffUntil ? 1 : 0,
  };
  for (const k of Object.keys(supplyStats)) delete supplyStats[k];
  return out;
}

/**
 * Build one immutable verification snapshot for the whole scheduled run.
 *
 * Each enabled category costs one bounded pool read and one service-role RPC,
 * regardless of whether 1 or 80 horses are due. Only fresh positive registry
 * rows survive into the snapshot. No YouTube/oEmbed/yt-dlp call exists on
 * this path.
 */
export async function prepareSharedHorseVideoSupply(
  allowedTypes: readonly HorseVideoTopic[],
): Promise<PreparedSharedHorseVideoSupply> {
  const requested = [...new Set(allowedTypes)].filter(
    (kind): kind is HorseVideoTopic => kind === 'poker' || kind === 'sports',
  );
  const supply: SharedHorseVideoSupply = { poker: [], sports: [] };
  const counts: Partial<Record<HorseVideoTopic, SharedHorseVideoSupplyCount>> = {};

  try {
    const pools = await Promise.all(requested.map(async (kind) => ({
      kind,
      pool: await platformCandidateClips(kind),
    })));
    for (const { kind, pool } of pools) {
      if (pool.status === 'unknown') {
        return { status: 'unknown', error: `${kind}: ${pool.error}` };
      }
      const canonical = pool.clips.filter((clip) => (
        /^[A-Za-z0-9_-]{11}$/.test(clip.video_id)
        && assetKeyFor(clip.source_url) === `yt:${clip.video_id}`
      ));
      const lookup = await readFreshSharedYouTubeVerificationIds(
        canonical.map((clip) => clip.video_id),
      );
      if (lookup.status === 'unknown') {
        return { status: 'unknown', error: `${kind}: ${lookup.error}` };
      }
      const verified = canonical.filter((clip) => lookup.videoIds.has(clip.video_id));
      const captionable = verified.filter((clip) => isCaptionableSharedVideoClip(clip, kind));
      supply[kind] = captionable;
      counts[kind] = {
        scanned: canonical.length,
        verified: verified.length,
        captionable: captionable.length,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'unknown', error: `shared video supply outcome unknown: ${message}` };
  }

  return {
    status: 'ok',
    supply,
    availableTypes: requested.filter((kind) => supply[kind].length > 0),
    counts,
  };
}

/**
 * Availability proof and caption grounding are separate contracts.
 *
 * A fresh public YouTube verdict proves that an embed can play; it does not
 * turn scraper placeholders such as "Keyboard shortcuts" into a subject a
 * horse can discuss. Keep that distinction at preflight so unsupported
 * metadata cannot consume every horse's six-draft quality loop.
 */
export function isCaptionableSharedVideoClip(
  clip: SupplyClip,
  topic: HorseVideoTopic,
): boolean {
  return hasSpecificTake(briefForAsset({
    kind: 'video',
    title: clip.title,
    source: clip.source,
    domainHint: topic,
    sportHint: clip.category,
  }));
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
  const verificationStartedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('youtube_oembed_timeout')),
    YOUTUBE_OEMBED_TIMEOUT_MS,
  );
  timeout.unref?.();
  try {
    const response = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
        signal: controller.signal,
      },
    );
    bumpSupplyStat(`yt_http_${response.status}`);
    if (response.status === 429 || response.status >= 500) {
      oembedBackoffUntil = Date.now() + OEMBED_BACKOFF_MS;
      console.warn(`[horse-publisher] YouTube oEmbed ${response.status}; backing off 15 minutes`);
      return 'unknown';
    }
    if (response.status === 403) {
      // A 403 cannot distinguish one video's embed policy from an IP-level
      // block. It is never durable evidence that a clip is dead; repeated
      // 403s only activate backoff so the fleet stops amplifying the block.
      consecutive403 += 1;
      if (consecutive403 >= 3) {
        oembedBackoffUntil = Date.now() + OEMBED_BACKOFF_MS;
        console.warn('[horse-publisher] YouTube oEmbed 403 x3; treating as a block, backing off 15 minutes');
      }
      return 'unknown';
    }
    consecutive403 = 0;
    let v: YtValidity;
    if (!response.ok) {
      v = 'bad';
      if (response.status === 401 || response.status === 404) {
        await recordYouTubeVerification(
          videoId,
          response.status === 401 ? 'embed_disabled' : 'unavailable',
          verificationStartedAt,
        );
      }
    } else {
      const body = (await response.json()) as { html?: string; title?: string };
      if (body.title && body.title.trim()) oembedTitles.set(key, body.title.trim());
      v = body.html && body.html.includes('iframe') ? 'ok' : 'bad';
      if (v === 'ok') {
        // oEmbed cannot distinguish a free public clip from Premium,
        // members-only, sign-in, age, or region gates. The pinned yt-dlp
        // runtime asks for metadata only (`--skip-download`) and must agree
        // before the shared registry may record a positive verdict.
        const metadata = await verifyYouTubeMetadata(videoId);
        bumpSupplyStat(`yt_metadata_${metadata.reason.replace(/[^0-9a-z]+/gi, '_').slice(0, 48)}`);
        if (metadata.verdict === 'unknown') {
          if (/^(?:yt_dlp_(?:transient_failure|timeout|execution_error|self_check_timeout|runtime_unavailable|version_mismatch))$/.test(metadata.reason)) {
            oembedBackoffUntil = Date.now() + OEMBED_BACKOFF_MS;
            bumpSupplyStat('yt_metadata_backoff_started');
            console.warn('[horse-publisher] YouTube metadata probe unavailable; backing off 15 minutes');
          }
          return 'unknown';
        }
        if (metadata.verdict !== 'verified') {
          await recordYouTubeVerification(
            videoId,
            metadata.verdict,
            verificationStartedAt,
          );
          v = 'bad';
        }
      }
      if (v === 'ok') {
        const recorded = await recordYouTubeVerification(
          videoId,
          'verified',
          verificationStartedAt,
        );
        if (!recorded) {
          bumpSupplyStat('yt_shared_verdict_failed');
          return 'unknown';
        }
      } else if (body.html?.includes('iframe') !== true) {
        await recordYouTubeVerification(videoId, 'embed_disabled', verificationStartedAt);
      }
    }
    validityCache.set(key, { v, at: Date.now() });
    return v;
  } catch (e) {
    bumpSupplyStat(controller.signal.aborted ? 'yt_timeout_unknown' : 'yt_fetch_error');
    console.warn('[horse-publisher] YouTube oEmbed fetch error:', e instanceof Error ? e.message : e);
    return 'unknown';
  } finally {
    clearTimeout(timeout);
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

export type RecentPostGuard = 'clear' | 'posted_recently' | 'guard_unreadable';

/**
 * Has this horse posted inside the guard window?
 *
 * FAILS CLOSED. Until 2026-09-21 a failed read answered "no" and the post
 * went ahead, so a database blip was the one moment the guard vanished. An
 * unreadable guard now answers 'guard_unreadable'; the caller skips the horse
 * and counts the reason.
 */
export async function recentPostGuard(
  profileId: string,
  hours = RECENT_POST_GUARD_HOURS,
): Promise<RecentPostGuard> {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  try {
    const { data, error } = await getSupabase()
      .from('social_posts')
      .select('id')
      .eq('author_id', profileId)
      .gte('created_at', since)
      .limit(1);
    if (error) {
      console.warn('[horse-publisher] recent-post guard read failed; skipping the horse:', error.message);
      return 'guard_unreadable';
    }
    return (data ?? []).length > 0 ? 'posted_recently' : 'clear';
  } catch (e) {
    console.warn('[horse-publisher] recent-post guard read threw; skipping the horse:', e instanceof Error ? e.message : e);
    return 'guard_unreadable';
  }
}

/**
 * True when the horse must not post now: it posted inside the window, or the
 * window could not be read. Phase 6 imports this and gets the same answer.
 */
export async function postedRecently(profileId: string, hours = RECENT_POST_GUARD_HOURS): Promise<boolean> {
  return (await recentPostGuard(profileId, hours)) !== 'clear';
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

export async function publishVideoClip(
  horse: FleetHorse,
  clipType: 'poker' | 'sports',
  fleet: AuthorHorse[],
  scheduler = 'fleet',
  sharedSupply?: SharedHorseVideoSupply,
  /**
   * The fleet slot key for metadata.publication_key (fleetPublicationKey).
   * Both producers pass it: the fleet path (publishForHorse) and the isolated
   * horse-video-reels publisher (publishVideoForHorse) name the same
   * FleetScheduler slot, so one horse gets one post per slot across both. A
   * video write without it is refused before the RPC.
   */
  publicationKey?: string,
  sharedSupplyError?: string,
  modelAttemptContext?: ModelAttemptContext,
): Promise<PublishResult> {
  const base = { horse: horse.name, profile_id: horse.profile_id };
  if (!(await postModeEnabled(`${clipType}_video`))) {
    return {
      ...base,
      success: false,
      skipped: 'mode_disabled',
      publicationKey,
      error: `${clipType}_video awaits approval`,
    };
  }
  if (sharedSupplyError) {
    return { ...base, success: false, outcome: 'unknown', error: sharedSupplyError };
  }
  let captionCandidates: Array<LibraryClip | SportsClipRow> = [];

  if (sharedSupply) {
    const verifiedCaptionable = sharedSupply[clipType];
    if (!verifiedCaptionable.length) {
      return {
        ...base,
        success: false,
        ...(scheduler === 'fleet' ? { skipped: 'supply_exhausted' as const, publicationKey } : {}),
        error: `No fresh public verified caption-ready ${clipType} clips in supply`,
      };
    }

    const ledgerFailuresBefore = ledgerReadFailureTotal();
    const sourceNames = [...new Set(verifiedCaptionable.map((candidate) => candidate.source).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    const mine = new Set(sliceForHorse(sourceNames, horse.profile_id));
    const preferred = verifiedCaptionable.filter((candidate) => mine.has(candidate.source));
    const freshFrom = async (rows: SupplyClip[]) => {
      const keys = rows.map((candidate) => assetKeyFor(candidate.source_url)).filter(Boolean) as string[];
      const usable = await filterUnusedAssets(keys, horse.profile_id);
      return rows.filter((candidate) => {
        const key = assetKeyFor(candidate.source_url);
        return !!key
          && usable.has(key)
          && isCaptionableSharedVideoClip(candidate, clipType);
      });
    };
    let fresh = preferred.length ? await freshFrom(preferred) : [];
    if (!fresh.length && preferred.length !== verifiedCaptionable.length) {
      fresh = await freshFrom(verifiedCaptionable);
      bumpSupplyStat(`${clipType}_widened_to_verified_platform`);
    }
    if (!fresh.length) {
      if (ledgerReadFailureTotal() > ledgerFailuresBefore) {
        return {
          ...base,
          success: false,
          outcome: 'unknown',
          error: `Shared ${clipType} asset ledger unavailable`,
        };
      }
      return {
        ...base,
        success: false,
        ...(scheduler === 'fleet' ? { skipped: 'supply_exhausted' as const, publicationKey } : {}),
        error: `All ${clipType} verified clips already posted`,
      };
    }
    const offset = Math.floor(Math.random() * fresh.length);
    captionCandidates = Array.from(
      { length: Math.min(MAX_VIDEO_CAPTION_CANDIDATES, fresh.length) },
      (_, index) => fresh[(offset + index) % fresh.length]!,
    );
    bumpSupplyStat(`${clipType}_shared_verified_selected`);
  } else if (clipType === 'poker') {
    // Phase 4: poker draws from `poker_clips` - the horse's own slice of the
    // source registry first, the whole pool only if that slice is thin. The
    // 150-literal ClipLibrary.ts array this replaced was used 114 deep in one
    // week and had 36 dead videos in it; see ClipSupply.ts for the numbers.
    const { clips: pool, widened } = await candidateClips('poker', horse.profile_id);
    if (widened) bumpSupplyStat('poker_widened_to_platform');
    if (!pool.length) return { ...base, success: false, error: 'No poker clips in supply' };

    const ledgerFailuresBefore = ledgerReadFailureTotal();
    const keys = pool.map((c) => assetKeyFor(c.source_url)).filter(Boolean) as string[];
    const usable = await filterUnusedAssets(keys, horse.profile_id);
    const fresh = pool.filter((c) => {
      const k = assetKeyFor(c.source_url);
      return !!k && usable.has(k);
    });
    bumpSupplyStat(
      'poker_fresh_candidates_' + (fresh.length >= 50 ? '50plus' : fresh.length >= 10 ? '10to49' : 'under10'),
    );
    if (!fresh.length) {
      if (ledgerReadFailureTotal() > ledgerFailuresBefore) {
        return { ...base, success: false, error: 'All poker clips already posted (asset ledger unreadable)' };
      }
      return {
        ...base, success: false, skipped: 'supply_exhausted', publicationKey,
        error: 'All poker clips already posted',
      };
    }

    // Validate lazily in the caption loop. If the first playable clip has no
    // fresh grounded caption, the next distinct clip gets a chance without
    // probing more than the same three live candidates used before.
    captionCandidates = takeRandomCandidates(fresh, MAX_LIVE_VIDEO_CANDIDATES);
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
      const { data, error } = await supa
        .from('sports_clips')
        .select('*')
        .in('source', assigned)
        .order('created_at', { ascending: false })
        .limit(400);
      if (error) bumpSupplyStat('sports_assigned_pool_unreadable');
      if (data?.length) clips = data as SportsClipRow[];
    }
    const ledgerFailuresBefore = ledgerReadFailureTotal();
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
      const { data, error } = await supa
        .from('sports_clips')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(600);
      if (error) {
        return {
          ...base,
          success: false,
          outcome: 'unknown',
          error: `sports clip supply unavailable: ${error.message}`,
        };
      }
      if (data?.length) fresh = await freshOf(data as SportsClipRow[]);
      bumpSupplyStat('sports_widened_to_platform');
    }
    if (!fresh.length) {
      if (ledgerReadFailureTotal() > ledgerFailuresBefore) {
        return { ...base, success: false, error: 'All sports clips already posted (asset ledger unreadable)' };
      }
      return {
        ...base, success: false, skipped: 'supply_exhausted', publicationKey,
        error: 'All sports clips already posted',
      };
    }
    bumpSupplyStat('sports_fresh_candidates_' + (fresh.length >= 50 ? '50plus' : fresh.length >= 10 ? '10to49' : 'under10'));

    // As with poker, verification stays bounded and lazy so caption reuse on
    // one valid clip can advance to another distinct candidate.
    captionCandidates = takeRandomCandidates(fresh, MAX_LIVE_VIDEO_CANDIDATES);
  }

  // Both scheduled producers carry a bounded candidate sequence from the
  // shared proof snapshot into the caption gate. Direct callers that omit a
  // snapshot retain the bounded live-verifier fallback.

  // Fail closed: a video write without its slot key would sit outside the
  // duplicate protection every other scheduled post carries, whichever
  // producer is writing.
  if (!publicationKey) {
    return { ...base, success: false, error: `${scheduler} video publication requires a slot key` };
  }

  await seedMemoryFromHistory(horse.profile_id);

  let belowFloor = 0;
  let stale = 0;
  let missingSemantic = 0;
  let semanticReuse = 0;
  let invalidVideo = 0;
  let verificationUnknown = 0;
  const modelAttempt = modelAttemptContext ?? {};
  for (const candidate of captionCandidates) {
    bumpSupplyStat(`${clipType}_caption_candidate_attempted`);

    if (!sharedSupply) {
      const verdict = await youtubeValidity(candidate.source_url);
      if (verdict !== 'ok') {
        if (verdict === 'bad') {
          invalidVideo += 1;
          bumpSupplyStat(`${clipType}_clip_invalid_on_use`);
          if (clipType === 'poker') {
            const candidateId = (candidate as LibraryClip).id;
            if (candidateId) {
              await recordValidity(candidateId, false);
              bumpSupplyStat('poker_clip_retired_on_use');
            }
          }
        } else {
          verificationUnknown += 1;
          bumpSupplyStat(`${clipType}_clip_unknown_on_use`);
        }
        continue;
      }
    }

    // Phase 2: the caption is written from a brief of THIS clip - its title,
    // channel and sport - not drawn from a pool keyed on a category. See
    // PostBrief.ts for what the old path produced.
    // Prefer the title YouTube just gave us over the one the scraper stored,
    // and repair the row while we are here (self-healing, bounded, one write).
    const storedTitle = (candidate as LibraryClip).title || '';
    const realTitle = cachedOembedTitle(candidate.source_url);
    let title = storedTitle;
    if (realTitle && isUninformativeTitle(storedTitle, (candidate as SportsClipRow).source ?? undefined)
        && !isUninformativeTitle(realTitle, (candidate as SportsClipRow).source ?? undefined)) {
      title = realTitle;
      if (clipType === 'sports' && (candidate as SportsClipRow).id) {
        const { error: fixErr } = await getSupabase()
          .from('sports_clips')
          .update({ title: realTitle })
          .eq('id', (candidate as SportsClipRow).id);
        if (fixErr) console.warn('[horse-publisher] title repair failed:', fixErr.message);
        else bumpSupplyStat('title_repaired');
      }
    }
    const key = assetKeyFor(candidate.source_url);
    if (!key?.startsWith('yt:')) {
      return { ...base, success: false, error: 'Selected video has no canonical YouTube identity' };
    }
    const written = await writeCaption(
      horse as AuthorHorse,
      {
        kind: 'video',
        title,
        source: (candidate as SportsClipRow).source ?? undefined,
        domainHint: clipType,
        sportHint: (candidate as SportsClipRow).sport_type ?? (candidate as LibraryClip).category ?? null,
      },
      fleet,
      { modelIdempotencyKey: captionModelIdempotencyKey(publicationKey, key), modelAttempt },
    );
    if (!written.text) {
      if (written.belowFloor) {
        belowFloor += 1;
        bumpSupplyStat(`${clipType}_caption_below_floor`);
      } else {
        stale += 1;
        bumpSupplyStat(`${clipType}_caption_stale`);
      }
      continue;
    }
    if (!written.semanticKey) {
      missingSemantic += 1;
      bumpSupplyStat(`${clipType}_caption_missing_semantic`);
      continue;
    }
    const picked = { text: written.text, norm: normalizePhrase(written.text), collided: written.stale };

    const published = await publishHorseVideoAtomically({
      authorId: horse.profile_id,
      videoUrl: candidate.source_url,
      caption: picked.text,
      topic: clipType,
      assetKey: key,
      phraseNorm: picked.norm,
      semanticKey: written.semanticKey,
      metadata: {
        clip_type: clipType,
        clip_id: (candidate as SportsClipRow).id ?? (candidate as LibraryClip).video_id,
        clip_source: (candidate as SportsClipRow).source ?? null,
        scheduler,
        // Durable slot protection. publish_horse_video_reel merges p_metadata
        // into the row, so the key lands where the unique index on
        // metadata->>'publication_key' reads it; an overlapping run of either
        // producer raises 23505 inside the RPC. The reserved column is never set.
        publication_key: publicationKey,
      },
    });
    // Another run already published this horse's slot: the slot index
    // raised 23505 inside the RPC, whose transaction rolled back, so no
    // ledger row exists for this attempt. A duplicate, not a failure.
    if (!published.success && isDuplicateSlotPublication(published)) {
      return { ...base, success: false, skipped: 'duplicate_slot', publicationKey };
    }
    // The RPC transaction rolled back on this definite semantic-ledger guard,
    // so a different bounded candidate is safe. This is the only database
    // rejection that may advance: a failed acknowledgement may hide a commit,
    // and every unrelated rejection remains terminal.
    if (!published.success && isSemanticReusePublication(published)) {
      semanticReuse += 1;
      bumpSupplyStat(`${clipType}_caption_semantic_reuse`);
      continue;
    }
    if (!published.success || !published.postId || !published.reelId) {
      return {
        ...base,
        success: false,
        outcome: published.outcome,
        error: published.error ?? 'Atomic horse video publication failed',
      };
    }
    await recordBrief(published.postId, written.brief);
    return {
      ...base,
      success: true,
      postId: published.postId,
      reelId: published.reelId,
      created: published.created,
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

  if (verificationUnknown > 0) {
    return {
      ...base,
      success: false,
      outcome: 'unknown',
      error: `Video verification unavailable before candidate exhaustion (candidates=${captionCandidates.length}, unknown=${verificationUnknown}, invalid=${invalidVideo})`,
    };
  }
  if (invalidVideo === captionCandidates.length && captionCandidates.length > 0) {
    return {
      ...base,
      success: false,
      skipped: 'supply_exhausted',
      publicationKey,
      error: `No valid ${clipType} clips found after ${captionCandidates.length} bounded candidates`,
    };
  }
  return {
    ...base,
    success: false,
    skipped: 'caption_exhausted',
    publicationKey,
    error: `No fresh caption cleared the quality gate (candidates=${captionCandidates.length}, below_floor=${belowFloor}, stale=${stale}, missing_semantic=${missingSemantic}, semantic_reuse=${semanticReuse})`,
  };
}

/** A stable video preference order for one horse and UTC day. */
export function videoKindOrder(
  profileId: string,
  now: Date,
  allowed: readonly HorseVideoTopic[],
): HorseVideoTopic[] {
  const unique = [...new Set(allowed)].filter(
    (kind): kind is HorseVideoTopic => kind === 'poker' || kind === 'sports',
  );
  if (unique.length < 2) return unique;
  const roll = (fleetHash(`${profileId}:${now.toISOString().slice(0, 10)}`, 'video-kind') % 10_000) / 10_000;
  const preferred: HorseVideoTopic = roll < sportsShareFor(profileId) ? 'sports' : 'poker';
  return preferred === 'sports' ? ['sports', 'poker'] : ['poker', 'sports'];
}

/**
 * Publish only an approved poker or sports video for a horse.
 *
 * This entry point does not read the master mixed-content engine switch. It
 * is intentionally safe for the isolated `/cron/horse-video-reels` route:
 * both video modes fail closed, and there is no news or grounded fallback.
 *
 * `slot` is the FleetScheduler slot the caller found the horse due for
 * (fleetSlotId), the same slot the fleet route names for the same horse at
 * the same time. The write carries fleetPublicationKey(profile, slot) in
 * p_metadata, so when both producers are on, the second insert for one
 * horse's slot fails on the publication-key index and is counted as a
 * duplicate, not published twice. Without an open slot nothing is read or
 * written: a post without a slot key has no durable duplicate protection.
 */
export async function publishVideoForHorse(
  horse: FleetHorse,
  opts: {
    fleet?: AuthorHorse[];
    now?: Date;
    skipGuard?: boolean;
    allowedTypes?: HorseVideoTopic[];
    sharedSupply?: SharedHorseVideoSupply;
    slot?: string | null;
  } = {},
): Promise<PublishResult> {
  const base = { horse: horse.name, profile_id: horse.profile_id };
  const slot = opts.slot ?? fleetSlotId(horse.profile_id, horse.timezone, opts.now ?? new Date());
  if (!slot) return { ...base, success: false, skipped: 'no_slot' };
  const publicationKey = fleetPublicationKey(horse.profile_id, slot);
  if (!opts.skipGuard && (await postedRecently(horse.profile_id))) {
    return { ...base, success: false, skipped: 'posted_recently', publicationKey };
  }
  if (!opts.sharedSupply) {
    return {
      ...base,
      success: false,
      outcome: 'unknown',
      error: 'shared verified video supply unavailable',
    };
  }

  const requested = opts.allowedTypes ?? ['poker', 'sports'];
  const approved: HorseVideoTopic[] = [];
  for (const kind of requested) {
    if (await postModeEnabled(`${kind}_video`)) approved.push(kind);
  }
  if (!approved.length) {
    return { ...base, success: false, error: 'All horse video modes await approval' };
  }

  const errors: string[] = [];
  const captionExhaustions: string[] = [];
  const modelAttempt: ModelAttemptContext = {};
  for (const kind of videoKindOrder(horse.profile_id, opts.now ?? new Date(), approved)) {
    const result = await publishVideoClip(
      horse,
      kind,
      opts.fleet ?? [],
      'horse-video-reels',
      opts.sharedSupply,
      publicationKey,
      undefined,
      modelAttempt,
    );
    if (result.success) return result;
    if (result.skipped === 'caption_exhausted') {
      captionExhaustions.push(`${kind}_video: ${result.error ?? 'caption candidates exhausted'}`);
      continue;
    }
    if (result.skipped) return result;
    // A lost RPC acknowledgement may already represent a committed post.
    // Do not try the alternate topic in the same run or relabel uncertainty
    // as a definite failure; the durable author/asset retry owns recovery.
    if (result.outcome === 'unknown') return result;
    errors.push(`${kind}_video: ${result.error ?? 'failed'}`);
  }
  if (errors.length === 0 && captionExhaustions.length > 0) {
    return {
      ...base,
      success: false,
      skipped: 'caption_exhausted',
      publicationKey,
      error: captionExhaustions.join(' | '),
    };
  }
  errors.unshift(...captionExhaustions);
  return { ...base, success: false, error: errors.join(' | ') };
}

async function postNewsLink(
  horse: FleetHorse,
  newsType: 'poker' | 'sports',
  fleet: AuthorHorse[],
  publicationKey: string,
  modelAttempt: ModelAttemptContext,
): Promise<PublishResult> {
  const base = { horse: horse.name, profile_id: horse.profile_id };

  // The registry first. A failed READ falls back to the literals so a horse
  // does not go silent because Postgres blinked; an EMPTY registry is a real
  // answer and falls back too, because no feeds registered still means this
  // horse has something to say.
  const registered = await newsSources(newsType);
  let candidates: Array<{ name: string; rss: string }>;
  if (registered && registered.length) {
    // Each horse reads its own slice of the feeds, the same way it draws its
    // own slice of channels: a thousand horses all quoting CardPlayer is the
    // repetition this phase exists to end.
    const mine = sliceForHorse(registered, horse.profile_id, Math.min(3, registered.length));
    candidates = mine.map((r) => ({ name: r.name, rss: r.feed_url }));
    bumpSupplyStat('news_from_registry');
  } else {
    candidates = FALLBACK_NEWS_SOURCES[newsType];
    bumpSupplyStat(registered ? 'news_registry_empty' : 'news_registry_unreadable');
  }
  const source = candidates[fleetHash(horse.profile_id, `news:${newsType}`) % candidates.length]!;

  try {
    const articles = (await fetchFeed(source.rss)).slice(0, 20).flatMap((article) => {
      const link = safeArticleUrl(article.link);
      return link ? [{ ...article, link }] : [];
    });
    if (!articles.length) {
      return { ...base, success: false, skipped: 'supply_exhausted', publicationKey, error: 'No articles' };
    }

    const keys = articles.map((a) => assetKeyFor(a.link)).filter(Boolean) as string[];
    const ledgerFailuresBefore = ledgerReadFailureTotal();
    const usable = await filterUnusedAssets(keys, horse.profile_id);
    const fresh = articles.filter((a) => {
      const k = assetKeyFor(a.link);
      return !!k && usable.has(k);
    });
    if (!fresh.length) {
      if (ledgerReadFailureTotal() > ledgerFailuresBefore) {
        return { ...base, success: false, error: 'All articles already posted (asset ledger unreadable)' };
      }
      return {
        ...base, success: false, skipped: 'supply_exhausted', publicationKey,
        error: 'All articles already posted',
      };
    }

    const article = fresh[Math.floor(Math.random() * fresh.length)]!;
    const articleImage = extractArticleImageUrl(article);
    await seedMemoryFromHistory(horse.profile_id);

    const articleKey = assetKeyFor(article.link);
    if (!articleKey) {
      return { ...base, success: false, error: 'Selected article has no canonical asset identity' };
    }
    const written = await writeCaption(
      horse as AuthorHorse,
      { kind: 'link', title: article.title ?? '', source: source.name, domainHint: newsType },
      fleet,
      { modelIdempotencyKey: captionModelIdempotencyKey(publicationKey, articleKey), modelAttempt },
    );
    if (!written.text) {
      return {
        ...base,
        success: false,
        skipped: 'caption_exhausted',
        publicationKey,
        error: 'No fresh caption cleared the quality gate',
      };
    }
    const picked = { text: written.text, norm: normalizePhrase(written.text), collided: written.stale };
    const content = `${picked.text}\n\n${article.link}`;

    if (!written.semanticKey) {
      return { ...base, success: false, error: 'Caption cleared without a semantic freshness key' };
    }
    const published = await publishHorseNewsAtomically({
      authorId: horse.profile_id,
      content,
      linkUrl: article.link,
      linkTitle: article.title ?? '',
      linkImage: articleImage,
      linkSiteName: source.name,
      newsType,
      publicationKey,
      assetKey: articleKey,
      phraseNorm: picked.norm,
      semanticKey: written.semanticKey,
      brief: written.brief,
    });
    if (!published.success) {
      if (published.reason === 'already_published' || published.reason === 'duplicate_slot') {
        return { ...base, success: false, skipped: 'duplicate_slot', publicationKey };
      }
      if (published.reason === 'posted_recently') {
        return { ...base, success: false, skipped: 'posted_recently', publicationKey };
      }
      if (published.reason === 'asset_used') {
        return { ...base, success: false, skipped: 'supply_exhausted', publicationKey, error: 'Article became used before publication' };
      }
      if (published.reason === 'phrase_used') {
        return { ...base, success: false, skipped: 'caption_exhausted', publicationKey, error: 'Caption became used before publication' };
      }
      return {
        ...base,
        success: false,
        outcome: published.outcome,
        error: published.error ?? 'Atomic horse news publication failed',
      };
    }
    const postId = published.postId!;
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
async function postGrounded(horse: FleetHorse, publicationKey: string): Promise<PublishResult> {
  // Hand and session posts are separate ways of posting and therefore need
  // separate approval. The old implementation checked grounded_hand once,
  // then silently fell through to the unrevised session writer when no hand
  // existed. Approving hands must never approve sessions by accident.
  const handEnabled = await postModeEnabled('grounded_hand');
  const sessionEnabled = await postModeEnabled('grounded_session');
  if (!handEnabled && !sessionEnabled) {
    return {
      horse: horse.name,
      profile_id: horse.profile_id,
      success: false,
      skipped: 'mode_disabled',
      publicationKey,
      error: 'grounded modes await approval',
    };
  }
  const base = { horse: horse.name, profile_id: horse.profile_id };
  const written = await writeGrounded(horse as AuthorHorse, { hand: handEnabled, session: sessionEnabled });
  if (!written || !written.text) {
    return {
      ...base,
      success: false,
      skipped: 'caption_exhausted',
      publicationKey,
      error: 'No approved grounded story worth telling',
    };
  }
  const groundedType = written.groundedKind ?? 'hand';

  const { data: post, error } = await getSupabase()
    .from('social_posts')
    .insert({
      author_id: horse.profile_id,
      content: written.text,
      content_type: 'text',
      visibility: 'public',
      ...topicsFor(groundedType === 'session' ? 'grounded_session' : 'grounded_hand'),
      metadata: {
        clip_type: 'poker',
        scheduler: 'fleet',
        grounded: true,
        grounded_type: groundedType,
        grounding: written.grounding,
        publication_key: publicationKey,
      },
    })
    .select('id')
    .maybeSingle();

  if (isDuplicateSlot(error)) return { ...base, success: false, skipped: 'duplicate_slot', publicationKey };
  if (error) return { ...base, success: false, error: error.message };
  const postId = (post as { id: string } | null)?.id ?? null;
  await recordPhrase(normalizePhrase(written.text), horse.profile_id, postId);
  if (written.semanticKey) await recordPhrase(written.semanticKey, horse.profile_id, postId);
  // The skeleton is ledgered as well as the sentence. Two horses telling
  // different hands through the same frame is the repetition a reader
  // actually notices, and the cards hide it from the phrase ledger.
  if (written.frameKey) await recordPhrase(written.frameKey, horse.profile_id, postId);
  if (postId) await recordBrief(postId, written.brief);
  return {
    ...base,
    success: true,
    postId: postId ?? undefined,
    type: `grounded_${groundedType}`,
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
 *
 * `slot` is the FleetScheduler slot the caller found the horse due for
 * (fleetSlotId). Without one the slot is worked out from the clock, and a
 * horse with no open slot does not post: a post without a slot key has no
 * durable duplicate protection.
 */
export async function publishForHorse(
  horse: FleetHorse,
  opts: {
    skipGuard?: boolean;
    fleet?: AuthorHorse[];
    slot?: string | null;
    sharedVideoSupply?: SharedHorseVideoSupply;
    sharedVideoSupplyError?: string;
  } = {},
): Promise<PublishResult> {
  const base = { horse: horse.name, profile_id: horse.profile_id };
  const slot = opts.slot ?? fleetSlotId(horse.profile_id, horse.timezone, new Date());
  if (!slot) return { ...base, success: false, skipped: 'no_slot' };
  const publicationKey = fleetPublicationKey(horse.profile_id, slot);
  if (!opts.skipGuard) {
    const guard = await recentPostGuard(horse.profile_id);
    if (guard !== 'clear') return { ...base, success: false, skipped: guard, publicationKey };
  }

  // Phase 4: how much sport this horse posts is a trait of the horse, not a
  // constant in the code. `Math.random() < 0.75` gave every one of a thousand
  // horses the same appetite, so the fleet's mix was a property of this line
  // rather than of the characters; see sportsShareFor().
  let isPoker = Math.random() >= sportsShareFor(horse.profile_id);
  try {
    const { data: lastPosts } = await getSupabase()
      .from('social_posts')
      .select('metadata')
      .eq('author_id', horse.profile_id)
      .order('created_at', { ascending: false })
      .limit(6);
    const types = ((lastPosts ?? []) as { metadata: Record<string, unknown> | null }[])
      .map((p) => (p.metadata?.clip_type ?? p.metadata?.news_type) as string | undefined)
      .filter((t): t is 'poker' | 'sports' => t === 'poker' || t === 'sports');
    if (types.length >= 6 && types.every((t) => t === 'poker')) isPoker = false;
    else if (types.length >= 3 && types.slice(0, 3).every((t) => t === 'sports')) isPoker = true;
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
  const exhaustions: string[] = [];
  const modelAttempt: ModelAttemptContext = {};
  const recordAttempt = (label: string, result: PublishResult): 'continue' | 'return' => {
    if (
      result.skipped === 'caption_exhausted'
      || result.skipped === 'supply_exhausted'
      || result.skipped === 'mode_disabled'
    ) {
      exhaustions.push(`${label}: ${result.error ?? result.skipped}`);
      return 'continue';
    }
    return 'return';
  };

  // Phase 3: the horse's own poker.
  //
  // Grounded posts cannot repeat and cannot be about nothing - two horses did
  // not play the same hand, and there are 204,474 of them a week across the
  // fleet. They lead most of the time, but not always: a feed of nothing but
  // hand recaps is its own kind of monotony, and the clips and articles give
  // it texture. The split is a hash of the horse and the day, so it is stable
  // across a retry and varies across the fleet.
  const groundedFirst = fleetHash(`${horse.profile_id}:${new Date().toISOString().slice(0, 10)}`, 'grounded') % 100 < 60;
  // A skip ends the attempt. A duplicate slot means another run already
  // published this horse's slot, and every other kind would collide on the
  // same key.
  if (groundedFirst) {
    const grounded = await postGrounded(horse, publicationKey);
    if (grounded.success) return grounded;
    if (grounded.skipped && recordAttempt('grounded', grounded) === 'return') return grounded;
    else if (!grounded.skipped) attempts.push(`grounded: ${grounded.error}`);
  }

  for (const kind of [preferred, other]) {
    let result = await postNewsLink(horse, kind, opts.fleet ?? [], publicationKey, modelAttempt);
    if (result.success) return result;
    if (result.skipped && recordAttempt(`${kind}_news`, result) === 'return') return result;
    // The RPC may have committed before its acknowledgement was lost. The
    // exact slot retry resolves that durable identity; no alternate kind may
    // publish behind an unknown news outcome in this invocation.
    if (result.outcome === 'unknown') return result;
    else if (!result.skipped) attempts.push(`${kind}_news: ${result.error}`);
    result = await publishVideoClip(
      horse,
      kind,
      opts.fleet ?? [],
      'fleet',
      opts.sharedVideoSupply,
      publicationKey,
      opts.sharedVideoSupplyError,
      modelAttempt,
    );
    if (result.success) return result;
    if (result.skipped && recordAttempt(`${kind}_video`, result) === 'return') return result;
    // The mixed publisher is disabled, but retain the same lost-ACK law if it
    // is ever re-enabled: an unknown atomic outcome may already be committed,
    // so no alternate category or grounded fallback may publish behind it.
    if (result.outcome === 'unknown') return result;
    if (!result.skipped) attempts.push(`${kind}_video: ${result.error}`);
  }

  // The media pools are exhausted for this horse. Its own poker is the
  // fallback that never is.
  if (!groundedFirst) {
    const grounded = await postGrounded(horse, publicationKey);
    if (grounded.success) return grounded;
    if (grounded.skipped && recordAttempt('grounded', grounded) === 'return') return grounded;
    else if (!grounded.skipped) attempts.push(`grounded: ${grounded.error}`);
  }

  if (attempts.length === 0 && exhaustions.length > 0) {
    return {
      ...base,
      success: false,
      skipped: 'content_exhausted',
      publicationKey,
      error: exhaustions.join(' | '),
    };
  }
  attempts.unshift(...exhaustions);
  return { ...base, success: false, error: attempts.join(' | ') };
}
