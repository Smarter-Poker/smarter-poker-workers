# Every operational alert producer resolves its own firing members (incident 86bcafc1, 2026-11-25)

Incident `86bcafc1-80ae-4118-afff-7fa2aa505386` (`VercelDeploymentFailed`, class
`release`, source `workers.deploy-error-poll`) fired on 2026-11-25 22:56Z and
23:08Z for World Hub builds `db0bd6aa` (#3010) and `98842721` (#3009). PR #3011
(`aca9e106`) fixed the Webpack client-bundle leak and deployed `READY` at 23:18Z,
yet the critical incident remained permanently `escalated` — the third recurrence
of the same lifecycle gap (`9d726490` on 2026-11-10, `068e7ad9` on 2026-11-16,
`86bcafc1` on 2026-11-25).

## Root causes fixed at source

1. **`src/routes/deploy-error-poll.ts` (`VercelDeploymentFailed`, `AutofixRebuildFailed`):**
   When `currentMainFailure` returned `{ kind: 'ready' }`, the route returned
   `action: 'ok'` without emitting `status: 'resolved'` twins for open firing
   deployment alerts. It now calls `resolveOpenOperationalAlerts` to emit
   deterministic `:resolved` twins with `payload.resolves = firing.event_key`
   without mutating any firing row's `investigation_status` and without writing
   to Vercel.
2. **`src/lib/deploymentMonitorHealth.ts` (`DeploymentMonitorUnavailable`):**
   Recovery emitted a fresh SHA-256 `eventKey` without `payload.resolves`, so
   `smarter_private.reliability_ingest_alert` computed a mismatched `v_member`
   and rejected the recovery as `resolved_not_of_this_episode`. Recovery now
   includes `resolves: previous.event_key`.
3. **`src/routes/scraper-watchdog.ts` (`ScraperDead`, `ScraperStale`):**
   Recovery omitted `payload.resolves` and lost earlier firing keys across
   cooldown re-fires and `stale -> dead` escalations. Firing keys are now
   tracked in `scraper_watchdog_state` (`firing_alerts`) and each receives a
   resolved twin carrying `payload.resolves` on recovery (with a safe inbox
   fallback for pre-upgrade state rows).
4. **`src/routes/video-library-scraper.ts` (`VideoLibraryScrapeFailed`) & `src/lib/scraperAlerts.ts` (`workers.scraper`):**
   Clean `scope: 'full'` video-library scrapes and clean `evaluateAndAlert` runs
   now resolve open firing alerts for their own scope/scraper via
   `resolveOpenOperationalAlerts`.
5. **Class hardening (`src/lib/operationalAlerts.ts`, `src/lib/operationalAlertResolution.ts`, `src/lib/operational-alert-resolution.law.test.ts`):**
   - `recordOperationalAlert` rejects `status: 'resolved'` events whose
     `payload.resolves` is empty/non-string or equals `eventKey` (since
     `fn_record_operational_alert`'s `ON CONFLICT DO UPDATE` never updates
     `status`).
   - `operational-alert-resolution.law.test.ts` fails CI if any firing
     operational alert producer in `src/` lacks a twin-event resolve path or
     drops `payload.resolves`.
