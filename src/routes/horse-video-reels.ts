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
import {
  fleetHash,
  isDueForPost,
  DUE_WINDOW_HOURS,
  type DueResult,
} from '../lib/content-engine/FleetScheduler.js';
import { loadFleet, readPostModeStates } from '../lib/content-engine/Fleet.js';
import {
  prepareSharedHorseVideoSupply,
  publishVideoForHorse,
  takeSupplyStats,
  type PublishResult,
  type SharedHorseVideoSupply,
} from '../lib/content-engine/HorsePublisher.js';
import type { HorseVideoTopic } from '../lib/content-engine/HorseVideoPublication.js';

export const MAX_HORSE_VIDEO_REELS_PER_RUN = 80;
export const HORSE_VIDEO_REELS_DEADLINE_MS = 540_000;
export const HORSE_VIDEO_QUEUE_STRATEGY = 'deterministic_round_robin_v1';

interface DueHorseVideoItem {
  horse: { profile_id: string };
  slot: DueResult;
}

export interface FairHorseVideoQueue<T> {
  queue: T[];
  cursor: number;
}

/**
 * Select a stable, hourly cohort without storing mutable cursor state.
 *
 * The prior `age DESC LIMIT 80` always returned the same oldest horses. A
 * permanently failing first cohort could therefore prevent every later due
 * horse from ever being attempted. For an over-cap run, this selector hashes
 * the full due set into a stable ring and advances exactly one capacity-sized
 * window each UTC hour. Retries inside the same hour see the same cohort;
 * scheduled hourly runs advance to the next one. Within the selected cohort,
 * older due slots retain priority.
 */
export function selectFairHorseVideoQueue<T extends DueHorseVideoItem>(
  due: readonly T[],
  now: Date,
  limit = MAX_HORSE_VIDEO_REELS_PER_RUN,
): FairHorseVideoQueue<T> {
  const capacity = Math.max(0, Math.floor(limit));
  const ageOrder = (a: T, b: T) => (
    (b.slot.age ?? 0) - (a.slot.age ?? 0)
    || a.horse.profile_id.localeCompare(b.horse.profile_id)
  );
  if (capacity === 0 || due.length === 0) return { queue: [], cursor: 0 };
  if (due.length <= capacity) {
    return { queue: [...due].sort(ageOrder), cursor: 0 };
  }

  const ring = [...due].sort((a, b) => (
    fleetHash(a.horse.profile_id, 'horse-video-queue-order')
      - fleetHash(b.horse.profile_id, 'horse-video-queue-order')
    || a.horse.profile_id.localeCompare(b.horse.profile_id)
  ));
  const epochHour = Math.floor(now.getTime() / 3_600_000);
  const offset = fleetHash('horse-video-reels', 'queue-cursor') % ring.length;
  const cursor = (
    offset
    + (epochHour % ring.length) * (capacity % ring.length)
  ) % ring.length;
  const queue = Array.from(
    { length: Math.min(capacity, ring.length) },
    (_, index) => ring[(cursor + index) % ring.length]!,
  ).sort(ageOrder);
  return { queue, cursor };
}

export async function horseVideoReels(c: Context) {
  const startedAt = Date.now();
  const now = new Date();
  try {
    let modeStates: Record<'poker_video' | 'sports_video', boolean>;
    try {
      modeStates = await readPostModeStates(['poker_video', 'sports_video']);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[horse-video-reels] mode state unavailable:', message);
      return c.json({ success: false, error: `mode_state_unavailable: ${message}` }, 503);
    }
    const pokerEnabled = modeStates.poker_video;
    const sportsEnabled = modeStates.sports_video;
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
    if (!fleet.length) {
      return c.json({
        success: false,
        error: 'active_horse_fleet_empty',
        modes: { poker_video: pokerEnabled, sports_video: sportsEnabled },
        timestamp: now.toISOString(),
      }, 503);
    }
    const due = fleet
      .map((horse) => ({ horse, slot: isDueForPost(horse.profile_id, horse.timezone, now) }))
      .filter((item) => item.slot.due);
    const selection = selectFairHorseVideoQueue(due, now);
    const queue = selection.queue;
    let runnableTypes = allowedTypes;
    let sharedSupply: SharedHorseVideoSupply | undefined;
    let sharedSupplyCounts: Record<string, unknown> = {};
    if (queue.length > 0) {
      const prepared = await prepareSharedHorseVideoSupply(allowedTypes);
      if (prepared.status === 'unknown') {
        return c.json({
          success: false,
          error: prepared.error,
          fleet: fleet.length,
          due: due.length,
          attempted: 0,
          blocked_preflight: queue.length,
          posted: 0,
          failed: 0,
          unknown: queue.length,
          supply_preflight: 'unknown',
          supply: takeSupplyStats(),
          modes: { poker_video: pokerEnabled, sports_video: sportsEnabled },
          timestamp: now.toISOString(),
        }, 503);
      }
      sharedSupply = prepared.supply;
      runnableTypes = prepared.availableTypes;
      sharedSupplyCounts = prepared.counts;
      if (!runnableTypes.length) {
        return c.json({
          success: false,
          error: 'no_fresh_public_verified_video_supply',
          fleet: fleet.length,
          due: due.length,
          attempted: 0,
          blocked_preflight: queue.length,
          posted: 0,
          failed: queue.length,
          unknown: 0,
          supply_preflight: 'empty',
          supply: prepared.counts,
          modes: { poker_video: pokerEnabled, sports_video: sportsEnabled },
          timestamp: now.toISOString(),
        }, 503);
      }
    }
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
          allowedTypes: runnableTypes,
          sharedSupply,
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
    const unknown = results.filter((result) => result.outcome === 'unknown');
    const failed = results.filter(
      (result) => !result.success && !result.skipped && result.outcome !== 'unknown',
    );
    const errors: Record<string, number> = {};
    for (const result of [...failed, ...unknown]) {
      const key = result.error ?? 'unknown';
      errors[key] = (errors[key] ?? 0) + 1;
    }

    // Do not let an enabled producer report a healthy HTTP 200 when every
    // attempted publication failed. Open Claw's critical-job monitor keys on
    // the response status, while partial progress and guard-race skips remain
    // successful runs with their detailed counts intact.
    const systemicFailure = (
      deadlineHit
      || (posted.length === 0 && failed.length + unknown.length > 0)
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
      unknown: unknown.length,
      by_type: posted.reduce<Record<string, number>>((counts, result) => {
        const key = result.type ?? 'unknown';
        counts[key] = (counts[key] ?? 0) + 1;
        return counts;
      }, {}),
      errors,
      modes: { poker_video: pokerEnabled, sports_video: sportsEnabled },
      supply: { ...sharedSupplyCounts, runtime: takeSupplyStats() },
      supply_preflight: queue.length > 0 ? 'ok' : 'not_needed',
      deadline_hit: deadlineHit,
      cap_hit: due.length > MAX_HORSE_VIDEO_REELS_PER_RUN,
      queue_strategy: HORSE_VIDEO_QUEUE_STRATEGY,
      queue_cursor: selection.cursor,
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
