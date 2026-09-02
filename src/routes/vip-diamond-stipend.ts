/**
 * RETIRED 2026-09-01. This route no longer pays anything, deliberately.
 *
 * --- WHAT IT USED TO DO --------------------------------------------------
 * Credit 500 diamonds to every profile matching
 *
 *     .eq('is_vip', true).gt('vip_expires_at', now).limit(100)
 *
 * with no check of any kind that the account had ever paid for VIP.
 *
 * --- WHY THAT WAS WRONG --------------------------------------------------
 * `profiles.is_vip` / `vip_tier` are FEATURE-ENTITLEMENT flags, not proof of
 * payment. On 2026-09-01 that predicate selected 704 accounts:
 *
 *   1,000  horses granted lifetime VIP by the club-arena migration
 *          20260311_horses_lifetime_vip purely so the fleet would have VIP
 *          features
 *     162  humans granted lifetime VIP by hand
 *      12  humans inside the 30-day signup trial or a phone-verification
 *          grant, both of which write vip_tier without any payment
 *
 * Not one had a row in `vip_subscriptions`, and no diamond has ever been spent
 * on VIP on this platform. `.limit(100)` silently capped each run at
 * 100 x 500 = 50,000 diamonds ($500) a month, paid to non-payers, forever.
 * It had already paid 12 such accounts, 6,000 diamonds, in June and August.
 *
 * --- WHAT REPLACES IT ----------------------------------------------------
 * `pages/api/cron/vip-stipend.js` in Smarter-Poker-World-Hub, which pays only
 * accounts holding a `vip_subscriptions` row with a non-null
 * `stripe_subscription_id` and a live Stripe status. Open Claw was repointed
 * at it on 2026-09-01 (World Hub PR #1242) and runs it daily; it is idempotent
 * per user per calendar month.
 *
 * --- WHY THIS FILE STILL EXISTS ------------------------------------------
 * The monolith copy of this handler was DELETED on 2026-04-25 and that is
 * precisely how the bug survived: the deletion looked like a retirement, the
 * workers copy kept serving, and the dispatcher kept calling it for four more
 * months. A 404 reads like a routing mistake and invites somebody to "restore"
 * the handler. A 410 that says why does not.
 *
 * The rule this route violated, stated so it cannot be misread: the question is
 * ALWAYS "did this account pay for VIP", and NEVER "is this account a horse".
 * Both questions currently give the same answer for every account, so
 * club-arena CLAUDE.md section 10.5 is satisfied by construction. A horse that
 * buys VIP out of the club wallet is owed the stipend on exactly the same terms
 * as a human, and no `is_horse` branch belongs in any payout path.
 */

import type { Context } from 'hono';

export async function vipDiamondStipend(c: Context) {
  console.warn(
    '[vip-diamond-stipend] RETIRED route called. It paid 500 diamonds on ' +
      'profiles.is_vip with no payment check and is permanently disabled. ' +
      'Use /api/cron/vip-stipend on Vercel. Nothing was paid.',
  );

  return c.json(
    {
      success: false,
      retired: true,
      paid: 0,
      error: 'This stipend route is retired and pays nothing.',
      reason:
        'It credited 500 diamonds on profiles.is_vip with no proof of payment, ' +
        'which selected trial grants, hand-granted lifetime VIP and the horse fleet.',
      replacement: '/api/cron/vip-stipend (Smarter-Poker-World-Hub, Vercel)',
      retired_at: '2026-09-01',
    },
    410,
  );
}

export default vipDiamondStipend;
