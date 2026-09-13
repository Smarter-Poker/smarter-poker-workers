/**
 * GET/POST /cron/anti-cheat-bot-timing
 *
 * Phase X7.4 — closes P0-E2 + PB-BETTER-4.
 *
 * Cadence: hourly.
 *
 * Detector goal: identify users whose action timing is too consistent to be
 * human. Real humans' inter-action delay has a positive standard deviation
 * — they pause to think, look at chat, refill their drink. Bots running an
 * action policy hit the server within a tight ms window.
 *
 * Signal: per user, collect last 100 action timestamps from
 * hand_history.actions[] over the last 7 days. Compute std-dev of
 * delta-between-action-and-prior-action. Flag thresholds:
 *   - critical = std-dev < 50ms over 1000+ actions
 *   - high     = std-dev < 100ms over 500+ actions
 *   - medium   = std-dev < 150ms over 200+ actions
 *
 * Per Tier-E v1: FLAG-ONLY. Auto-block deferred to v1.1 after we tune the
 * false-positive rate from real flag data.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { resolveScanWindow, ScanWindowError, dedupeSinceFor } from '../lib/scanWindow.js';
import { scanPages } from '../lib/scanPages.js';
import { BotTimingAccumulator, timingStats, type TimingHand } from '../lib/integrityScanAccumulators.js';

const LOOKBACK_DAYS = 7;
const FLAG_DEDUPE_HOURS = 24;
const MAX_SCAN_HANDS = 20_000;

interface ScanResult {
  users_scanned: number;
  flags_written: number;
  flags_skipped_existing: number;
  errors: string[];
}

export async function antiCheatBotTiming(c: Context) {
  const supabase = getSupabase();
  const startedAt = new Date().toISOString();

  let scanWindow;
  try {
    scanWindow = await resolveScanWindow(c, LOOKBACK_DAYS * 24);
  } catch (err) {
    if (err instanceof ScanWindowError) return c.json({ ok: false, error: err.message }, 400);
    throw err;
  }
  const since = scanWindow.start.toISOString();
  const until = scanWindow.end.toISOString();
  const dedupeSince = dedupeSinceFor(scanWindow, FLAG_DEDUPE_HOURS).toISOString();

  const result: ScanResult = {
    users_scanned: 0,
    flags_written: 0,
    flags_skipped_existing: 0,
    errors: [],
  };

  const accumulator = new BotTimingAccumulator();
  let handsScanned = 0;
  let handsTruncated = false;
  try {
    const paged = await scanPages<TimingHand>(
      () =>
        supabase
          .from('hand_history')
          .select('actions, ended_at, created_at')
          .gte('created_at', since)
          .lt('created_at', until)
          .not('actions', 'is', null)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false }),
      MAX_SCAN_HANDS,
      (page) => { for (const hand of page) accumulator.addHand(hand); },
    );
    handsScanned = paged.count;
    handsTruncated = paged.truncated;
  } catch (readErr) {
    result.errors.push(
      `hand_history scan: ${readErr instanceof Error ? readErr.message : 'read failed'}`,
    );
    return c.json({ ok: false, started_at: startedAt, ...result }, 500);
  }

  // Every page has now been read successfully. Only sufficient statistics
  // remain; no finding is written from a partially failed scan.
  for (const [userId, moments] of accumulator.users) {
    if (moments.count < 200) continue;
    result.users_scanned += 1;

    const { mean, std } = timingStats(moments);
    let severity: 'low' | 'medium' | 'high' | 'critical' | null = null;
    if (std < 50 && moments.count >= 1000) severity = 'critical';
    else if (std < 100 && moments.count >= 500) severity = 'high';
    else if (std < 150 && moments.count >= 200) severity = 'medium';
    if (!severity) continue;

    // Dedupe — skip if same player already has open bot_timing flag in window
    try {
      const { data: existing } = await supabase
        .from('anti_cheat_flags')
        .select('id')
        .eq('player_id', userId)
        .eq('flag_type', 'bot_timing')
        .eq('status', 'open')
        .gte('flagged_at', dedupeSince)
        .limit(1);

      if (existing && existing.length > 0) {
        result.flags_skipped_existing += 1;
        continue;
      }

      if (scanWindow.dryRun) {
        result.flags_written += 1;
        continue;
      }
      const { error: insErr } = await supabase.from('anti_cheat_flags').insert({
        player_id: userId,
        flag_type: 'bot_timing',
        severity,
        reason: JSON.stringify({
          detector: 'bot_action_timing_variance_v1',
          actions_sampled: moments.count,
          mean_delta_ms: Math.round(mean),
          std_delta_ms: Math.round(std),
          lookback_days: LOOKBACK_DAYS,
        }),
        status: 'open',
      });

      if (insErr) {
        result.errors.push(`insert ${userId}: ${insErr.message}`);
        continue;
      }
      result.flags_written += 1;
    } catch (err) {
      result.errors.push(`${userId}: ${(err as Error).message}`);
    }
  }

  return c.json({
    ok: result.errors.length === 0,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    lookback_days: LOOKBACK_DAYS,
    window: { start: since, end: until },
    window_overridden: scanWindow.overridden,
    hands_scanned: handsScanned,
    hands_truncated: handsTruncated,
    dry_run: scanWindow.dryRun,
    ...result,
  });
}
