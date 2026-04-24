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

## What's intentionally NOT here

Per plan "out-of-scope" list:
- No Express/Next.js — we don't need SSR, image opt, or a Pages Router
- No database migrations (all schema lives in the Supabase project, managed via World Hub migrations)
- No scheduler — Open Claw is the sole scheduler for all scheduled jobs
