# smarter-poker-workers

Scheduled job workers for smarter.poker. Hono + TypeScript service,
dispatched by [Open Claw](https://github.com/Smarter-Poker/Smarter-Poker-World-Hub/blob/main/scripts/openclaw-cron-dispatcher.py)
running on a separate Hetzner VM.

**Phase 2B.1 scaffold — ships with ZERO endpoints migrated.** Just the
skeleton, CI, and healthcheck. Phase 2B.2 ports cron handlers wave-by-wave
from `pages/api/cron/*.js` in the World Hub repo into `src/routes/*.ts`
here, following the same migration pattern as Phase 2A.4.

## Why this repo exists

See `~/Documents/smarter-poker-optimization-plan.md` §Phase 2B. TL;DR:
- World Hub monolith has ~45 `pages/api/cron/` handler files
- They bloat the Vercel serverless build (puppeteer, chromium, sharp)
- Moving them to a dedicated repo lets World Hub drop those deps and
  shrink the build to < 15 min (Phase 2B.3 goal)

## Architecture

```
Open Claw (nbg1, CX23)              This service (target: separate CPX21)
  systemd openclaw.service            Docker / docker-compose
           │                                   ▲
           │  Authorization: Bearer SECRET    │
           │  GET/POST workers.../cron/:name  │
           └──────────────────────────────────┘
                       HTTPS + IP allowlist
```

## Local dev

```bash
npm ci
cp .env.example .env.local     # fill in CRON_SECRET + supabase keys
npm run dev                    # tsx watch on :8081
curl http://127.0.0.1:8081/health
```

## Auth — every route under `/cron/*`

Two middlewares stacked in `src/index.ts`:

1. `ipAllowlist` — only accepts requests from IPs in `ALLOWED_CRON_IPS`
   env var. In production, that's Open Claw's Hetzner IP (`178.104.160.250`)
   and `127.0.0.1` for local healthchecks.
2. `requireCronSecret` — rejects anything whose `Authorization` header
   doesn't match `Bearer $CRON_SECRET`.

`/health` is public (no auth). Monitors hit it directly.

## Deploying

Release workflow (`.github/workflows/release.yml`) builds `linux/amd64`
Docker image and pushes to GHCR on tag or manual dispatch:

```
ghcr.io/smarter-poker/smarter-poker-workers:latest
ghcr.io/smarter-poker/smarter-poker-workers:sha-<short>
ghcr.io/smarter-poker/smarter-poker-workers:v1.2.3  # on tag
```

The Hetzner workers VM pulls `latest` via `docker compose pull && docker compose up -d`.
See the AG prompt at `~/Documents/antigravity-phase2b1-deploy-workers.md`
(to be written once the VM is provisioned) for the one-time VM bootstrap.

## Governance — how to ADD a new cron endpoint

This is the canonical procedure once Phase 2B.2 starts. Scaffold only right now,
so the only route that exists is `/health` and the reserved `/cron/_scaffold-ping`.

1. Port the handler from `pages/api/cron/<name>.js` in World Hub to
   `src/routes/<name>.ts` here. Keep logic identical — no refactor yet.
2. Wire it up in `src/index.ts`:
   ```ts
   import { handleMyCron } from './routes/my-cron.js';
   app.post('/cron/my-cron', handleMyCron);  // or .get(), matching original method
   ```
3. Tag a release (`git tag v1.X.Y && git push --tags`) — release workflow
   auto-builds + pushes `ghcr.io/smarter-poker/smarter-poker-workers:vX.Y`
   and `:latest`.
4. Deploy on Hetzner workers VM: `ssh` in, `cd /opt/workers`, `docker compose pull && docker compose up -d`.
5. Test with the shared `$CRON_SECRET`:
   ```bash
   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
     https://workers.smarter.poker/cron/my-cron
   ```
6. Update Open Claw's schedule entry in
   `scripts/openclaw-cron-dispatcher.py` to point at the new URL
   (was `https://smarter.poker/api/cron/my-cron`, now
   `https://workers.smarter.poker/cron/my-cron`). Push, then run
   `bash scripts/deploy-openclaw.sh` from the World Hub repo.
7. In the SAME PR as step 6, delete `pages/api/cron/<name>.js` from World Hub
   (atomic cutover per plan line 316).
8. Monitor 48 h, then move to the next endpoint.

## Security posture

- Private GHCR image, private repo (public access would leak `.github/workflows/release.yml` internals)
- Container runs as non-root UID 10001
- Read-only root filesystem (`/tmp` is tmpfs-only)
- `no-new-privileges` seccomp flag
- Memory cap 512M, CPU cap 1.5
- Bound to `127.0.0.1:8081` — external traffic must route through a
  reverse proxy (Caddy/nginx) with TLS, rate limit, optionally Cloudflare
- `CRON_SECRET` + IP allowlist, defense-in-depth

## Observability

- Sentry for uncaught exceptions (DSN via env)
- stdout → Docker json-file (10 MB × 7 rotation)
- `/health` endpoint for readiness + liveness + monitors
- PostHog for optional event emissions (reusing World Hub's project)
- `cron_execution_log` — one row per `/cron/*` request (middleware in `src/index.ts`)
- `cron_health_log` — current-state row per watchdog, keyed on `cron_name`

### Auth-health monitor — `/cron/auth-health-monitor`

The one check in this fleet that watches **production auth at runtime**.

Background: the World Hub JWT verifier stayed hardcoded to HS256 after the
Supabase project moved to ES256 signing keys. Local verification failed on
every authenticated request; each one fell through to a live GoTrue
`/auth/v1/user` call (~20M edge requests/24h) until it saturated the
project-wide auth rate limit and caused a site-wide logout loop. It ran
undetected for months. The regression guards that came out of it
(World-Hub #1196/#1198/#1210/#1220, commander #77/#78) are all build-time and
cannot see a key rotation, an env change, or a stale cached bundle.

| check | needs a credential? | alerts when |
| --- | --- | --- |
| `jwks_algorithm_drift` | no | JWKS stops serving ES256, goes empty, or is unreachable |
| `jwks_import_canary` | no | live key material fails `crypto.subtle.importKey` as ECDSA P-256 |
| `gotrue_fallback_ratio` | yes | **successful** `/user` volume > 8,000/h (critical), > 4,000/h or > 65% of auth traffic (warn) |
| `signature_algorithm_errors` | yes | signature errors exceed 2% of successful `/user` calls **while** fallback volume is itself elevated |
| `signature_error_sources` | yes | *informational only* — reports external HS256 replay volume and the top offending IPs. Never pages. |
| `refresh_token_failures` | yes | refresh not-found + bad-length > 100/h |
| `credential_stuffing` | yes | `Possible abuse attempt` > 200/h (top offending IPs included) |

#### Which number actually means something

Read this before tuning anything. The one signal worth paging on is
**successful GoTrue `/user` calls per hour**, because it is purely our own
traffic — an attacker's forged token does not produce a 200. When the ES256
fix reached production on 2026-09-01 it collapsed from 20,752/h to 91/h
inside a few hours, and it is the number that would climb straight back if the
fast path broke again.

The raw count of `signing method HS256 is invalid` is **not** an app-health
metric, and treating it as one was a bug in the first draft of this monitor.
With the fix confirmed working, that counter still ran at 826–4,325/h: external
bots replaying forged or stale HS256 tokens at `/user` from rotating Azure
address space, carrying no `user_id`, at ~259 hits per IP across 38 IPs. It was
always there; it only became visible as a *proportion* once our own fallback
noise disappeared, and it will never reach zero because we do not control who
sends us tokens. Alerting on it would page on every bot wave, forever — which
is exactly the alert fatigue that let the original outage hide behind a green
test for months.

So `signature_algorithm_errors` is gated: it can only fire when app-origin
fallback volume is *also* elevated. The bot traffic is reported separately by
`signature_error_sources` at informational `security` severity, which carries
the offending IPs for a WAF blocklist and can never change the health verdict.
Full derivation, with the hourly numbers, is in the header block of
`src/lib/authHealth.ts`.

The five credentialed checks read Supabase `auth_logs`, which is a log stream
rather than a table and therefore **not** reachable through the service-role
PostgREST client in `src/lib/supabase.ts`. They go through the Management API
analytics endpoint and are gated on `SUPABASE_MANAGEMENT_API_TOKEN`. Without
it they report `skipped`; the job still runs and still catches key drift.

Thresholds are env-tunable — see `.env.example` and the reasoning comments in
`src/lib/authHealth.ts`.

Results land in `cron_health_log` (`cron_name='auth-health-monitor'`), a
`[auth-health-monitor] AUTH-ALERT` line on stderr, and an SMS through
`src/lib/scraperAlerts.ts` on `critical`. Security notices use a **separate**
`[auth-health-monitor] AUTH-SECURITY` prefix — keep the two distinct in any
log-drain rule, since paging on the second one defeats the point.

```bash
# locally
npm run dev
curl -H "Authorization: Bearer $CRON_SECRET" \
  http://127.0.0.1:8081/cron/auth-health-monitor | jq

# just the thresholds
npx vitest run src/lib/authHealth.test.ts
```

## What's intentionally NOT here

Per plan "out-of-scope" list:
- No Express/Next.js — we don't need SSR, image opt, or a Pages Router
- No database migrations (all schema lives in the Supabase project, managed via World Hub migrations)
- No scheduler — Open Claw is the sole scheduler for all scheduled jobs

## How code lands here

`main` is protected by a ruleset, and agents do not merge. The sequence is:

1. Branch from a freshly fetched `origin/main` — one working tree per agent,
   never a shared checkout.
2. Push the branch and open a pull request.
3. **Stop.** `.github/workflows/agent-autopilot.yml` turns on squash
   auto-merge, keeps the branch fresh as `main` moves, and GitHub merges it
   the moment the required check goes green.

The required check is **`Typecheck + Lint + Test + Build`** — the `checks` job
in `ci.yml`. It is the only thing standing between a branch and `main`:
`required_approving_review_count` is 0 and `bypass_actors` is empty, so nobody
and nothing can merge past a red one.

Before that rule existed, Autopilot merged on a mergeable state of `CLEAN`,
which means "nothing is failing" — with no required check, that is the same
sentence as "nothing was checked".

Two things will strand every PR in this repo, so they are worth knowing:

- **Renaming the `checks` job.** The rule requires the job's `name:` string.
  Change it in `ci.yml` and GitHub waits forever for a context that no longer
  reports. Change the ruleset in the same PR or leave the name alone.
- **Requiring a job that does not run on `pull_request`.** Same outcome, same
  reason. `ci.yml` triggers on both `push` and `pull_request` today; keep it
  that way.
