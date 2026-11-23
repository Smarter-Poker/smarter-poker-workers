/**
 * GET/POST /cron/content-supply-watchdog
 *
 * Says out loud when the fleet's supply stops moving.
 *
 * WHY THIS EXISTS. Both Phase 4 defects were silent for weeks, and both were
 * found by a person reading rows rather than by anything watching:
 *
 *   - 144 reels sat at media_status='queued' from 2026-08-05 to 2026-09-06,
 *     twenty-three days invisible to every viewer, because the job they were
 *     waiting on had failed and nothing told the reel.
 *   - The poker clip pool was a frozen list of 150 with 36 dead videos in it,
 *     while the ledger correctly refused to repeat any of them, so horses
 *     quietly fell through to sports instead of posting poker.
 *
 * Neither failure was loud. A queue that stops draining and a pool that stops
 * growing both look exactly like a quiet week - that is what makes them
 * expensive. This asks the four questions whose answers would have caught
 * both, and returns a `problems` array so a bad answer is a fact in
 * cron_execution_log rather than something a person has to go looking for.
 *
 * It reports; it does not repair. A watchdog that fixes things is a watchdog
 * whose alarm nobody ever sees, and the repairs here belong to triggers and
 * scrapers that can be reasoned about on their own.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const LIMITS = {
  /** A reel queued longer than this is not "in progress", it is stuck. */
  REEL_QUEUE_HOURS: 6,
  /** Below this many live poker clips the fallback to sports starts. */
  POKER_POOL_FLOOR: 400,
  /** A scraper that has added nothing for this long has stopped working. */
  SCRAPER_SILENT_HOURS: 26,
  /** Sources failing this many runs in a row point at a broken scraper. */
  DEAD_SOURCE_SHARE: 0.5,
} as const;

export async function contentSupplyWatchdog(c: Context) {
  const supa = getSupabase();
  const problems: string[] = [];
  const queryErrors: string[] = [];
  const facts: Record<string, unknown> = {};

  const recordError = (label: string, error: { message?: string } | null | undefined) => {
    if (!error) return false;
    const msg = `${label} query failed: ${error.message ?? 'unknown error'}`;
    queryErrors.push(msg);
    problems.push(msg);
    return true;
  };

  // 1. Is the reel queue draining?
  const stuckSince = new Date(Date.now() - LIMITS.REEL_QUEUE_HOURS * 3_600_000).toISOString();
  const stuckRes = await supa
    .from('social_reels')
    .select('*', { count: 'exact', head: true })
    .eq('media_status', 'queued')
    .lt('created_at', stuckSince);
  if (!recordError('social_reels queued count', stuckRes.error)) {
    const stuckReels = stuckRes.count ?? 0;
    facts.reels_queued_over_6h = stuckReels;
    if (stuckReels > 0) {
      problems.push(
        `${stuckReels} reels have been queued for more than ${LIMITS.REEL_QUEUE_HOURS}h - the transcode queue is not draining`,
      );
    }
  } else {
    facts.reels_queued_over_6h = null;
  }

  // 2. Is there enough poker to post? (Exclude slots contamination.)
  const poolRes = await supa
    .from('poker_clips')
    .select('*', { count: 'exact', head: true })
    .eq('is_active', true)
    .or('category.is.null,category.neq.slots');
  if (!recordError('poker_clips active count', poolRes.error)) {
    const pokerPool = poolRes.count ?? 0;
    facts.poker_pool = pokerPool;
    if (pokerPool < LIMITS.POKER_POOL_FLOOR) {
      problems.push(
        `only ${pokerPool} live poker clips (floor ${LIMITS.POKER_POOL_FLOOR}) - horses will fall through to sports`,
      );
    }
  } else {
    facts.poker_pool = null;
  }

  // 3. Is the scraper still finding anything? A pool that is big but frozen
  //    is the exact state the 150-clip array was in for five months.
  const silentSince = new Date(Date.now() - LIMITS.SCRAPER_SILENT_HOURS * 3_600_000).toISOString();
  const freshRes = await supa
    .from('poker_clips')
    .select('*', { count: 'exact', head: true })
    .or('category.is.null,category.neq.slots')
    .gte('created_at', silentSince);
  if (!recordError('poker_clips recent count', freshRes.error)) {
    const freshClips = freshRes.count ?? 0;
    facts.poker_clips_added_recently = freshClips;
    if (freshClips === 0) {
      problems.push(
        `no poker clips added in ${LIMITS.SCRAPER_SILENT_HOURS}h - the channel scraper has stopped finding videos`,
      );
    }
  } else {
    facts.poker_clips_added_recently = null;
  }

  // 4. Are the sources themselves alive? Measure poker YouTube channels only
  //    (never RSS news rows, never slots channels) among those that resolved
  //    at least once (last_ok_at IS NOT NULL).
  const totalRes = await supa
    .from('content_sources')
    .select('*', { count: 'exact', head: true })
    .eq('domain', 'poker')
    .eq('kind', 'youtube_channel')
    .or('category.is.null,category.neq.slots');
  const activeRes = await supa
    .from('content_sources')
    .select('*', { count: 'exact', head: true })
    .eq('domain', 'poker')
    .eq('kind', 'youtube_channel')
    .or('category.is.null,category.neq.slots')
    .eq('is_active', true);
  const everResolvedRes = await supa
    .from('content_sources')
    .select('*', { count: 'exact', head: true })
    .eq('domain', 'poker')
    .eq('kind', 'youtube_channel')
    .or('category.is.null,category.neq.slots')
    .not('last_ok_at', 'is', null);
  const activeEverResolvedRes = await supa
    .from('content_sources')
    .select('*', { count: 'exact', head: true })
    .eq('domain', 'poker')
    .eq('kind', 'youtube_channel')
    .or('category.is.null,category.neq.slots')
    .eq('is_active', true)
    .not('last_ok_at', 'is', null);

  const sourceReadFailed = [
    recordError('content_sources total count', totalRes.error),
    recordError('content_sources active count', activeRes.error),
    recordError('content_sources ever-resolved count', everResolvedRes.error),
    recordError('content_sources active-ever-resolved count', activeEverResolvedRes.error),
  ].some(Boolean);

  if (!sourceReadFailed) {
    const totalSources = totalRes.count ?? 0;
    const activeSources = activeRes.count ?? 0;
    const everResolved = everResolvedRes.count ?? 0;
    const activeEverResolved = activeEverResolvedRes.count ?? 0;
    facts.poker_sources_total = totalSources;
    facts.poker_sources_active = activeSources;
    facts.poker_sources_ever_resolved = everResolved;
    facts.poker_sources_active_ever_resolved = activeEverResolved;
    if (
      everResolved > 0
      && activeEverResolved / everResolved < LIMITS.DEAD_SOURCE_SHARE
    ) {
      problems.push(
        `only ${activeEverResolved} of ${everResolved} poker sources that ever resolved are still active - the resolver or the feed parser is broken, not the channels`,
      );
    }
  } else {
    facts.poker_sources_total = null;
    facts.poker_sources_active = null;
    facts.poker_sources_ever_resolved = null;
    facts.poker_sources_active_ever_resolved = null;
  }

  if (problems.length) {
    console.warn('[content-supply-watchdog] ' + problems.join(' | '));
  }

  if (queryErrors.length > 0) {
    return c.json(
      {
        success: false,
        healthy: false,
        timestamp: new Date().toISOString(),
        problems,
        query_errors: queryErrors,
        facts,
      },
      500,
    );
  }

  return c.json({
    success: true,
    healthy: problems.length === 0,
    timestamp: new Date().toISOString(),
    problems,
    facts,
  });
}
