/**
 * Paged reads for the integrity sweeps.
 *
 * WHY THIS EXISTS (2026-09-01)
 * ----------------------------
 * PostgREST clamps every response to `db-max-rows`, which is 1000 on this
 * project. A `.limit(50000)` in client code is not an error and not a warning —
 * it comes back with 1000 rows and a 200. Measured against production on
 * 2026-09-01:
 *
 *   collusion-scan, default 24h window   -> scanned_hands: 1000
 *   the same window actually contains    -> ~280,000 hands
 *
 * So the sweep had been examining roughly a third of one percent of play, and
 * because there was no ORDER BY it was an arbitrary third of a percent. Every
 * "0 findings" it ever reported was measuring the cap, not the felt.
 *
 * This helper pages with .range() up to an EXPLICIT ceiling — the ceiling the
 * original .limit() was already asking for — and tells the caller when the
 * ceiling binds, so a truncated scan can never again look like a clean one.
 *
 * The ordering is deliberate: newest-first means a truncated scan sees a
 * contiguous, most-recent slice of the window rather than an arbitrary one.
 */
import type { PostgrestFilterBuilder } from '@supabase/postgrest-js';

/** PostgREST's own per-response ceiling on this project. */
export const PAGE_SIZE = 1000;

export interface PagedResult<T> {
  rows: T[];
  /** True when `max` was reached and more rows matched the filter. */
  truncated: boolean;
  /** Number of round trips made. */
  pages: number;
}

/**
 * `build` must return a fresh query for each page — a PostgREST builder is a
 * one-shot thenable and cannot be re-executed.
 */
export async function pagedSelect<T>(
  build: () => PostgrestFilterBuilder<any, any, any, any, any>,
  max: number,
  pageSize: number = PAGE_SIZE,
): Promise<PagedResult<T>> {
  const rows: T[] = [];
  let pages = 0;

  while (rows.length < max) {
    const want = Math.min(pageSize, max - rows.length);
    const from = rows.length;
    const { data, error } = await build().range(from, from + want - 1);
    pages += 1;
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    // A short page means the result set is exhausted.
    if (batch.length < want) return { rows, truncated: false, pages };
  }

  // We stopped because we hit `max`. Ask for one more row to find out whether
  // the window genuinely ended there or we are truncating.
  const { data: probe } = await build().range(max, max);
  return { rows, truncated: (probe ?? []).length > 0, pages: pages + 1 };
}
