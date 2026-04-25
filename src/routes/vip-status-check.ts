/**
 * GET/POST /cron/vip-status-check
 *
 * Ported from pages/api/cron/vip-status-check.js (88 lines).
 *
 * Hourly: revoke VIP status for profiles whose vip_expires_at is in
 * the past. Excludes permanent-VIP rows (vip_expires_at IS NULL).
 *
 * Idempotent: subsequent runs find an empty result set since is_vip
 * is now false. Bulk update via .in('id', [...]).
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

export async function vipStatusCheck(c: Context) {
  try {
    const supabase = getSupabase();
    const now = new Date().toISOString();

    const { data: expiredData, error: fetchErr } = await supabase
      .from('profiles')
      .select('id, username, vip_expires_at')
      .eq('is_vip', true)
      .not('vip_expires_at', 'is', null)
      .lt('vip_expires_at', now)
      .limit(500);

    if (fetchErr) {
      console.warn('[vip-status-check] fetch error:', fetchErr.message);
      return c.json({ error: fetchErr.message }, 500);
    }

    const expiredUsers = (expiredData ?? []) as Array<{
      id: string;
      username: string | null;
      vip_expires_at: string;
    }>;

    if (expiredUsers.length === 0) {
      return c.json({
        success: true,
        message: 'No expired VIP users found',
        revokedCount: 0,
      });
    }

    const userIds = expiredUsers.map((u) => u.id);

    const { error: updateErr } = await supabase
      .from('profiles')
      .update({ is_vip: false })
      .in('id', userIds);

    if (updateErr) {
      console.warn('[vip-status-check] update error:', updateErr.message);
      return c.json({ error: updateErr.message }, 500);
    }

    console.warn(`[vip-status-check] revoked VIP for ${userIds.length} users`);

    return c.json({
      success: true,
      revokedCount: userIds.length,
      revokedUsers: userIds,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[vip-status-check] fatal:', msg);
    return c.json({ error: msg }, 500);
  }
}
