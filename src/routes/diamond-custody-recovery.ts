import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

/** OpenClaw calls this through the existing /cron/* authentication middleware.
 * The database serializes bounded sweeps and retains each original request ID.
 * Diagnostics run after recovery commits, so an unavailable report cannot undo a refund.
 */
export async function diamondCustodyRecovery(c: Context) {
  let recovered = 0;
  try {
    const db = getSupabase();
    const result = await db.rpc('fn_poker_diamond_recover_releases');
    if (result.error) throw new Error(result.error.message);
    if (!Number.isSafeInteger(result.data) || result.data < 0 || result.data > 16)
      throw new Error('Invalid Diamond Recovery Receipt');
    recovered = result.data;

    const reconciliation = await db.rpc('fn_poker_diamond_reconcile');
    if (reconciliation.error) throw new Error(reconciliation.error.message);
    if (!Array.isArray(reconciliation.data))
      throw new Error('Invalid Diamond Reconciliation Response');

    const obligations = await db.from('poker_diamond_obligations')
      .select('request_id', { count: 'exact', head: true }).eq('state', 'pending');
    if (obligations.error) throw new Error(obligations.error.message);
    if (!Number.isSafeInteger(obligations.count) || Number(obligations.count) < 0)
      throw new Error('Invalid Diamond Obligation Count');

    const pending = Number(obligations.count);
    const discrepancies = reconciliation.data.length;
    const ok = pending === 0 && discrepancies === 0;
    return c.json({ ok, recovered, pending, discrepancies }, ok ? 200 : 503);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Diamond Recovery Failed';
    console.warn('[diamond-custody-recovery]', message);
    return c.json({ ok: false, recovered, error: message }, 503);
  }
}
