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
import { pagedSelect } from '../lib/pagedSelect.js';

const LOOKBACK_DAYS = 7;
const FLAG_DEDUPE_HOURS = 24;
const MAX_SCAN_HANDS = 20_000;

interface ScanResult {
  users_scanned: number;
  flags_written: number;
  flags_skipped_existing: number;
  errors: string[];
}

interface ActionRow {
  user_id?: string;
  userId?: string;
  id?: string;
  timestamp?: number;
  ts?: number;
  time?: number;
  action?: string;
  street?: string;
}

function uidOf(a: ActionRow | null | undefined): string | null {
  if (!a) return null;
  return (a.user_id ?? a.userId ?? a.id ?? null) as string | null;
}

function tsOf(a: ActionRow | null | undefined): number | null {
  if (!a) return null;
  const t = a.timestamp ?? a.ts ?? a.time;
  return typeof t === 'number' ? t : null;
}

function stdDev(deltas: number[]): { mean: number; std: number } {
  if (deltas.length === 0) return { mean: 0, std: 0 };
  const mean = deltas.reduce((s, d) => s + d, 0) / deltas.length;
  const variance =
    deltas.reduce((s, d) => s + (d - mean) * (d - mean), 0) / deltas.length;
  return { mean, std: Math.sqrt(variance) };
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

  let hands: Array<{ actions: ActionRow[] | null }>;
  let handsTruncated = false;
  try {
    const paged = await pagedSelect<{ actions: ActionRow[] | null }>(
      () =>
        supabase
          .from('hand_history')
          .select('actions, ended_at, created_at')
          .gte('created_at', since)
          .lt('created_at', until)
          .not('actions', 'is', null)
          .order('created_at', { ascending: false }),
      MAX_SCAN_HANDS,
    );
    hands = paged.rows;
    handsTruncated = paged.truncated;
  } catch (readErr) {
    result.errors.push(
      `hand_history scan: ${readErr instanceof Error ? readErr.message : 'read failed'}`,
    );
    return c.json({ ok: false, started_at: startedAt, ...result }, 500);
  }

  // Round 67 fix: aggregate INTRA-HAND deltas only.
  // The previous implementation flattened all per-user timestamps across all
  // hands then took pairwise deltas. The cap at 5 minutes was too generous —
  // typical between-hand idle is 5–60 seconds, well under 5 min, so those
  // gaps dominated the std-dev computation. Real bots ended up indistinguish-
  // able from humans because the inter-hand variance swamped the
  // action-to-action variance. Live data confirmed: bot fleet 31 users with
  // 200+ actions all showed std-dev 12–14 sec, far above the 50/100/150ms
  // critical/high/medium thresholds → detector never triggered.
  //
  // Now we collect one deltas[] PER hand for each user, then concatenate.
  // Cross-hand boundaries are not deltas. Inter-action delays cap at 90s
  // (action_time_seconds is 15s + 1 timebank 15s = 30s typical — anything
  // above 90s is a sit-out/disconnect, drop it).
  const byUserDeltas = new Map<string, number[]>();
  for (const hand of hands) {
    const actions = hand.actions ?? [];
    // Bucket this hand's actions by user
    const perHandByUser = new Map<string, number[]>();
    for (const a of actions) {
      const uid = uidOf(a);
      const ts = tsOf(a);
      if (!uid || ts == null) continue;
      const list = perHandByUser.get(uid) ?? [];
      list.push(ts);
      perHandByUser.set(uid, list);
    }
    // Compute intra-hand deltas only
    for (const [uid, ts] of perHandByUser) {
      if (ts.length < 2) continue;
      ts.sort((a, b) => a - b);
      const handDeltas: number[] = [];
      for (let i = 1; i < ts.length; i++) {
        const d = ts[i]! - ts[i - 1]!;
        // Real action-to-action range: 0 < d <= 90s. Anything outside is
        // either same-stage spam (<50ms is fine — keep it, that's the bot
        // signal) or a disconnect/sit-out (>90s — drop, not a thinking
        // delta).
        if (d > 0 && d <= 90_000) handDeltas.push(d);
      }
      if (handDeltas.length === 0) continue;
      const userBucket = byUserDeltas.get(uid) ?? [];
      userBucket.push(...handDeltas);
      byUserDeltas.set(uid, userBucket);
    }
  }

  for (const [userId, deltas] of byUserDeltas) {
    if (deltas.length < 200) continue;
    result.users_scanned += 1;

    const { mean, std } = stdDev(deltas);
    let severity: 'low' | 'medium' | 'high' | 'critical' | null = null;
    if (std < 50 && deltas.length >= 1000) severity = 'critical';
    else if (std < 100 && deltas.length >= 500) severity = 'high';
    else if (std < 150 && deltas.length >= 200) severity = 'medium';
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
          actions_sampled: deltas.length,
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
    hands_scanned: hands.length,
    hands_truncated: handsTruncated,
    dry_run: scanWindow.dryRun,
    ...result,
  });
}
