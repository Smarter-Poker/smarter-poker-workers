/**
 * GET/POST /cron/horse-posts
 *
 * Hourly. Asks FleetScheduler "who is due to post now?" across EVERY active
 * content_authors row, and publishes for each one through HorsePublisher.
 *
 * Replaces /cron/horse-batch/0..9 (ten fixed daily fires over the 100
 * lowest-UUID horses). See docs/FLEET-CONTENT-PROGRAMME.md, Phase 1, and
 * the header of src/lib/content-engine/FleetScheduler.ts for the numbers.
 *
 * Budget: the dispatcher gives this route 600s. Each publish is roughly
 * 2 to 8 seconds (RSS fetch, oEmbed validation, three or four PostgREST
 * calls), so a hard deadline of 540s and a per-run cap keep a slow hour from
 * running into the next fire. Horses that miss the cap are still inside
 * their DUE_WINDOW_HOURS on the next fire; the oldest slots go first.
 *
 * Auth: /cron/* middleware chain. The result JSON is what
 * cron_execution_log.result will hold, so it carries the counts that matter:
 * due, posted, skipped (guard), failed, collided (caption pool ran dry).
 */
import type { Context } from 'hono';
import { isDueForPost, DUE_WINDOW_HOURS } from '../lib/content-engine/FleetScheduler.js';
import { loadFleet, engineEnabled } from '../lib/content-engine/Fleet.js';
import { publishForHorse, takeSupplyStats, type PublishResult } from '../lib/content-engine/HorsePublisher.js';
import { syncStyleSheets } from '../lib/content-engine/VoiceWriter.js';

export const MAX_POSTS_PER_RUN = 80;
const DEADLINE_MS = 540_000;
// One at a time. Two workers picking assets concurrently both saw the same
// clip as fresh and both posted it (4 repeats on 2026-09-05); the ledger's
// unique index is per (asset, horse), so it cannot referee a cross-horse
// race. ~30 horses an hour at 2 to 5 seconds each is well inside the budget.
const CONCURRENCY = 1;

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
    let cursor = 0;
    let deadlineHit = false;

    const worker = async () => {
      while (cursor < queue.length) {
        if (Date.now() - startedAt > DEADLINE_MS) {
          deadlineHit = true;
          return;
        }
        const item = queue[cursor++]!;
        try {
          results.push(await publishForHorse(item.horse, { fleet }));
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

    // Phase 2: keep the operator-visible copy of each horse's voice in step
    // with the code. Bounded, self-healing, and it never blocks a publish.
    const styles = await syncStyleSheets(fleet);

    const posted = results.filter((r) => r.success);
    const skipped = results.filter((r) => r.skipped === 'posted_recently');
    const failed = results.filter((r) => !r.success && !r.skipped);
    const errors: Record<string, number> = {};
    for (const f of failed) errors[f.error ?? 'unknown'] = (errors[f.error ?? 'unknown'] ?? 0) + 1;

    return c.json({
      success: true,
      fleet: fleet.length,
      due: due.length,
      attempted: results.length,
      posted: posted.length,
      skipped_recent: skipped.length,
      failed: failed.length,
      collided: posted.filter((r) => r.collided).length,
      by_type: posted.reduce<Record<string, number>>((acc, r) => {
        const k = r.type ?? 'unknown';
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {}),
      errors,
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
      deadline_hit: deadlineHit,
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
