/**
 * GET/POST /cron/horse-video-reels
 *
 * The isolated horse video producer. It deliberately does not consult the
 * mixed fleet `engine_enabled` switch and never calls the general horse
 * publisher. Only the separately approved `poker_video` and `sports_video`
 * modes can run, and the publisher has the same gates again at its write
 * boundary.
 */
import type { Context } from 'hono';
import { isDueForPost, DUE_WINDOW_HOURS } from '../lib/content-engine/FleetScheduler.js';
import { loadFleet, postModeEnabled } from '../lib/content-engine/Fleet.js';
import {
  publishVideoForHorse,
  takeSupplyStats,
  type PublishResult,
} from '../lib/content-engine/HorsePublisher.js';
import type { HorseVideoTopic } from '../lib/content-engine/HorseVideoPublication.js';

export const MAX_HORSE_VIDEO_REELS_PER_RUN = 80;
export const HORSE_VIDEO_REELS_DEADLINE_MS = 540_000;

export async function horseVideoReels(c: Context) {
  const startedAt = Date.now();
  const now = new Date();
  try {
    const [pokerEnabled, sportsEnabled] = await Promise.all([
      postModeEnabled('poker_video'),
      postModeEnabled('sports_video'),
    ]);
    const allowedTypes: HorseVideoTopic[] = [];
    if (pokerEnabled) allowedTypes.push('poker');
    if (sportsEnabled) allowedTypes.push('sports');
    if (!allowedTypes.length) {
      return c.json({
        success: true,
        skipped: 'video_modes_disabled',
        modes: { poker_video: false, sports_video: false },
        posted: 0,
        timestamp: now.toISOString(),
      });
    }

    const fleet = await loadFleet();
    const due = fleet
      .map((horse) => ({ horse, slot: isDueForPost(horse.profile_id, horse.timezone, now) }))
      .filter((item) => item.slot.due)
      .sort((a, b) => (b.slot.age ?? 0) - (a.slot.age ?? 0));
    const queue = due.slice(0, MAX_HORSE_VIDEO_REELS_PER_RUN);
    const results: PublishResult[] = [];
    let deadlineHit = false;

    // One writer at a time. The asset ledger protects durable retries, while
    // serialization prevents two horses in this run selecting the same fresh
    // clip before the first transaction records it.
    for (const item of queue) {
      if (Date.now() - startedAt > HORSE_VIDEO_REELS_DEADLINE_MS) {
        deadlineHit = true;
        break;
      }
      try {
        results.push(await publishVideoForHorse(item.horse, {
          fleet,
          now,
          allowedTypes,
        }));
      } catch (error) {
        results.push({
          success: false,
          horse: item.horse.name,
          profile_id: item.horse.profile_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const posted = results.filter((result) => result.success);
    const skipped = results.filter((result) => result.skipped === 'posted_recently');
    const failed = results.filter((result) => !result.success && !result.skipped);
    const errors: Record<string, number> = {};
    for (const result of failed) {
      const key = result.error ?? 'unknown';
      errors[key] = (errors[key] ?? 0) + 1;
    }

    // Do not let an enabled producer report a healthy HTTP 200 when every
    // attempted publication failed. Open Claw's critical-job monitor keys on
    // the response status, while partial progress and guard-race skips remain
    // successful runs with their detailed counts intact.
    const systemicFailure = (
      (results.length > 0 && posted.length === 0 && skipped.length === 0 && failed.length === results.length)
      || (deadlineHit && results.length === 0 && due.length > 0)
    );
    const payload = {
      success: !systemicFailure,
      fleet: fleet.length,
      due: due.length,
      attempted: results.length,
      posted: posted.length,
      created: posted.filter((result) => result.created === true).length,
      replayed: posted.filter((result) => result.created === false).length,
      skipped_recent: skipped.length,
      failed: failed.length,
      by_type: posted.reduce<Record<string, number>>((counts, result) => {
        const key = result.type ?? 'unknown';
        counts[key] = (counts[key] ?? 0) + 1;
        return counts;
      }, {}),
      errors,
      modes: { poker_video: pokerEnabled, sports_video: sportsEnabled },
      supply: takeSupplyStats(),
      deadline_hit: deadlineHit,
      cap_hit: due.length > MAX_HORSE_VIDEO_REELS_PER_RUN,
      due_window_hours: DUE_WINDOW_HOURS,
      duration_ms: Date.now() - startedAt,
      timestamp: now.toISOString(),
      post_ids: posted.map((result) => result.postId).filter(Boolean),
      reel_ids: posted.map((result) => result.reelId).filter(Boolean),
    };
    return c.json(payload, systemicFailure ? 503 : 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[horse-video-reels] fatal:', message);
    return c.json({ success: false, error: message }, 500);
  }
}
