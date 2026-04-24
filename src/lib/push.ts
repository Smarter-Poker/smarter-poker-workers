/**
 * Push-notification stub — intentionally a no-op to match World Hub's
 * src/lib/pushAlerts.js behavior as of 2026-04-24, where the server-side
 * export is literally:
 *
 *   export const sendPushNotification = async () => {};
 *
 * So every caller's push is silently dropped. The gate flag (e.g.,
 * user_venue_checkins.review_prompt_sent) still gets set to true, which
 * at least guarantees at-most-once behavior when a real push is wired
 * back in later.
 *
 * TODO (tracked as Phase 4 tech debt, not this phase): wire up real
 * OneSignal / web-push send here. Requires:
 *   - OneSignal REST API call with ONESIGNAL_APP_ID + ONESIGNAL_REST_API_KEY
 *     env vars (docker-compose.yml .env_file already leaves slots open)
 *   - per-user subscription lookup from Supabase (onesignal_player_id column)
 *   - graceful handling when user has no subscription
 */
export async function sendPushNotification(
  _userId: string,
  _kind: string,
  _payload: { title: string; body: string; url?: string },
): Promise<void> {
  // intentionally empty — matches monolith behavior
  return;
}
