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

interface AssetUseRow {
  asset_key: string;
  horse_id: string;
  used_at: string;
}

/**
 * Of the candidate keys, return the ones this horse has never used and the
 * platform has not used inside ASSET_GLOBAL_DAYS. Chunks the IN list so a
 * 200-clip candidate set is two requests, not one 8KB URL.
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
    const { data, error } = await supa
      .from('content_asset_use')
      .select('asset_key, horse_id, used_at')
      .in('asset_key', chunk);
    if (error) {
      // A ledger read failing must not stop the fleet; it degrades to the
      // pre-ledger behaviour for this call and says so.
      console.warn('[content-ledger] asset read failed:', error.message);
      continue;
    }
    for (const row of (data ?? []) as AssetUseRow[]) {
      if (row.horse_id === horseId || row.used_at >= since) usable.delete(row.asset_key);
    }
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
 */
export async function phraseRecentlyUsed(phraseNorm: string, horseId: string): Promise<boolean> {
  if (!phraseNorm) return false;
  const horseSince = new Date(Date.now() - PHRASE_HORSE_DAYS * 86_400_000).toISOString();
  const globalSince = new Date(Date.now() - PHRASE_GLOBAL_HOURS * 3_600_000).toISOString();
  const { data, error } = await getSupabase()
    .from('horse_phrase_ledger')
    .select('horse_id, used_at')
    .eq('phrase_norm', phraseNorm)
    .gte('used_at', horseSince)
    .limit(50);
  if (error) {
    console.warn('[content-ledger] phrase read failed:', error.message);
    return false;
  }
  for (const row of (data ?? []) as { horse_id: string; used_at: string }[]) {
    if (row.horse_id === horseId) return true;
    if (row.used_at >= globalSince) return true;
  }
  return false;
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
