/**
 * GET/POST /cron/ledger-reconcile
 *
 * Ported from pages/api/cron/ledger-reconcile.js (101 lines).
 *
 * Nightly 04:00 ET (08:00 UTC): calls public.reconcile_ledger_nightly()
 * SECURITY DEFINER. RPC scans every public.wallets row + public.clubs.
 * chip_pool, computes drift vs sum of ledger entries, and writes one
 * row per entity to public.ledger_reconcile_log with severity = ok |
 * warn (≤ $1.00 drift) | critical.
 *
 * Returns a single-row summary: total_checked, ok_count, warn_count,
 * critical_count, worst_drift. Logs CRITICAL if critical_count > 0.
 *
 * Idempotent: deterministic over the same wallet set; only the
 * reconcile_log inserts grow per run. No double-fire harm.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

interface ReconcileSummary {
  total_checked: number | string | null;
  ok_count: number | string | null;
  warn_count: number | string | null;
  critical_count: number | string | null;
  worst_drift: number | string | null;
}

export async function ledgerReconcile(c: Context) {
  const started = Date.now();
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.rpc('reconcile_ledger_nightly');

    if (error) {
      console.warn('[ledger-reconcile] RPC error:', error.message);
      return c.json({ error: error.message }, 500);
    }

    // RPC returns SETOF — supabase-js surfaces it as data[0] when single-row
    const summary: ReconcileSummary | null = Array.isArray(data)
      ? ((data[0] ?? null) as ReconcileSummary | null)
      : ((data ?? null) as ReconcileSummary | null);

    const totalChecked = Number(summary?.total_checked ?? 0);
    const okCount = Number(summary?.ok_count ?? 0);
    const warnCount = Number(summary?.warn_count ?? 0);
    const criticalCount = Number(summary?.critical_count ?? 0);
    const worstDrift = Number(summary?.worst_drift ?? 0);
    const elapsedMs = Date.now() - started;

    if (criticalCount > 0) {
      console.warn(
        `[ledger-reconcile] CRITICAL: ${criticalCount} entities with drift > $1.00; worst = $${worstDrift.toFixed(2)}`,
      );
    } else if (warnCount > 0) {
      console.warn(
        `[ledger-reconcile] WARN: ${warnCount} entities with sub-dollar drift; worst = $${worstDrift.toFixed(2)}`,
      );
    } else {
      console.warn(`[ledger-reconcile] clean run: ${totalChecked} entities, all ok`);
    }

    return c.json({
      ok: true,
      phase: '4.1.2',
      run_at: new Date().toISOString(),
      elapsed_ms: elapsedMs,
      total_checked: totalChecked,
      ok_count: okCount,
      warn_count: warnCount,
      critical_count: criticalCount,
      worst_drift: worstDrift,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unhandled reconcile failure';
    console.warn('[ledger-reconcile] unhandled error:', msg);
    return c.json({ error: msg }, 500);
  }
}
