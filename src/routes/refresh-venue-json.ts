/**
 * GET /cron/refresh-venue-json
 *
 * Ported from pages/api/cron/refresh-venue-json.js (89 lines).
 *
 * Daily: fetch all active poker_venues, upsert into system_cache with
 * cache_key='all_venues_json' so PokerNearMe's static-fallback data
 * stays fresh. Read-only on poker_venues, writes a single upsert.
 *
 * Idempotent — running twice does a single upsert twice (no-op delta).
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

interface Venue {
  id: number | string;
  name: string | null;
  is_active: boolean;
  [key: string]: unknown;
}

export async function refreshVenueJson(c: Context) {
  const supabase = getSupabase();
  try {
    const { data: venuesData, error } = await supabase
      .from('poker_venues')
      .select('*')
      .eq('is_active', true)
      .order('name', { ascending: true })
      .limit(1000);

    if (error) {
      console.warn('[refresh-venue-json] fetch error:', error.message);
      return c.json({ success: false, error: 'Failed to fetch venues from database' }, 500);
    }

    const venues = (venuesData ?? []) as Venue[];
    const venueCount = venues.length;
    const jsonPayload = JSON.stringify({
      venues,
      updated_at: new Date().toISOString(),
      count: venueCount,
    });

    const { error: cacheError } = await supabase
      .from('system_cache')
      .upsert(
        {
          cache_key: 'all_venues_json',
          cache_value: jsonPayload,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'cache_key' },
      );

    if (cacheError) {
      // Non-fatal — if system_cache doesn't exist, just log and report success anyway
      console.warn('[refresh-venue-json] cache write failed:', cacheError.message);
    }

    return c.json({
      success: true,
      message: `Refreshed venue data: ${venueCount} venues`,
      count: venueCount,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[refresh-venue-json] fatal:', msg);
    return c.json({ success: false, error: msg }, 500);
  }
}
