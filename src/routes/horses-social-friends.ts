/**
 * GET/POST /cron/horses-social-friends
 *
 * Ported from pages/api/cron/horses-social-friends.js (37 LOC).
 *
 * Every 6 hours: horses send (max 10) and accept (max 15) friend requests.
 * Both functions live in src/lib/content-engine/HorseSocialEngine.ts —
 * a slim port of just the two friend-management functions from the
 * monolith's 1143-LOC engine.
 *
 * Idempotence: existing-row check via .or() before each send; 80%
 * acceptance roll on accepts. Re-running within minutes adds at most
 * a handful of new requests/acceptances proportional to the random rolls.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import {
  sendFriendRequests,
  acceptFriendRequests,
} from '../lib/content-engine/HorseSocialEngine.js';

export async function horsesSocialFriends(c: Context) {
  try {
    const sendResult = await sendFriendRequests(10);
    const acceptResult = await acceptFriendRequests(15);

    return c.json({
      success: true,
      sent: sendResult.sent,
      accepted: acceptResult.accepted,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[horses-social-friends] fatal:', msg);
    return c.json({ success: false, error: msg }, 500);
  }
}
