/**
 * POST /cron/scraper-data-cleanup
 *
 * Ported from pages/api/cron/scraper-data-cleanup.js (2026-04-24).
 *
 * Daily retention cleanup. Deletes rows older than the per-table cutoff.
 * Idempotent by nature — running it twice just deletes zero the second time.
 *
 * Retention:
 *   venue_live_history    — 90 days
 *   scraper_metrics       — 90 days
 *   game_live_history     — 90 days
 *   venue_live_tables     — 2 hours (stale ghost data from dead scrapers)
 *   scraper_watchdog_state — 7 days (except the sticky 'game_trends_snapshot' key)
 *
 * Audit log: upserts to scraper_watchdog_state.last_cleanup_execution after run.
 *
 * Auth: /cron/* middleware chain (requireCronSecret + ipAllowlist).
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

type TableResult = { deleted: number; error: string | null };

async function deleteOlderThan(
  supabase: ReturnType<typeof getSupabase>,
  table: string,
  column: string,
  cutoffIso: string,
): Promise<TableResult> {
  try {
    const { count, error } = await supabase
      .from(table)
      .delete({ count: 'exact' })
      .lt(column, cutoffIso);
    return { deleted: count ?? 0, error: error?.message ?? null };
  } catch (err) {
    return { deleted: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function scraperDataCleanup(c: Context) {
  const supabase = getSupabase();
  const results: {
    cleaned_at: string;
    tables: Record<string, TableResult>;
  } = {
    cleaned_at: new Date().toISOString(),
    tables: {},
  };

  const cutoff90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const cutoff2h = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  results.tables.venue_live_history = await deleteOlderThan(
    supabase, 'venue_live_history', 'snapshot_time', cutoff90,
  );
  results.tables.scraper_metrics = await deleteOlderThan(
    supabase, 'scraper_metrics', 'cycle_start', cutoff90,
  );
  results.tables.game_live_history = await deleteOlderThan(
    supabase, 'game_live_history', 'snapshot_time', cutoff90,
  );
  results.tables.venue_live_tables = await deleteOlderThan(
    supabase, 'venue_live_tables', 'scrape_timestamp', cutoff2h,
  );

  // Special case — scraper_watchdog_state has one sticky key to preserve
  try {
    const { count } = await supabase
      .from('scraper_watchdog_state')
      .delete({ count: 'exact' })
      .lt('updated_at', cutoff7d)
      .neq('key', 'game_trends_snapshot');
    results.tables.scraper_watchdog_state = { deleted: count ?? 0, error: null };
  } catch (err) {
    results.tables.scraper_watchdog_state = {
      deleted: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Audit-trail upsert so the last cleanup's stats are queryable
  try {
    await supabase
      .from('scraper_watchdog_state')
      .upsert(
        {
          key: 'last_cleanup_execution',
          value: JSON.stringify(results),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'key' },
      );
  } catch (err) {
    console.warn(
      '[scraper-data-cleanup] audit upsert failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  return c.json(results);
}
