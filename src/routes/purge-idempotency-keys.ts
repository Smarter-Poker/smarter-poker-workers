/**
 * GET/POST /cron/purge-idempotency-keys
 *
 * Ported from pages/api/cron/purge-idempotency-keys.js (61 lines).
 *
 * Nightly cleanup of the idempotency_keys table. Calls the
 * `purge_idempotency_keys()` Postgres RPC which DELETEs rows older than
 * 7 days and returns the count deleted.
 *
 * Idempotent by construction — DELETE with a time cutoff re-runs as a no-op.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

export async function purgeIdempotencyKeys(c: Context) {
  const supabase = getSupabase();
  const started = Date.now();

  try {
    const { data, error } = await supabase.rpc('purge_idempotency_keys');
    if (error) {
      console.warn('[purge-idempotency-keys] RPC error:', error.message);
      return c.json({ error: error.message }, 500);
    }
    const deleted = typeof data === 'number' ? data : Number(data ?? 0);
    const elapsedMs = Date.now() - started;

    console.log(`[purge-idempotency-keys] deleted=${deleted} elapsed_ms=${elapsedMs}`);

    return c.json({
      ok: true,
      phase: '4.1.3',
      deleted,
      elapsed_ms: elapsedMs,
      run_at: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[purge-idempotency-keys] unhandled:', msg);
    return c.json({ error: msg }, 500);
  }
}
