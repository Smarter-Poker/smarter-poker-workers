/**
 * GET/POST /cron/chip-supply-snapshot
 *
 * Calls fn_snapshot_chip_supply() (SECURITY DEFINER, service_role only),
 * which appends one row to chip_supply_snapshots.
 *
 * WHY THIS EXISTS
 * The M4 audit established that ABSOLUTE chip conservation is unknowable on
 * this database: category='mint' holds 3 rows totalling 2,200,000.01 against
 * ~732,000,000 actually in wallets, several categories stopped being written
 * entirely (rake ends 2026-04-02, transfer 03-19, rebuy 04-19), and
 * reconciling the whole log leaves ~776M unexplained. There is no defensible
 * genesis figure, and inventing one replaces a wrong number with a
 * confident-looking wrong number.
 *
 * What IS knowable is conservation BETWEEN snapshots: delta(holdings) must
 * equal delta(credits - debits). That needs no genesis, and it is exactly the
 * invariant an unbacked credit violates. fn_snapshot_chip_supply() and the
 * chip_supply_snapshots table were built for this in migration
 * 20260808_m4_chip_supply_snapshots.
 *
 * The gap this route closes: nothing ever called the function a second time.
 * A single baseline row was written on 2026-08-08 (holdings 733,280,581.53)
 * and deltas are NULL on a first snapshot BY DESIGN - so with one row the
 * reconciliation could never compute anything. The machinery was correct and
 * simply never scheduled.
 *
 * Idempotent enough by construction: each run appends one observation. Running
 * twice costs one extra row, never a wrong number.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

export async function chipSupplySnapshot(c: Context) {
  const supabase = getSupabase();
  const started = Date.now();

  try {
    const { error } = await supabase.rpc('fn_snapshot_chip_supply');
    if (error) {
      console.warn('[chip-supply-snapshot] RPC error:', error.message);
      return c.json({ error: error.message }, 500);
    }

    // Read back the two most recent snapshots so the run reports the delta it
    // just made computable, rather than a bare "ok" that proves nothing.
    const { data: recent, error: readErr } = await supabase
      .from('chip_supply_snapshots')
      .select('taken_at, wallets_total, table_stacks, tx_credits, tx_debits, unexplained_delta')
      .order('taken_at', { ascending: false })
      .limit(2);

    if (readErr) {
      console.warn('[chip-supply-snapshot] snapshot written but read-back failed:', readErr.message);
      return c.json({ ok: true, read_back: false, elapsed_ms: Date.now() - started });
    }

    const rows = recent ?? [];
    const latest = rows[0] as Record<string, unknown> | undefined;
    const prior = rows[1] as Record<string, unknown> | undefined;

    console.log(
      `[chip-supply-snapshot] written; snapshots_available=${rows.length} ` +
        `unexplained_delta=${String(latest?.unexplained_delta ?? 'null')}`,
    );

    return c.json({
      ok: true,
      snapshots_available: rows.length,
      // NULL on the very first snapshot by design - a delta needs a prior row.
      has_comparable_prior: Boolean(prior),
      latest,
      elapsed_ms: Date.now() - started,
      run_at: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[chip-supply-snapshot] threw:', msg);
    return c.json({ error: msg }, 500);
  }
}
