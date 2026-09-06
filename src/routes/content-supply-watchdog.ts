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
  const facts: Record<string, unknown> = {};

  // 1. Is the reel queue draining?
  const stuckSince = new Date(Date.now() - LIMITS.REEL_QUEUE_HOURS * 3_600_000).toISOString();
  const { count: stuckReels } = await supa
    .from('social_reels')
    .select('*', { count: 'exact', head: true })
    .eq('media_status', 'queued')
    .lt('created_at', stuckSince);
  facts.reels_queued_over_6h = stuckReels ?? 0;
  if ((stuckReels ?? 0) > 0) {
    problems.push(
      `${stuckReels} reels have been queued for more than ${LIMITS.REEL_QUEUE_HOURS}h - the transcode queue is not draining`,
    );
  }

  // 2. Is there enough poker to post?
  const { count: pokerPool } = await supa
    .from('poker_clips')
    .select('*', { count: 'exact', head: true })
    .eq('is_active', true);
  facts.poker_pool = pokerPool ?? 0;
  if ((pokerPool ?? 0) < LIMITS.POKER_POOL_FLOOR) {
    problems.push(
      `only ${pokerPool} live poker clips (floor ${LIMITS.POKER_POOL_FLOOR}) - horses will fall through to sports`,
    );
  }

  // 3. Is the scraper still finding anything? A pool that is big but frozen
  //    is the exact state the 150-clip array was in for five months.
  const silentSince = new Date(Date.now() - LIMITS.SCRAPER_SILENT_HOURS * 3_600_000).toISOString();
  const { count: freshClips } = await supa
    .from('poker_clips')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', silentSince);
  facts.poker_clips_added_recently = freshClips ?? 0;
  if ((freshClips ?? 0) === 0) {
    problems.push(
      `no poker clips added in ${LIMITS.SCRAPER_SILENT_HOURS}h - the channel scraper has stopped finding videos`,
    );
  }

  // 4. Are the sources themselves alive? Individual channels go away, which
  //    is ordinary; half of them going away at once means we broke something.
  const { count: totalSources } = await supa
    .from('content_sources')
    .select('*', { count: 'exact', head: true })
    .eq('domain', 'poker');
  const { count: activeSources } = await supa
    .from('content_sources')
    .select('*', { count: 'exact', head: true })
    .eq('domain', 'poker')
    .eq('is_active', true);
  facts.poker_sources_total = totalSources ?? 0;
  facts.poker_sources_active = activeSources ?? 0;
  if ((totalSources ?? 0) > 0 && (activeSources ?? 0) / (totalSources ?? 1) < LIMITS.DEAD_SOURCE_SHARE) {
    problems.push(
      `only ${activeSources} of ${totalSources} poker sources still active - the resolver or the feed parser is broken, not the channels`,
    );
  }

  if (problems.length) {
    console.warn('[content-supply-watchdog] ' + problems.join(' | '));
  }

  return c.json({
    success: true,
    healthy: problems.length === 0,
    timestamp: new Date().toISOString(),
    problems,
    facts,
  });
}
