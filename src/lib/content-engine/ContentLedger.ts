/**
 * ContentLedger: what has been posted, in a table, not in a Set.
 *
 * WHY (2026-09-05). Dedup used to be two things and both forgot:
 *   - `social_posts ... gte(created_at, now-48h).limit(100)` with no order.
 *     With 100 posts a day the 48h window held ~200 rows and PostgREST
 *     returned an arbitrary hundred of them, so the same poker clip landed
 *     every other day: 133 clips carried 1,337 posts in thirty days.
 *   - HumanVoiceEngine's phrase memory, a process-local Map that resets on
 *     every deploy. One sports caption was published by 26 different horses.
 *
 * Two tables now hold the memory (World Hub migration
 * 20260905_content_ledgers.sql), and this module is the only writer:
 *
 *   content_asset_use(asset_key, horse_id, post_id, used_at)
 *     UNIQUE (asset_key, horse_id): one horse can never post one asset twice,
 *     enforced by the database, not by code that has to remember to check.
 *     Platform-wide reuse is a window (ASSET_GLOBAL_DAYS, 30 days: the rule
 *     the audit set, and with 150 poker clips anything longer empties the
 *     poker pool outright until Phase 4).
 *
 *   horse_phrase_ledger(phrase_norm, horse_id, post_id, used_at)
 *     Same caption never twice from one horse inside PHRASE_HORSE_DAYS, never
 *     twice on the platform inside PHRASE_GLOBAL_HOURS. The platform window
 *     is short on purpose in Phase 1: the caption pools are 13 to 21 lines
 *     and the fleet posts ~200 a day, so a 30-day global rule would exhaust
 *     every pool by breakfast. Phase 2 (grounded content) and Phase 3
 *     (per-horse voice) are what make the window long; this is what makes it
 *     measurable.
 *
 * Both ledgers were seeded from the last 90 days of horse posts by the
 * migration, so day one already remembers what August posted.
 */
import { getSupabase } from '../supabase.js';

export const ASSET_GLOBAL_DAYS = 30;
export const PHRASE_HORSE_DAYS = 90;
export const PHRASE_GLOBAL_HOURS = 48;

const YT_PATTERNS = [
  /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
  /youtube\.com\/watch\?(?:.*&)?v=([a-zA-Z0-9_-]{11})/,
  /youtu\.be\/([a-zA-Z0-9_-]{11})/,
  /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
];

/**
 * A stable key for an asset regardless of which URL form points at it.
 * YouTube: `yt:<id>` (watch, shorts, embed and youtu.be all collapse).
 * Anything else: scheme-less, lower-cased host + path, query stripped.
 */
export function assetKeyFor(url: string | null | undefined): string | null {
  if (!url) return null;
  for (const p of YT_PATTERNS) {
    const m = url.match(p);
    if (m) return `yt:${m[1]}`;
  }
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    return `url:${u.host.toLowerCase()}${path}`;
  } catch {
    return `raw:${url.trim().toLowerCase()}`;
  }
}

/** First line, lower-cased, punctuation and whitespace collapsed. */
export function normalizePhrase(text: string | null | undefined): string {
  if (!text) return '';
  const first = text.split('\n')[0] ?? '';
  return first
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Of the candidate keys, return the ones this horse has never used and the
 * platform has not used inside ASSET_GLOBAL_DAYS.
 *
 * Two bounded reads per chunk: rows inside the platform window (any horse),
 * and rows for this horse (any time). The first version read every row for
 * every key in the chunk, which for popular clips can exceed PostgREST's
 * 1,000-row page and silently drop the rows that matter (the recent ones).
 */
export async function filterUnusedAssets(
  keys: string[],
  horseId: string,
): Promise<Set<string>> {
  const unique = [...new Set(keys.filter(Boolean))];
  const usable = new Set(unique);
  if (unique.length === 0) return usable;
  const since = new Date(Date.now() - ASSET_GLOBAL_DAYS * 86_400_000).toISOString();
  const supa = getSupabase();
  for (let i = 0; i < unique.length; i += 150) {
    const chunk = unique.slice(i, i + 150);
    const [recent, mine] = await Promise.all([
      supa.from('content_asset_use').select('asset_key').in('asset_key', chunk).gte('used_at', since),
      supa.from('content_asset_use').select('asset_key').in('asset_key', chunk).eq('horse_id', horseId),
    ]);
    if (recent.error || mine.error) {
      // A ledger read failing must not stop the fleet; it degrades to the
      // pre-ledger behaviour for this call and says so.
      console.warn('[content-ledger] asset read failed:', recent.error?.message ?? mine.error?.message);
      continue;
    }
    for (const row of (recent.data ?? []) as { asset_key: string }[]) usable.delete(row.asset_key);
    for (const row of (mine.data ?? []) as { asset_key: string }[]) usable.delete(row.asset_key);
  }
  return usable;
}

export async function recordAssetUse(
  assetKey: string,
  horseId: string,
  postId: string | null,
): Promise<void> {
  const { error } = await getSupabase()
    .from('content_asset_use')
    .upsert(
      { asset_key: assetKey, horse_id: horseId, post_id: postId, used_at: new Date().toISOString() },
      { onConflict: 'asset_key,horse_id', ignoreDuplicates: true },
    );
  if (error) console.warn('[content-ledger] asset write failed:', error.message);
}

/**
 * True when the phrase was used by this horse inside PHRASE_HORSE_DAYS or by
 * any horse inside PHRASE_GLOBAL_HOURS.
 *
 * Two existence queries, not one page. The first version read 50 rows for
 * the phrase with no ORDER BY and looked for a recent one among them; a
 * caption from a 21-line pool has hundreds of ledger rows in 90 days, so the
 * page never contained today's and four captions repeated inside one run
 * on 2026-09-05 21:10 while the result claimed collided: 0. The same shape
 * of bug the audit found in the old 48h dedup.
 */
export async function phraseRecentlyUsed(phraseNorm: string, horseId: string): Promise<boolean> {
  if (!phraseNorm) return false;
  const supa = getSupabase();
  const globalSince = new Date(Date.now() - PHRASE_GLOBAL_HOURS * 3_600_000).toISOString();
  const horseSince = new Date(Date.now() - PHRASE_HORSE_DAYS * 86_400_000).toISOString();

  const recent = await supa
    .from('horse_phrase_ledger')
    .select('id')
    .eq('phrase_norm', phraseNorm)
    .gte('used_at', globalSince)
    .limit(1);
  if (recent.error) {
    console.warn('[content-ledger] phrase read failed:', recent.error.message);
    return false;
  }
  if ((recent.data ?? []).length > 0) return true;

  const mine = await supa
    .from('horse_phrase_ledger')
    .select('id')
    .eq('phrase_norm', phraseNorm)
    .eq('horse_id', horseId)
    .gte('used_at', horseSince)
    .limit(1);
  if (mine.error) {
    console.warn('[content-ledger] phrase read failed:', mine.error.message);
    return false;
  }
  return (mine.data ?? []).length > 0;
}

export async function recordPhrase(
  phraseNorm: string,
  horseId: string,
  postId: string | null,
): Promise<void> {
  if (!phraseNorm) return;
  const { error } = await getSupabase()
    .from('horse_phrase_ledger')
    .insert({ phrase_norm: phraseNorm, horse_id: horseId, post_id: postId });
  if (error) console.warn('[content-ledger] phrase write failed:', error.message);
}

/**
 * Call a caption generator until it yields a phrase the ledger has not seen,
 * up to `attempts` times. Returns the last candidate regardless, with a flag,
 * so the caller can publish and count the collision rather than go silent.
 */
export async function pickFreshPhrase(
  generate: () => string,
  horseId: string,
  attempts = 6,
): Promise<{ text: string; norm: string; collided: boolean }> {
  let text = '';
  let norm = '';
  for (let i = 0; i < attempts; i++) {
    text = generate();
    norm = normalizePhrase(text);
    if (!(await phraseRecentlyUsed(norm, horseId))) return { text, norm, collided: false };
  }
  return { text, norm, collided: true };
}
