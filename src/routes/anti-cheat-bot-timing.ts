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

const LOOKBACK_DAYS = 7;
const FLAG_DEDUPE_HOURS = 24;

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
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();
  const dedupeSince = new Date(Date.now() - FLAG_DEDUPE_HOURS * 3600_000).toISOString();

  const result: ScanResult = {
    users_scanned: 0,
    flags_written: 0,
    flags_skipped_existing: 0,
    errors: [],
  };

  const { data: hands, error } = await supabase
    .from('hand_history')
    .select('actions, ended_at')
    .gte('created_at', since)
    .not('actions', 'is', null)
    .limit(20_000);

  if (error) {
    result.errors.push(`hand_history scan: ${error.message}`);
    return c.json({ ok: false, started_at: startedAt, ...result }, 500);
  }

  // Aggregate per-user action timestamps
  const byUser = new Map<string, number[]>();
  for (const hand of (hands ?? []) as Array<{ actions: ActionRow[] | null }>) {
    const actions = hand.actions ?? [];
    // Sort actions by timestamp for delta calculation
    const sortedByUser = new Map<string, number[]>();
    for (const a of actions) {
      const uid = uidOf(a);
      const ts = tsOf(a);
      if (!uid || ts == null) continue;
      const list = sortedByUser.get(uid) ?? [];
      list.push(ts);
      sortedByUser.set(uid, list);
    }
    for (const [uid, ts] of sortedByUser) {
      ts.sort((a, b) => a - b);
      const list = byUser.get(uid) ?? [];
      list.push(...ts);
      byUser.set(uid, list);
    }
  }

  for (const [userId, timestamps] of byUser) {
    if (timestamps.length < 200) continue; // not enough signal
    timestamps.sort((a, b) => a - b);

    const deltas: number[] = [];
    for (let i = 1; i < timestamps.length; i++) {
      const d = timestamps[i]! - timestamps[i - 1]!;
      // Drop deltas > 5 minutes (e.g. between sessions) — not action-to-action
      if (d > 0 && d < 300_000) deltas.push(d);
    }

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
    ...result,
  });
}
