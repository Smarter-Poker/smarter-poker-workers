/**
 * ClipSupply - where a horse's video comes from.
 *
 * WHAT THIS REPLACED, and the measurement that forced it (2026-09-06, seven
 * days of live fleet output):
 *
 *   sports:  285 posts drawn from 247 distinct clips   pool 8,271, scraped hourly
 *   poker:   245 posts drawn from 114 distinct clips   pool 150, a TypeScript array
 *
 * 114 of 150 in one week. The Phase 1 asset ledger then refuses each of them
 * for thirty days - correctly - which is why the very first hourly fleet fire
 * had 18 of 26 due horses fail with "All poker clips already posted" and fall
 * through to sports. That fallback is why a POKER platform posted more sports
 * than poker last week, 53.8% to 46.2%.
 *
 * And the pool was smaller than it looked: probing all 149 distinct ids
 * against YouTube oEmbed found 36 dead - 22 deleted or private, 14 with
 * embedding disabled. Every one was postable, because the only validity cache
 * was a Map in process memory that dies with the container. The real pool was
 * 113 clips against 245 posts a week.
 *
 * Poker now draws from `poker_clips`, the twin of `sports_clips`, filled by
 * the channel RSS scraper and revalidated on a schedule. Both domains draw
 * through the same function here, because the asymmetry - one supply scraped,
 * one hard-coded - is what produced the skew.
 */
import { getSupabase } from '../supabase.js';
import { fleetHash } from './FleetScheduler.js';

/** A clip as the publisher needs it, whichever table it came from. */
export interface SupplyClip {
  id: string;
  video_id: string;
  source_url: string;
  source: string;
  title: string;
  category: string;
  /** Cached oEmbed answer; null when never asked. */
  oembed_ok: boolean | null;
}

export interface SourceRow {
  id: string;
  name: string;
  handle: string | null;
  channel_id: string | null;
  category: string | null;
  sport: string | null;
  consecutive_failures: number;
}

/**
 * How many sources one horse draws from.
 *
 * Small enough that a horse has a recognisable taste - it is not a random
 * walk over ninety channels - and large enough that its own slice does not
 * run dry inside the thirty-day asset window.
 */
export const SOURCES_PER_HORSE = 8;

/**
 * The horse's own slice of the catalogue.
 *
 * Deterministic in the profile id, so it is the same slice on a retry, in a
 * test, and after a restart - and DIFFERENT across the fleet, which is the
 * point: a thousand horses drawing from one pool produce one feed, and a
 * reader notices that sameness long before they notice any single clip.
 *
 * BOTH the start and the stride come from the horse. A fixed stride would
 * make the slice a pure rotation of the catalogue, so only as many distinct
 * tastes could exist as there are sources - the first version of this did
 * exactly that and its own law test caught it: 200 horses over 90 sources
 * produced 85 distinct slices, meaning roughly every eleventh horse in a
 * thousand-strong fleet had an IDENTICAL set of favourite channels. Varying
 * the stride multiplies the available slices by the size of the stride pool.
 *
 * The strides are primes, and any that divides the catalogue length is
 * skipped, so the walk always reaches `take` distinct entries instead of
 * looping early over a subset.
 */
const STRIDES = [7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47] as const;

export function sliceForHorse<T>(all: readonly T[], profileId: string, n = SOURCES_PER_HORSE): T[] {
  if (all.length === 0) return [];
  const take = Math.min(n, all.length);
  const start = fleetHash(profileId, 'sources') % all.length;
  const usable = STRIDES.filter((p) => all.length % p !== 0);
  const stride = usable.length
    ? usable[fleetHash(profileId, 'stride') % usable.length]!
    : 1;
  const out: T[] = [];
  const used = new Set<number>();
  for (let i = 0; out.length < take && i < all.length * 3; i++) {
    const idx = (start + i * stride) % all.length;
    if (used.has(idx)) continue;
    used.add(idx);
    out.push(all[idx]!);
  }
  return out;
}

/**
 * How much of this horse's video output is sports rather than poker.
 *
 * Phase 1-3 used one global `Math.random() < 0.75`, so every horse had the
 * same appetite and the fleet's mix was a property of the code rather than of
 * the characters. A horse that only ever posts poker and a horse who cannot
 * stop posting basketball are both people; a thousand horses each posting
 * exactly 25% sports are a script.
 *
 * Deterministic per horse, weighted so the FLEET still averages near a
 * quarter: most horses sit between 10% and 35%, a few are almost pure poker,
 * a few are the ones who mostly watch the game.
 */
export function sportsShareFor(profileId: string): number {
  const r = fleetHash(profileId, 'sports-share') % 1000;
  if (r < 120) return 0.02;
  if (r < 300) return 0.12;
  if (r < 620) return 0.22;
  if (r < 850) return 0.33;
  if (r < 960) return 0.48;
  return 0.65;
}

/** Active sources for a domain. */
export async function activeSources(domain: 'poker' | 'sports'): Promise<SourceRow[]> {
  const { data, error } = await getSupabase()
    .from('content_sources')
    .select('id, name, handle, channel_id, category, sport, consecutive_failures')
    .eq('domain', domain)
    .eq('is_active', true)
    .order('name');
  if (error) {
    console.warn('[clip-supply] source read failed:', error.message);
    return [];
  }
  return (data ?? []) as SourceRow[];
}

/**
 * Candidate clips for this horse, from its own slice of sources first.
 *
 * Widening is deliberate and ORDERED: the horse's slice, then the whole
 * domain. A horse that cannot post is a worse failure than a horse posting
 * slightly outside its taste - that is the lesson the sports fallback was
 * built on - but the widening is reported so the skew is visible rather than
 * silent.
 */
export async function candidateClips(
  domain: 'poker' | 'sports',
  profileId: string,
  limit = 60,
): Promise<{ clips: SupplyClip[]; widened: boolean }> {
  const table = domain === 'poker' ? 'poker_clips' : 'sports_clips';
  const sources = await activeSources(domain);
  const mine = sliceForHorse(sources, profileId).map((s) => s.name);

  const select =
    domain === 'poker'
      ? 'id, video_id, source_url, source, title, category, oembed_ok'
      : 'id, video_id, source_url, source, title, category';

  if (mine.length) {
    let q = getSupabase().from(table).select(select).in('source', mine).limit(limit);
    if (domain === 'poker') q = q.eq('is_active', true).not('oembed_ok', 'is', false);
    const { data, error } = await q;
    if (!error && (data ?? []).length >= 5) {
      return { clips: normalise(data, domain), widened: false };
    }
  }

  let q = getSupabase().from(table).select(select).limit(limit);
  if (domain === 'poker') q = q.eq('is_active', true).not('oembed_ok', 'is', false);
  const { data, error } = await q;
  if (error) {
    console.warn(`[clip-supply] ${table} read failed:`, error.message);
    return { clips: [], widened: true };
  }
  return { clips: normalise(data, domain), widened: true };
}

function normalise(rows: unknown, domain: 'poker' | 'sports'): SupplyClip[] {
  return ((rows ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    video_id: String(r.video_id ?? ''),
    source_url: String(r.source_url ?? ''),
    source: String(r.source ?? ''),
    title: String(r.title ?? ''),
    category: String(r.category ?? ''),
    oembed_ok: domain === 'poker' ? ((r.oembed_ok as boolean | null) ?? null) : null,
  }));
}

/**
 * Record what oEmbed said about a clip, so the next container does not ask
 * again and a dead video is never offered twice.
 *
 * Only `poker_clips` carries these columns, so a sports clip is a no-op
 * rather than an error: the caller should not have to know which table a clip
 * came from.
 */
export async function recordValidity(clipId: string, ok: boolean): Promise<void> {
  const { error } = await getSupabase()
    .from('poker_clips')
    .update({ oembed_ok: ok, oembed_checked_at: new Date().toISOString(), is_active: ok })
    .eq('id', clipId);
  if (error) console.warn('[clip-supply] validity write failed:', error.message);
}
