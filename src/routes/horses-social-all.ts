/**
 * GET/POST /cron/horses-social-all
 *
 * Ported from pages/api/cron/horses-social-all.js (93 LOC).
 *
 * Every 2 hours: orchestrates likes + comments + replies + reactions
 * + DMs in sequence. Hard 55s deadline (was 60s on Vercel; workers VM
 * has no such limit but the pattern keeps things tidy).
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
    const deadline = Date.now() + 55_000;
    const results: {
      liked: number;
      commented: number;
      replied: number;
      reacted: number;
      dm: number;
      skipped: string[];
      timestamp: string;
    } = {
      liked: 0,
      commented: 0,
      replied: 0,
      reacted: 0,
      dm: 0,
      skipped: [],
      timestamp: new Date().toISOString(),
    };

    const likeResult = await withDeadline(() => likePosts(8, true), deadline, 'likes');
    results.liked = (likeResult as { liked?: number } | null)?.liked ?? 0;
    if (!likeResult) results.skipped.push('likes');

    const commentResult = await withDeadline(
      () => commentOnPosts(5, true),
      deadline,
      'comments',
    );
    results.commented = (commentResult as { commented?: number } | null)?.commented ?? 0;
    if (!commentResult) results.skipped.push('comments');

    const replyResult = await withDeadline(
      () => replyToComments(5),
      deadline,
      'replies',
    );
    results.replied = (replyResult as { replied?: number } | null)?.replied ?? 0;
    if (!replyResult) results.skipped.push('replies');

    const reactResult = await withDeadline(
      () => reactToComments(8),
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
