/**
 * GET/POST /cron/horses-social-all
 *
 * Ported from pages/api/cron/horses-social-all.js (93 LOC).
 *
 * Hourly (Fleet Content Programme phase 1, 2026-09-05): orchestrates likes
 * + comments + replies + reactions + DMs in sequence.
 *
 * Deadline is 540s. It was 55s, a Vercel-era relic, and with likePosts
 * sleeping 0.5-2s per active horse it was never enough: every fire on
 * record spent the whole budget in likes and skipped comments, replies and
 * reactions. The dispatcher gives this route 600s.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import {
  likePosts,
  commentOnPosts,
  replyToComments,
  reactToComments,
} from '../lib/content-engine/HorseSocialEngine.js';
import { processDirectMessages } from '../lib/content-engine/HorseMessengerEngine.js';
import { engineEnabled } from '../lib/content-engine/Fleet.js';

async function withDeadline<T>(
  fn: () => Promise<T>,
  deadlineMs: number,
  label: string,
): Promise<T | null> {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 2000) {
    console.warn(
      `[horses-social-all] [DEADLINE] Skipping ${label} — only ${Math.round(remaining / 1000)}s left`,
    );
    return null;
  }
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new Error(`${label} hit deadline`)),
          remaining - 1000,
        ),
      ),
    ]);
  } catch (err) {
    console.warn(
      `[horses-social-all] [DEADLINE] ${label}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function horsesSocialAll(c: Context) {
  try {
    if (!(await engineEnabled())) {
      return c.json({
        success: true,
        skipped: 'engine_disabled',
        timestamp: new Date().toISOString(),
      });
    }

    const deadline = Date.now() + 540_000;
    const results: {
      liked: number;
      commented: number;
      replied: number;
      reacted: number;
      dm: number;
      skipped: string[];
      timestamp: string;
      comment_relevance?: number;
      comment_below_floor?: number;
      comment_stale?: number;
      comment_skipped?: number;
      reply_reasons?: Record<string, number>;
    } = {
      liked: 0,
      commented: 0,
      replied: 0,
      reacted: 0,
      dm: 0,
      skipped: [],
      timestamp: new Date().toISOString(),
    };

    const likeResult = await withDeadline(() => likePosts(40, true), deadline, 'likes');
    results.liked = (likeResult as { liked?: number } | null)?.liked ?? 0;
    if (!likeResult) results.skipped.push('likes');

    const commentResult = await withDeadline(
      () => commentOnPosts(20, true),
      deadline,
      'comments',
    );
    const cr = commentResult as {
      commented?: number; avg_relevance?: number; below_floor?: number;
      stale_drafts?: number; skipped_no_content?: number;
    } | null;
    results.commented = cr?.commented ?? 0;
    // Phase 2 telemetry. The engine has returned these since the phase
    // shipped and this route was dropping them on the floor, so
    // cron_execution_log showed a comment count and nothing about whether the
    // words matched the post (found in the verification pass, 2026-09-06).
    if (cr) {
      results.comment_relevance = cr.avg_relevance ?? 0;
      results.comment_below_floor = cr.below_floor ?? 0;
      results.comment_stale = cr.stale_drafts ?? 0;
      results.comment_skipped = cr.skipped_no_content ?? 0;
    }
    if (!commentResult) results.skipped.push('comments');

    const replyResult = await withDeadline(
      () => replyToComments(12),
      deadline,
      'replies',
    );
    const rr = replyResult as { replied?: number; reply_reasons?: Record<string, number> } | null;
    results.replied = rr?.replied ?? 0;
    // Which rule allowed each reply: the thread engine's decisions, visible.
    if (rr?.reply_reasons) results.reply_reasons = rr.reply_reasons;
    if (!replyResult) results.skipped.push('replies');

    const reactResult = await withDeadline(
      () => reactToComments(20),
      deadline,
      'reactions',
    );
    results.reacted = (reactResult as { reacted?: number } | null)?.reacted ?? 0;
    if (!reactResult) results.skipped.push('reactions');

    const dmResult = await withDeadline(
      () => processDirectMessages(),
      deadline,
      'DMs',
    );
    if (!dmResult) results.skipped.push('DMs');

    return c.json({ success: true, ...results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[horses-social-all] fatal:', msg);
    return c.json({ success: false, error: msg }, 500);
  }
}
