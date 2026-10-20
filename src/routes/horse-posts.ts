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
 * Budget: the dispatcher gives this route 600s. Each publish uses one shared
 * video-verification snapshot plus bounded RSS and PostgREST work, so a hard
 * deadline of 540s and a per-run cap keep a slow hour from
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
import { publicationDeliverySummary } from '../lib/content-engine/PublicationEvidence.js';
import { isDueForPost, DUE_WINDOW_HOURS } from '../lib/content-engine/FleetScheduler.js';
import { loadFleet, engineEnabled, engineSwitch } from '../lib/content-engine/Fleet.js';
import {
  fleetSlotId,
  prepareSharedHorseVideoSupply,
  publishForHorse,
  takeSupplyStats,
  type PublishResult,
} from '../lib/content-engine/HorsePublisher.js';
import { syncStyleSheets } from '../lib/content-engine/VoiceWriter.js';
import { ledgerReadFailureTotal } from '../lib/content-engine/ContentLedger.js';

export const MAX_POSTS_PER_RUN = 80;
// The temporary two-create stock pacing ceiling permitted only 672 posts/week
// across both producers, below the active fleet's 2,065 scheduled slots.
// Serve the existing due cohort, never force a post or relax source guards.
export const MAX_NEW_HORSE_POSTS_PER_RUN = MAX_POSTS_PER_RUN;
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
    const preparedVideoSupply = queue.length > 0
      ? await prepareSharedHorseVideoSupply(['poker', 'sports'])
      : null;
    const results: PublishResult[] = [];
    const run: { cursor: number; deadlineHit: boolean; halt: Halt | null; created: number; unknown: boolean } = {
      cursor: 0,
      deadlineHit: false,
      halt: null,
      created: 0,
      unknown: preparedVideoSupply?.status === 'unknown',
    };

    const ledgerFailuresBefore = ledgerReadFailureTotal();
    const worker = async () => {
      while (run.cursor < queue.length && !run.halt && !run.unknown) {
        if (run.created >= MAX_NEW_HORSE_POSTS_PER_RUN) return;
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
          const result = await publishForHorse(item.horse, {
            fleet,
            sharedVideoSupply: preparedVideoSupply?.status === 'ok'
              ? preparedVideoSupply.supply
              : undefined,
            sharedVideoSupplyError: preparedVideoSupply?.status === 'unknown'
              ? preparedVideoSupply.error
              : undefined,
            // The slot this run found the horse due for, read from the same
            // clock, so an overlapping run names the same slot and key.
            slot: fleetSlotId(item.horse.profile_id, item.horse.timezone, now),
          });
          results.push(result);
          // Atomic publication receipts distinguish creations from replays.
          // Legacy acknowledged writes without a flag spend fresh capacity.
          if (result.success && result.created !== false) run.created += 1;
          // A lost acknowledgement may already have consumed stock. Admit
          // no further horse behind that unresolved authoritative operation.
          if (result.outcome === 'unknown' || result.skipped === 'guard_unreadable') run.unknown = true;
        } catch (err) {
          // This boundary has no definite no-write exception contract. The
          // publication may have been accepted before the exception surfaced.
          run.unknown = true;
          results.push({
            success: false,
            outcome: 'unknown',
            horse: item.horse.name,
            profile_id: item.horse.profile_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        // A little air between publishes: RSS hosts and persistence endpoints
        // both rate-limit bursts from the VM.
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
    const styles = run.halt || run.unknown ? { updated: 0 } : await syncStyleSheets(fleet);

    const posted = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success && !r.skipped);
    const skippedByReason: Record<string, number> = {};
    for (const r of results) {
      if (r.skipped) skippedByReason[r.skipped] = (skippedByReason[r.skipped] ?? 0) + 1;
    }
    const errors: Record<string, number> = {};
    for (const f of failed) errors[f.error ?? 'unknown'] = (errors[f.error ?? 'unknown'] ?? 0) + 1;
    if (preparedVideoSupply?.status === 'unknown') errors[preparedVideoSupply.error] = 1;

    return c.json({
      success: !run.unknown,
      fleet: fleet.length,
      due: due.length,
      attempted: results.length,
      posted: posted.length,
      delivery: publicationDeliverySummary(results),
      post_ids: posted.map(result=>result.postId).filter(Boolean),
      reel_ids: posted.map(result=>result.reelId).filter(Boolean),
      publication_budget: {
        limit: MAX_NEW_HORSE_POSTS_PER_RUN,
        created: run.created,
        hit: run.created >= MAX_NEW_HORSE_POSTS_PER_RUN,
      },
      skipped_recent: skippedByReason.posted_recently ?? 0,
      // Fail closed: the recent-post guard could not be read, so no post.
      skipped_guard_unreadable: skippedByReason.guard_unreadable ?? 0,
      // Another run already published this horse's slot (23505 on the key).
      duplicate_slot: skippedByReason.duplicate_slot ?? 0,
      // Every bounded approved candidate was validly exhausted. This is an
      // expected quiet slot, distinct from transport or persistence failure.
      content_exhausted: skippedByReason.content_exhausted ?? 0,
      skipped_by_reason: skippedByReason,
      failed: failed.length,
      // Keep the exact bounded publication attempt for durable operator recovery.
      // Select fields explicitly: arbitrary metadata never enters this receipt.
      publication_failures: failed.filter(result => result.publicationAttempt || result.groundedPublicationAttempt).map(result => ({
        horse: result.horse,
        profile_id: result.profile_id,
        publicationKey: result.publicationKey,
        publicationAttempt: result.publicationAttempt,
        ...(result.groundedPublicationAttempt ? {groundedPublicationAttempt:{
          authorId:result.groundedPublicationAttempt.authorId,
          reviewId:result.groundedPublicationAttempt.reviewId,
          content:result.groundedPublicationAttempt.content,
          phraseNorm:result.groundedPublicationAttempt.phraseNorm,
          semanticKey:result.groundedPublicationAttempt.semanticKey,
          frameKey:result.groundedPublicationAttempt.frameKey,
          publicationKey:result.groundedPublicationAttempt.publicationKey,
          brief:Object.fromEntries(Object.entries(result.groundedPublicationAttempt.brief).filter(([field])=>[
            'postId','kind','domain','sport','title','source','people','teams','concepts','amounts',
            'keyPhrase','topic','tone','isQuestion','claim','confidence','builtFrom',
          ].includes(field))),
        }} : {}),
        code: result.code,
        outcome: result.outcome,
        error: result.error,
      })),
      unknown: results.filter(result => result.outcome === 'unknown' || result.skipped === 'guard_unreadable').length
        + (preparedVideoSupply?.status === 'unknown' ? 1 : 0),
      halted_on_unknown: run.unknown,
      collided: posted.filter((r) => r.collided).length,
      by_type: posted.reduce<Record<string, number>>((acc, r) => {
        const k = r.type ?? 'unknown';
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {}),
      errors,
      ledger_unreadable: ledgerUnreadable,
      video_supply_preflight: preparedVideoSupply?.status ?? 'not_needed',
      supply: preparedVideoSupply?.status === 'ok'
        ? { ...preparedVideoSupply.counts, runtime: takeSupplyStats() }
        : { runtime: takeSupplyStats() },
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
    }, run.unknown ? 503 : 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[horse-posts] fatal:', msg);
    return c.json({ success: false, error: msg }, 500);
  }
}
