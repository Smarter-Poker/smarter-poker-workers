# Tournament Reminder Service Authority

The live worker-side readiness request returned HTTP 401 on September 9, 2026, even though the endpoint worked with the hub credential. The new caller had incorrectly used its host-local CRON_SECRET for another service. Preparation health alone did not detect that defect.

The worker now presents the same database service authority it already uses to prepare reminders. The endpoint verifies that credential against the same project using the existing service_role-only, read-only get_tournament_reminder_delivery RPC with an empty ID list. Anonymous and authenticated player roles cannot execute it, as verified in production. No credential values or database grants change. No new shared secret or scheduled job is introduced. The sender continues with that verified client; it does not upgrade incoming requests to the hub's own database authority.

Three endpoint regressions and two transport regressions failed against the old behavior. The corrected endpoint tests cover readiness without dispatch, using the caller's own client, refusal of player/anonymous/revoked/local-cron credentials, and unavailable authority. Sender eligibility, consent, claim ownership and deadline checks remain in the shared sender. The compatibility cron calls that sender directly and is unaffected.

Release order remains receiver first, verify read-only readiness from the actual worker container, then publish the corrected worker. Natural execution and physical-device acceptance must be reported separately from startup health.
