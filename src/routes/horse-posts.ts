/**
 * GET/POST /cron/horse-posts
 *
 * Hourly. Asks FleetScheduler "who is due to post now?" across EVERY active
 * content_authors row, and publishes for each one through HorsePublisher.
 *
 * Replaced /cron/horse-batch/0..9 (ten fixed daily fires over the 100
 * lowest-UUID horses); that shim was deleted on 2026-09-21. See
 * docs/FLEET-CONTENT-PROGRAMME.md, Phase 1, and the header of
 * src/lib/content-engine/FleetScheduler.ts for the numbers.
 *
 * Budget: the dispatcher gives this route 600s. Each publish is roughly
 * 2 to 8 seconds (RSS fetch, oEmbed validation, three or four PostgREST
 * calls), so a hard deadline of 540s and a per-run cap keep a slow hour from
 * running into the next fire. Horses that miss the cap are still inside
 * their DUE_WINDOW_HOURS on the next fire; the oldest slots go first.
 *
 * The kill switch is read at entry AND again before every horse, past its
 * 30-second cache (recertification D2, 2026-09-21). A run can last nine
 * minutes, and turning the engine off has to stop the run in flight, not
 * only the next one. A stopped run says why and how many due horses it left.
 *
 * Every publish names the scheduler slot it fills, so the database refuses a
 * second post for the same horse and slot (see the HorsePublisher header).
 *
 * Auth: /cron/* middleware chain. The result JSON is what
 * cron_execution_log.result will hold, so it carries the counts that matter:
 * due, posted, skipped (by reason), failed, collided (caption pool ran dry).
 */
import type { Context } from 'hono';
import { isDueForPost, DUE_WINDOW_HOURS } from '../lib/content-engine/FleetScheduler.js';
import { loadFleet, engineEnabled, engineSwitch } from '../lib/content-engine/Fleet.js';
import {
  fleetSlotId,
  publishForHorse,
  takeSupplyStats,
  type PublishResult,
} from '../lib/content-engine/HorsePublisher.js';
import { syncStyleSheets } from '../lib/content-engine/VoiceWriter.js';
import { ledgerReadFailureTotal } from '../lib/content-engine/ContentLedger.js';

export const MAX_POSTS_PER_RUN = 80;
const DEADLINE_MS = 540_000;
// One at a time. Two workers picking assets concurrently both saw the same
// clip as fresh and both posted it (4 repeats on 2026-09-05); the ledger's
// unique index is per (asset, horse), so it cannot referee a cross-horse
// race. ~30 horses an hour at 2 to 5 seconds each is well inside the budget.
const CONCURRENCY = 1;

type Halt = 'engine_disabled' | 'engine_unreadable';

export async function horsePosts(c: Context) {
  const startedAt = Date.now();
  const now = new Date();
  try {
    if (!(await engineEnabled())) {
      return c.json({ success: true, skipped: 'engine_disabled', timestamp: now.toISOString() });
    }

    const fleet = await loadFleet();
    const due = fleet
      .map((h) => ({ horse: h, due: isDueForPost(h.profile_id, h.timezone, now) }))
      .filter((x) => x.due.due)
      // Oldest open slot first, so a horse that was skipped by the cap last
      // hour is served before one whose slot just opened.
      .sort((a, b) => (b.due.age ?? 0) - (a.due.age ?? 0));

    const queue = due.slice(0, MAX_POSTS_PER_RUN);
    const results: PublishResult[] = [];
    const run: { cursor: number; deadlineHit: boolean; halt: Halt | null } = {
      cursor: 0,
      deadlineHit: false,
      halt: null,
    };

    const ledgerFailuresBefore = ledgerReadFailureTotal();
    const worker = async () => {
      while (run.cursor < queue.length && !run.halt) {
        if (Date.now() - startedAt > DEADLINE_MS) {
          run.deadlineHit = true;
          return;
        }
        // Ask the switch again before every horse, with a fresh read.
        const state = await engineSwitch({ fresh: true });
        if (state !== 'on') {
          run.halt = state === 'off' ? 'engine_disabled' : 'engine_unreadable';
          return;
        }
        const item = queue[run.cursor++]!;
        try {
          results.push(
            await publishForHorse(item.horse, {
              fleet,
              // The slot this run found the horse due for, read from the same
              // clock, so an overlapping run names the same slot and key.
              slot: fleetSlotId(item.horse.profile_id, item.horse.timezone, now),
            }),
          );
        } catch (err) {
          results.push({
            success: false,
            horse: item.horse.name,
            profile_id: item.horse.profile_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        // A little air between publishes: YouTube oEmbed and the RSS hosts
        // are third parties and the fleet is not in a hurry.
        await new Promise((r) => setTimeout(r, 400));
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    // Ledger reads that failed during this run. The ledger fails closed (#143),
    // so these show up in `errors` as clips "already posted"; this names the
    // outage instead of letting it read as exhausted supply.
    const ledgerUnreadable = ledgerReadFailureTotal() - ledgerFailuresBefore;

    // Phase 2: keep the operator-visible copy of each horse's voice in step
    // with the code. Bounded, self-healing, and it never blocks a publish.
    // Not after the switch stopped the run: an engine that is off writes
    // nothing more.
    const styles = run.halt ? { updated: 0 } : await syncStyleSheets(fleet);

    const posted = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success && !r.skipped);
    const skippedByReason: Record<string, number> = {};
    for (const r of results) {
      if (r.skipped) skippedByReason[r.skipped] = (skippedByReason[r.skipped] ?? 0) + 1;
    }
    const errors: Record<string, number> = {};
    for (const f of failed) errors[f.error ?? 'unknown'] = (errors[f.error ?? 'unknown'] ?? 0) + 1;

    return c.json({
      success: true,
      fleet: fleet.length,
      due: due.length,
      attempted: results.length,
      posted: posted.length,
      skipped_recent: skippedByReason.posted_recently ?? 0,
      // Fail closed: the recent-post guard could not be read, so no post.
      skipped_guard_unreadable: skippedByReason.guard_unreadable ?? 0,
      // Another run already published this horse's slot (23505 on the key).
      duplicate_slot: skippedByReason.duplicate_slot ?? 0,
      skipped_by_reason: skippedByReason,
      failed: failed.length,
      collided: posted.filter((r) => r.collided).length,
      by_type: posted.reduce<Record<string, number>>((acc, r) => {
        const k = r.type ?? 'unknown';
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {}),
      errors,
      ledger_unreadable: ledgerUnreadable,
      supply: takeSupplyStats(),
      styles_synced: styles.updated,
      // Phase 2: did the words match the subject?
      avg_relevance: posted.length
        ? Number((posted.reduce((a, r) => a + (r.relevance ?? 0), 0) / posted.length).toFixed(2))
        : 0,
      below_floor: posted.filter((r) => r.belowFloor).length,
      tagged: posted.filter((r) => r.tagged).length,
      avg_drafts: posted.length
        ? Number((posted.reduce((a, r) => a + (r.drafts ?? 1), 0) / posted.length).toFixed(2))
        : 0,
      stopped: run.halt,
      not_attempted: queue.length - results.length,
      deadline_hit: run.deadlineHit,
      cap_hit: due.length > MAX_POSTS_PER_RUN,
      due_window_hours: DUE_WINDOW_HOURS,
      duration_ms: Date.now() - startedAt,
      timestamp: now.toISOString(),
      posted_horses: posted.map((r) => r.horse).slice(0, 80),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[horse-posts] fatal:', msg);
    return c.json({ success: false, error: msg }, 500);
  }
}
