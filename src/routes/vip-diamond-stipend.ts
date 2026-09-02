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
 * Not the eligibility rule. Dan decided on 2026-09-01 that EVERY VIP holder
 * is paid the 500, horses included, so selecting on the entitlement is now
 * correct policy. What was wrong is HOW this route did it:
 *
 *   - a silent `.limit(100)`. There are 1,033 entitled accounts (1,000 horses
 *     holding lifetime VIP from the club-arena migration
 *     20260311_horses_lifetime_vip, 21 granted lifetime humans, 12 unexpired
 *     monthly). This route pays the first 100 and reports success, every
 *     month, so 90% of the fleet is silently skipped;
 *   - no ordering, so which 100 get paid is arbitrary and not even stable
 *     between runs;
 *   - it bypasses `award_diamonds_v2` entirely, hand-rolling a
 *     `diamond_transactions` lookup instead. No catalog-resolved amount, no
 *     caps, none of the shared idempotency the rest of the economy relies on.
 *
 * It had already paid 12 accounts, 6,000 diamonds, in June and August.
 *
 * --- WHAT REPLACES IT ----------------------------------------------------
 * `pages/api/cron/vip-stipend.js` in Smarter-Poker-World-Hub. It selects the
 * same entitlement (`is_vip` AND (vip_tier = 'lifetime' OR vip_expires_at in
 * the future)), pages through ALL of it rather than the first 100, and awards
 * through `award_diamonds_v2` so the amount comes from
 * `diamond_reward_catalog` and idempotency is one stipend per user per
 * calendar month. Open Claw was repointed at it on 2026-09-01 (World Hub
 * PR #1242).
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
    '[vip-diamond-stipend] RETIRED route called. It paid only 100 of the 1,033 ' +
      'entitled accounts and bypassed award_diamonds_v2. Permanently disabled. ' +
      'Use /api/cron/vip-stipend on Vercel. Nothing was paid.',
  );

  return c.json(
    {
      success: false,
      retired: true,
      paid: 0,
      error: 'This stipend route is retired and pays nothing.',
      reason:
        'It capped every run at 100 of 1,033 entitled accounts and bypassed ' +
        'award_diamonds_v2, so amounts, caps and idempotency were all unenforced.',
      replacement: '/api/cron/vip-stipend (Smarter-Poker-World-Hub, Vercel)',
      retired_at: '2026-09-01',
    },
    410,
  );
}

export default vipDiamondStipend;
