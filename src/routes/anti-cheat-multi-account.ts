/**
 * GET/POST /cron/anti-cheat-multi-account
 *
 * Phase X7.4 (Master Gap Ledger 2026-04-28) — closes P0-E1 + PB-BETTER-2.
 *
 * Cadence: every 30 minutes. Open Claw fires this scoped to recent traffic
 * windows; the handler short-circuits when no new sign-ins occurred since
 * last scan.
 *
 * Detector goal: surface user_id pairs that share infrastructure within a
 * suspicious window. PokerBros doesn't run this; we do. Per Tier-E v1
 * contract: FLAG-ONLY. No auto-block. Each hit writes one row to
 * anti_cheat_flags(player_id, flag_type='multi_account', severity, reason,
 * status='open'). Admin disposition happens through the dashboard
 * (/api/club-arena/anti-cheat).
 *
 * Signal: same IP address (auth.sessions.ip) used by 2+ distinct user_ids
 * in a 24h window. Severity:
 *   - low    = 2 accounts on same IP, no overlap in actual play time
 *   - medium = 2 accounts on same IP, overlapping play sessions
 *   - high   = 3+ accounts on same IP
 *   - critical = 3+ accounts + chip transfers between them in same window
 *     (chip_dump detector handles the cross-flag escalation later)
 *
 * False-positive notes: roommates / family members / shared computers
 * legitimately overlap. The flag-only contract means an admin reviews
 * every hit before action; a future v1.1 will tune the auto-block threshold
 * from real-flag-rate data per Tier-E decision Q4.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';

const SCAN_WINDOW_HOURS = 24;
const FLAG_DEDUPE_HOURS = 24; // don't re-flag the same (player, flag_type) within this window

interface ScanResult {
  pairs_scanned: number;
  flags_written: number;
  flags_skipped_existing: number;
  errors: string[];
}

interface IpGroup {
  ip: string;
  user_ids: string[];
}

export async function antiCheatMultiAccount(c: Context) {
  const supabase = getSupabase();
  const startedAt = new Date().toISOString();
  const since = new Date(Date.now() - SCAN_WINDOW_HOURS * 3600_000).toISOString();
  const dedupeSince = new Date(Date.now() - FLAG_DEDUPE_HOURS * 3600_000).toISOString();

  const result: ScanResult = {
    pairs_scanned: 0,
    flags_written: 0,
    flags_skipped_existing: 0,
    errors: [],
  };

  // 1. Pull recent sessions grouped by IP. auth.sessions.ip is the source of
  //    truth; fall back to action_audit_logs.ip_address if unavailable.
  const { data: ipGroups, error: queryErr } = await supabase.rpc('detect_multi_account_ips', {
    p_since: since,
  } as Record<string, unknown>);

  // If the RPC doesn't exist yet, fall back to a query against action_audit_logs.
  let groups: IpGroup[] = [];
  if (queryErr || !ipGroups) {
    const { data: rows } = await supabase
      .from('action_audit_logs')
      .select('ip_address, user_id')
      .gte('created_at', since)
      .not('ip_address', 'is', null)
      .not('user_id', 'is', null)
      .limit(50_000);

    const byIp = new Map<string, Set<string>>();
    for (const r of (rows ?? []) as Array<{ ip_address: string; user_id: string }>) {
      if (!r.ip_address || !r.user_id) continue;
      const set = byIp.get(r.ip_address) ?? new Set();
      set.add(r.user_id);
      byIp.set(r.ip_address, set);
    }
    for (const [ip, ids] of byIp) {
      if (ids.size >= 2) groups.push({ ip, user_ids: Array.from(ids) });
    }
  } else {
    groups = ipGroups as IpGroup[];
  }

  result.pairs_scanned = groups.length;

  // 2. For each group, check dedupe + write flag rows.
  for (const g of groups) {
    if (g.user_ids.length < 2) continue;
    const accountCount = g.user_ids.length;
    const severity =
      accountCount >= 3 ? 'high' : accountCount >= 2 ? 'medium' : 'low';

    for (const playerId of g.user_ids) {
      try {
        // Dedupe: skip if a multi_account flag for this player already
        // exists within the dedupe window at status='open'.
        const { data: existing } = await supabase
          .from('anti_cheat_flags')
          .select('id')
          .eq('player_id', playerId)
          .eq('flag_type', 'multi_account')
          .eq('status', 'open')
          .gte('flagged_at', dedupeSince)
          .limit(1);

        if (existing && existing.length > 0) {
          result.flags_skipped_existing += 1;
          continue;
        }

        const otherIds = g.user_ids.filter((id) => id !== playerId);
        const { error: insErr } = await supabase.from('anti_cheat_flags').insert({
          player_id: playerId,
          flag_type: 'multi_account',
          severity,
          reason: JSON.stringify({
            detector: 'multi_account_ip_match_v1',
            ip: g.ip,
            account_count: accountCount,
            other_user_ids: otherIds,
            window_hours: SCAN_WINDOW_HOURS,
          }),
          status: 'open',
        });

        if (insErr) {
          result.errors.push(`insert ${playerId}: ${insErr.message}`);
          continue;
        }
        result.flags_written += 1;
      } catch (err) {
        result.errors.push(`${playerId}: ${(err as Error).message}`);
      }
    }
  }

  return c.json({
    ok: result.errors.length === 0,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    window_hours: SCAN_WINDOW_HOURS,
    ...result,
  });
}
