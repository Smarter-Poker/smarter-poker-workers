/**
 * GET/POST /cron/vip-diamond-stipend
 *
 * Ported from pages/api/cron/vip-diamond-stipend.js (127 lines).
 *
 * Monthly on the 1st at 00:05 UTC: credit 500 diamonds to every active
 * VIP user (is_vip=true AND vip_expires_at > now) via RPC
 * add_diamonds_to_balance with reference_id=`vip_stipend_<userId>_<YYYY-MM>`.
 * Pre-checks diamond_transactions for the same reference_id to skip
 * already-paid users.
 *
 * Idempotence: per-user/per-month reference_id guard makes repeated
 * runs safe — second run for the same month is all-skip.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const VIP_MONTHLY_STIPEND = 500;

export async function vipDiamondStipend(c: Context) {
  try {
    const supabase = getSupabase();
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const { data: vipData, error: fetchErr } = await supabase
      .from('profiles')
      .select('id, username')
      .eq('is_vip', true)
      .gt('vip_expires_at', now.toISOString())
      .limit(100);

    if (fetchErr) {
      console.warn('[vip-diamond-stipend] fetch error:', fetchErr.message);
      return c.json({ error: fetchErr.message }, 500);
    }

    const vipUsers = (vipData ?? []) as Array<{ id: string; username: string | null }>;

    if (vipUsers.length === 0) {
      return c.json({
        success: true,
        message: 'No active VIP users found',
        credited: 0,
      });
    }

    let credited = 0;
    let skipped = 0;
    const errors: Array<{ userId: string; error: string }> = [];

    for (const user of vipUsers) {
      try {
        const stipendRefId = `vip_stipend_${user.id}_${monthKey}`;

        const { data: existing } = await supabase
          .from('diamond_transactions')
          .select('id')
          .eq('user_id', user.id)
          .eq('reference_id', stipendRefId)
          .limit(1);

        if (existing && existing.length > 0) {
          skipped++;
          continue;
        }

        const { error: rpcErr } = await supabase.rpc('add_diamonds_to_balance', {
          p_user_id: user.id,
          p_amount: VIP_MONTHLY_STIPEND,
          p_type: 'bonus',
          p_description: `VIP Monthly Stipend — ${monthKey}`,
          p_reference_id: stipendRefId,
        });

        if (rpcErr) {
          console.warn(`[vip-diamond-stipend] RPC error for ${user.id}:`, rpcErr.message);
          errors.push({ userId: user.id, error: rpcErr.message });
          continue;
        }

        credited++;
      } catch (userErr) {
        const msg = userErr instanceof Error ? userErr.message : String(userErr);
        console.warn(`[vip-diamond-stipend] error for user ${user.id}:`, msg);
        errors.push({ userId: user.id, error: msg });
      }
    }

    return c.json({
      success: true,
      month: monthKey,
      totalVipUsers: vipUsers.length,
      credited,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[vip-diamond-stipend] fatal:', msg);
    return c.json({ error: msg }, 500);
  }
}
