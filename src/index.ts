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
import { videoLibraryReels } from './routes/video-library-reels.js';
import { scraperDataCleanup } from './routes/scraper-data-cleanup.js';
import { venueReviewPrompts } from './routes/venue-review-prompts.js';
import { venueGameAlerts } from './routes/venue-game-alerts.js';
import { licenseReminders } from './routes/license-reminders.js';
import { scraperWatchdog } from './routes/scraper-watchdog.js';
import { clawbotOrchestrator } from './routes/clawbot-orchestrator.js';
import { unionRakeback } from './routes/union-rakeback.js';
import { autoSettlementDistribute } from './routes/auto-settlement-distribute.js';
import { autoSettlement } from './routes/auto-settlement.js';
import { deployErrorPoll } from './routes/deploy-error-poll.js';
import { videoLibraryScraper } from './routes/video-library-scraper.js';
import { videoLibraryPurge } from './routes/video-library-purge.js';
import { purgeIdempotencyKeys } from './routes/purge-idempotency-keys.js';
import { chipSupplySnapshot } from './routes/chip-supply-snapshot.js';
import { solverWatchdog } from './routes/solver-watchdog.js';
import { cronStalenessWatchdog } from './routes/cron-staleness-watchdog.js';
import { refreshVenueJson } from './routes/refresh-venue-json.js';
import { contentHealthCheck } from './routes/content-health-check.js';
import { dailyChallenges } from './routes/daily-challenges.js';
import { pokernewsVideos } from './routes/pokernews-videos.js';
import { triviaPvpCleanup } from './routes/trivia-pvp-cleanup.js';
import { triviaDailyGenerator } from './routes/trivia-daily-generator.js';
import { generateTriviaQuestions } from './routes/generate-trivia-questions.js';
import { triviaPoolMonitor } from './routes/trivia-pool-monitor.js';
import { triviaQualityAudit } from './routes/trivia-quality-audit.js';
import {
  triviaEmbedBackfill,
  triviaThemeBackfill,
  triviaPlayerRetag,
  triviaRegressionTests,
} from './routes/trivia-quality-tools.js';
import { trainingDailyChallenge } from './routes/training-daily-challenge.js';
import { hardStop } from './routes/hard-stop.js';
import { horsesSocialAll } from './routes/horses-social-all.js';
import { horsesStories } from './routes/horses-stories.js';
import { horseByIndex, horseBatch } from './routes/horse-by-index.js';
import { horsePosts } from './routes/horse-posts.js';
import { scrapeSportsClips } from './routes/scrape-sports-clips.js';
import { scrapePokerClips } from './routes/scrape-poker-clips.js';
import { revalidatePokerClips } from './routes/revalidate-poker-clips.js';
import { contentSupplyWatchdog } from './routes/content-supply-watchdog.js';
import { phase6Content } from './routes/phase6-content.js';
import { memoryMatrixDailyChallenge } from './routes/memory-matrix-daily-challenge.js';
import { pokerNews } from './routes/poker-news.js';
import { venueTournaments } from './routes/venue-tournaments.js';
import { scrapeCharitySchedules } from './routes/scrape-charity-schedules.js';
import { newsScraper } from './routes/news-scraper.js';
import { ledgerReconcile } from './routes/ledger-reconcile.js';
import { vipStatusCheck } from './routes/vip-status-check.js';
import { vipDiamondStipend } from './routes/vip-diamond-stipend.js';
import { commanderDailyAggregate } from './routes/commander-daily-aggregate.js';
import { trainingDailyReport } from './routes/training-daily-report.js';
import { trainingCacheDriftAudit } from './routes/training-cache-drift-audit.js';
import { freerollQualificationSync } from './routes/freeroll-qualification-sync.js';
import { collusionScan } from './routes/collusion-scan.js';
import { triviaTournaments } from './routes/trivia-tournaments.js';
import { triviaTournamentRounds } from './routes/trivia-tournament-rounds.js';
import { horsesSocialFriends } from './routes/horses-social-friends.js';
import { tourScheduleScraperHandler } from './routes/tour-schedule-scraper.js';
// Phase X4 — settlement-chain detectors (every 5 / 1 min)
import { bbjDetect } from './routes/bbj-detect.js';
import { startCronLogSweeper } from './lib/cronLogSweep.js';
import { tournamentBountyDetect } from './routes/tournament-bounty-detect.js';
import { playerStatsRefresh } from './routes/player-stats-refresh.js';
import { rakebackPeriodSettle } from './routes/rakeback-period-settle.js';
// Phase X7.4 — anti-cheat detectors (flag-only per Tier-E v1 contract)
import { antiCheatMultiAccount } from './routes/anti-cheat-multi-account.js';
import { antiCheatBotTiming } from './routes/anti-cheat-bot-timing.js';
import { antiCheatChipDump } from './routes/anti-cheat-chip-dump.js';

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

// Round 67 follow-up: cron_execution_log observability middleware.
// Open Claw fires these endpoints but never wrote an audit row, leaving
// us blind to which crons fired, error rates, durations, etc. This
// middleware writes a started/completed row per request with the route
// path as job_name, fire-and-forget on errors so logging never blocks
// the underlying job.
import { getSupabase as _getSupabaseForLog } from './lib/supabase.js';
import { readResultSummary } from './lib/cronResultSummary.js';

app.use('/cron/*', async (c, next) => {
  const jobName = new URL(c.req.url).pathname;
  const startedAt = new Date().toISOString();
  const supa = _getSupabaseForLog();
  let logRowId: string | null = null;
  try {
    const { data } = await supa
      .from('cron_execution_log')
      .insert({ job_name: jobName, status: 'running', started_at: startedAt })
      .select('id')
      .maybeSingle();
    logRowId = data?.id ?? null;
  } catch {
    /* fire-and-forget */
  }

  const t0 = Date.now();
  let resStatus: 'success' | 'error' = 'success';
  let errMsg: string | null = null;
  let result: Record<string, unknown> = {};
  try {
    await next();
    if (c.res && c.res.status >= 400) {
      resStatus = 'error';
      errMsg = `HTTP ${c.res.status}`;
    }
    result = await readResultSummary(c.res);
  } catch (err) {
    resStatus = 'error';
    errMsg = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    if (logRowId) {
      // x86b — Antigravity surfaced (2026-05-03): the prior `void supa.from(...)
      // .update(...).eq(...)` discarded the PostgREST query builder without
      // ever invoking .then(), so the lazy supabase-js client never sent the
      // PATCH. All rows stayed at status='running' forever — duration_ms,
      // completed_at, and error all permanently null. The original intent was
      // fire-and-forget so we don't block the cron return; .then().catch()
      // does the actual send while still detaching from the request lifecycle.
      supa
        .from('cron_execution_log')
        .update({
          status: resStatus,
          completed_at: new Date().toISOString(),
          duration_ms: Date.now() - t0,
          error: errMsg,
          result,
        })
        .eq('id', logRowId)
        .then(({ error }) => {
          if (error) console.warn('[cron-log] update failed:', error.message);
        });
    }
  }
});

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
// 2026-08-17: the only WORKERS_PREFERRED entry with no route here — 72 firings
// since 2026-05-04, zero successes, every one a 404. See the route header.
app.get('/cron/video-library-reels', videoLibraryReels);
app.post('/cron/video-library-reels', videoLibraryReels);
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
app.get('/cron/clawbot-orchestrator', clawbotOrchestrator);
app.post('/cron/clawbot-orchestrator', clawbotOrchestrator);
app.get('/cron/union-rakeback', unionRakeback);
app.post('/cron/union-rakeback', unionRakeback);
app.get('/cron/auto-settlement-distribute', autoSettlementDistribute);
app.post('/cron/auto-settlement-distribute', autoSettlementDistribute);
app.get('/cron/auto-settlement', autoSettlement);
app.post('/cron/auto-settlement', autoSettlement);
app.get('/cron/deploy-error-poll', deployErrorPoll);
app.post('/cron/deploy-error-poll', deployErrorPoll);
app.get('/cron/video-library-scraper', videoLibraryScraper);
app.post('/cron/video-library-scraper', videoLibraryScraper);
app.get('/cron/video-library-purge', videoLibraryPurge);
app.post('/cron/video-library-purge', videoLibraryPurge);
app.get('/cron/purge-idempotency-keys', purgeIdempotencyKeys);
app.post('/cron/purge-idempotency-keys', purgeIdempotencyKeys);
app.get('/cron/chip-supply-snapshot', chipSupplySnapshot);
app.post('/cron/chip-supply-snapshot', chipSupplySnapshot);
app.get('/cron/solver-watchdog', solverWatchdog);
app.post('/cron/solver-watchdog', solverWatchdog);
app.get('/cron/cron-staleness-watchdog', cronStalenessWatchdog);
app.post('/cron/cron-staleness-watchdog', cronStalenessWatchdog);
app.get('/cron/refresh-venue-json', refreshVenueJson);
app.post('/cron/refresh-venue-json', refreshVenueJson);
app.get('/cron/content-health-check', contentHealthCheck);
app.post('/cron/content-health-check', contentHealthCheck);
app.get('/cron/daily-challenges', dailyChallenges);
app.post('/cron/daily-challenges', dailyChallenges);
app.get('/cron/pokernews-videos', pokernewsVideos);
app.post('/cron/pokernews-videos', pokernewsVideos);
app.get('/cron/trivia-pvp-cleanup', triviaPvpCleanup);
app.post('/cron/trivia-pvp-cleanup', triviaPvpCleanup);
app.get('/cron/trivia-daily-generator', triviaDailyGenerator);
app.post('/cron/trivia-daily-generator', triviaDailyGenerator);
app.get('/cron/generate-trivia-questions', generateTriviaQuestions);
app.post('/cron/generate-trivia-questions', generateTriviaQuestions);
app.get('/cron/trivia-pool-monitor', triviaPoolMonitor);
app.post('/cron/trivia-pool-monitor', triviaPoolMonitor);
app.get('/cron/trivia-quality-audit', triviaQualityAudit);
app.post('/cron/trivia-quality-audit', triviaQualityAudit);
app.get('/cron/trivia-embed-backfill', triviaEmbedBackfill);
app.post('/cron/trivia-embed-backfill', triviaEmbedBackfill);
app.get('/cron/trivia-theme-backfill', triviaThemeBackfill);
app.post('/cron/trivia-theme-backfill', triviaThemeBackfill);
app.get('/cron/trivia-player-retag', triviaPlayerRetag);
app.post('/cron/trivia-player-retag', triviaPlayerRetag);
app.get('/cron/trivia-regression-tests', triviaRegressionTests);
app.post('/cron/trivia-regression-tests', triviaRegressionTests);
app.get('/cron/training-daily-challenge', trainingDailyChallenge);
app.post('/cron/training-daily-challenge', trainingDailyChallenge);
app.get('/cron/hard-stop', hardStop);
app.post('/cron/hard-stop', hardStop);
app.get('/cron/scrape-sports-clips', scrapeSportsClips);
app.post('/cron/scrape-sports-clips', scrapeSportsClips);
// Phase 4: poker gets the renewing supply sports already had.
app.get('/cron/scrape-poker-clips', scrapePokerClips);
app.post('/cron/scrape-poker-clips', scrapePokerClips);
app.get('/cron/revalidate-poker-clips', revalidatePokerClips);
app.post('/cron/revalidate-poker-clips', revalidatePokerClips);
app.get('/cron/content-supply-watchdog', contentSupplyWatchdog);
app.post('/cron/content-supply-watchdog', contentSupplyWatchdog);
// Fleet Content Programme Phase 6. Every publish mode is independently
// approval-gated; preview=1 composes samples without writing.
app.get('/cron/phase6-content', phase6Content);
app.post('/cron/phase6-content', phase6Content);
app.get('/cron/memory-matrix-daily-challenge', memoryMatrixDailyChallenge);
app.post('/cron/memory-matrix-daily-challenge', memoryMatrixDailyChallenge);
app.get('/cron/poker-news', pokerNews);
app.post('/cron/poker-news', pokerNews);
app.get('/cron/venue-tournaments', venueTournaments);
app.post('/cron/venue-tournaments', venueTournaments);
app.get('/cron/scrape-charity-schedules', scrapeCharitySchedules);
app.post('/cron/scrape-charity-schedules', scrapeCharitySchedules);
app.get('/cron/news-scraper', newsScraper);
app.post('/cron/news-scraper', newsScraper);
app.get('/cron/ledger-reconcile', ledgerReconcile);
app.post('/cron/ledger-reconcile', ledgerReconcile);
app.get('/cron/vip-status-check', vipStatusCheck);
app.post('/cron/vip-status-check', vipStatusCheck);
app.get('/cron/vip-diamond-stipend', vipDiamondStipend);
app.post('/cron/vip-diamond-stipend', vipDiamondStipend);
app.get('/cron/commander-daily-aggregate', commanderDailyAggregate);
app.post('/cron/commander-daily-aggregate', commanderDailyAggregate);
app.get('/cron/training-daily-report', trainingDailyReport);
app.post('/cron/training-daily-report', trainingDailyReport);
app.get('/cron/training-cache-drift-audit', trainingCacheDriftAudit);
app.post('/cron/training-cache-drift-audit', trainingCacheDriftAudit);
app.get('/cron/freeroll-qualification-sync', freerollQualificationSync);
app.post('/cron/freeroll-qualification-sync', freerollQualificationSync);
app.get('/cron/collusion-scan', collusionScan);
app.post('/cron/collusion-scan', collusionScan);
app.get('/cron/trivia-tournaments', triviaTournaments);
app.post('/cron/trivia-tournaments', triviaTournaments);
app.get('/cron/trivia-tournament-rounds', triviaTournamentRounds);
app.post('/cron/trivia-tournament-rounds', triviaTournamentRounds);
app.get('/cron/horses-social-friends', horsesSocialFriends);
app.post('/cron/horses-social-friends', horsesSocialFriends);
app.get('/cron/horses-social-all', horsesSocialAll);
app.post('/cron/horses-social-all', horsesSocialAll);
app.get('/cron/horses-stories', horsesStories);
app.post('/cron/horses-stories', horsesStories);
app.get('/cron/horse/:horseIndex', horseByIndex);
app.post('/cron/horse/:horseIndex', horseByIndex);
app.get('/cron/horse-batch/:horseIndex', horseBatch);
app.post('/cron/horse-batch/:horseIndex', horseBatch);
// Fleet Content Programme phase 1 (2026-09-05): hourly, whole fleet. The
// horse-batch routes above are the hand-over shim; see routes/horse-by-index.ts.
app.get('/cron/horse-posts', horsePosts);
app.post('/cron/horse-posts', horsePosts);
app.get('/cron/tour-schedule-scraper', tourScheduleScraperHandler);
app.post('/cron/tour-schedule-scraper', tourScheduleScraperHandler);

// ─── Phase X4 — settlement-chain detectors (closes P0-A5/D2/H1) ────────────
app.get('/cron/bbj-detect', bbjDetect);
app.post('/cron/bbj-detect', bbjDetect);
app.get('/cron/tournament-bounty-detect', tournamentBountyDetect);
app.post('/cron/tournament-bounty-detect', tournamentBountyDetect);
app.get('/cron/player-stats-refresh', playerStatsRefresh);
app.post('/cron/player-stats-refresh', playerStatsRefresh);
app.get('/cron/rakeback-period-settle', rakebackPeriodSettle);
app.post('/cron/rakeback-period-settle', rakebackPeriodSettle);

// ─── Phase X7.4 — anti-cheat detectors (closes P0-E1 + P0-E2) ──────────────
app.get('/cron/anti-cheat-multi-account', antiCheatMultiAccount);
app.post('/cron/anti-cheat-multi-account', antiCheatMultiAccount);
app.get('/cron/anti-cheat-bot-timing', antiCheatBotTiming);
app.post('/cron/anti-cheat-bot-timing', antiCheatBotTiming);
app.get('/cron/anti-cheat-chip-dump', antiCheatChipDump);
app.post('/cron/anti-cheat-chip-dump', antiCheatChipDump);

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
  // Reap cron_execution_log rows orphaned as 'running' by container restarts.
  startCronLogSweeper();
});

// Graceful shutdown for Docker.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.log(`[workers] received ${sig}, flushing Sentry and exiting`);
    Sentry.close(2000).then(() => process.exit(0));
  });
}
