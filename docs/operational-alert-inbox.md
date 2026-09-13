# Operational alerts go to the incident inbox

Operational alerts that previously texted the owner now call the service-only
`fn_record_operational_alert` RPC in the shared production database. Codex
consumes the resulting `operational_alert_events` records. The RPC returns a
positive event ID only after persistence; repeat deliveries use the same event
key. A queue error is a failed cron run, never a successful SMS fallback.

| Producer | Incidents |
| --- | --- |
| `deploy-error-poll` | Vercel API failure, failed deployment, failed autofix rebuild, circuit breaker, build OOM, autofix PR requiring review |
| `scraper-watchdog` | Source stale/dead/anomalous, database read failure, recovery |
| `scraperAlerts` through `tour-schedule-scraper` | Failed/no-output scraper, high error rate, low output, extraction result |

Scraper state and cooldown advance only after a receipt. Recovery retains the
previous occurrence identity so a new failure cannot collide with the original
incident. The deployment monitor records the original failed deployment before
any autofix action or suppression. Full diagnostic payloads are preserved in
the inbox instead of being clipped to SMS length.

The scraper watchdog's owner-only push notification follows the same inbox
route. User notifications and the shared SMS utility are unchanged. A source
and compiled-bundle audit found no remaining operational Twilio caller in the
workers service. The separate World Hub and Open Claw senders are migrated in
their owning repository.

The queue migration must be present before this service deploys. Unit coverage
exercises persistence rejection, successful retry with an unchanged key,
separate incidents, recovery, recurrence, and a real-shaped Vercel invalid-token
response. No production SMS probe is required.
