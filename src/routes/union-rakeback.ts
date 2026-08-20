/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  /cron/union-rakeback — RETIRED 2026-08-20. PERMANENTLY DISABLED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This route was a SECOND PAYER on the same union rake wallet.
 *
 * The union 90/10 weekly rakeback is paid by the ENGINE:
 *   RakebackSettlerService.runUnionWeeklyRakeback()
 *     -> fn_union_weekly_rakeback_close_all()
 * which pays each club 90% of the rake ITS OWN players generated, keeps 10%
 * for the union, is idempotent per (union, ISO week), and self-heals a missed
 * Monday on the next settler cycle.
 *
 * What this route did instead: read the whole union_wallets.rake_wallet
 * balance, split 100% of it across member clubs by commission-rate WEIGHT
 * (two clubs at 0.90 => 50/50), credited each treasury and debited the
 * wallet. Wrong amount, wrong allocation, and a second writer on money the
 * engine had already accounted for.
 *
 * Why it never showed up in production: it read the dead `unions.rake_wallet`
 * column, which is 0 on every row, so it always logged "No unions with rake
 * balance". The 2026-08-19 fix that pointed the read at `union_wallets`
 * ARMED it — Monday 2026-08-24 10:20 UTC would have been its first real
 * (double, misallocated) payment.
 *
 * Its Open Claw schedule was removed in dispatcher commit a8a4d92f35. This
 * tombstone is defence in depth: a re-added schedule, a manual curl, a
 * misrouted retry — none of them can move money through this path. The
 * original implementation is in git history (last live at bea7591).
 *
 * DO NOT re-enable without first deleting the engine payer. Two schedulers
 * on one wallet is the same class of bug as the news-digest double-send
 * (see World Hub CLAUDE.md section 11.4).
 */
import type { Context } from 'hono';

export async function unionRakeback(c: Context) {
  return c.json(
    {
      success: false,
      retired: true,
      error: 'union_rakeback_route_retired',
      message:
        'Retired 2026-08-20: this route double-paid from the union rake wallet. ' +
        'The 90/10 weekly rakeback is paid by the engine settler via ' +
        'fn_union_weekly_rakeback_close_all.',
    },
    410,
  );
}
