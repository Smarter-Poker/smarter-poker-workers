/**
 * smarter-poker-workers
 * Hono service dispatched by Open Claw on Hetzner.
 *
 * Phase 2B.1 SCAFFOLD — ships with ONE endpoint only: GET /health.
 * Future phases (2B.2) port cron handlers from pages/api/cron/*.js
 * in the World Hub repo into src/routes/*.ts here, wave by wave.
 */
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import * as Sentry from '@sentry/node';
import { requireCronSecret, ipAllowlist } from './middleware/auth.js';
import { health } from './routes/health.js';
import { videoLibraryViews } from './routes/video-library-views.js';
import { videoLibraryBackfill } from './routes/video-library-backfill.js';
import { scraperDataCleanup } from './routes/scraper-data-cleanup.js';
import { venueReviewPrompts } from './routes/venue-review-prompts.js';
import { venueGameAlerts } from './routes/venue-game-alerts.js';
import { licenseReminders } from './routes/license-reminders.js';
import { scraperWatchdog } from './routes/scraper-watchdog.js';

// ─── Sentry — fire-and-forget error reporting ──────────────────────────────
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? 'production',
    tracesSampleRate: 0.1,
    release: process.env.GIT_SHA ?? 'dev',
  });
}

// ─── App ────────────────────────────────────────────────────────────────────
const app = new Hono();

// Public healthcheck — no auth, no IP allowlist. Needed by Open Claw + monitors.
app.get('/health', health);
app.get('/', (c) => c.text('smarter-poker-workers — GET /health for liveness'));

// All other routes are scheduled-job endpoints.
// MUST go through both middlewares: Bearer token + IP allowlist.
// As of 2B.1 scaffold, there are zero endpoints here. Phase 2B.2 adds them.
app.use('/cron/*', ipAllowlist);
app.use('/cron/*', requireCronSecret);

// Keep the scaffold ping — makes middleware chain testable without relying
// on real cron handlers being live.
app.get('/cron/_scaffold-ping', (c) =>
  c.json({ ok: true, message: 'If you see this authed, the auth chain works.' }),
);

// ─── Phase 2B.2 — ported cron handlers ─────────────────────────────────────
// Each one must have: (a) a monolith source file referenced in its doc comment,
// (b) a unit test, (c) a README entry documenting the Open Claw URL swap.
// Handler is the SAME function for GET (status) and POST (report ingest);
// query string `?report=1` distinguishes the modes.

app.get('/cron/video-library-views', videoLibraryViews);
app.post('/cron/video-library-views', videoLibraryViews);
app.get('/cron/video-library-backfill', videoLibraryBackfill);
app.post('/cron/video-library-backfill', videoLibraryBackfill);
app.get('/cron/scraper-data-cleanup', scraperDataCleanup);
app.post('/cron/scraper-data-cleanup', scraperDataCleanup);
app.get('/cron/venue-review-prompts', venueReviewPrompts);
app.post('/cron/venue-review-prompts', venueReviewPrompts);
app.get('/cron/venue-game-alerts', venueGameAlerts);
app.post('/cron/venue-game-alerts', venueGameAlerts);
app.get('/cron/license-reminders', licenseReminders);
app.post('/cron/license-reminders', licenseReminders);
app.get('/cron/scraper-watchdog', scraperWatchdog);
app.post('/cron/scraper-watchdog', scraperWatchdog);

// ─── Error boundary ─────────────────────────────────────────────────────────
app.onError((err, c) => {
  console.error('[workers] unhandled error:', err);
  Sentry.captureException(err);
  return c.json({ error: 'internal' }, 500);
});

// ─── Server start ───────────────────────────────────────────────────────────
const port = Number.parseInt(process.env.PORT ?? '8081', 10);
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`[workers] listening on :${info.port}`);
});

// Graceful shutdown for Docker.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.log(`[workers] received ${sig}, flushing Sentry and exiting`);
    Sentry.close(2000).then(() => process.exit(0));
  });
}
