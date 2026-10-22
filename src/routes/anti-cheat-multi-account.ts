/**
 * GET/POST /cron/anti-cheat-multi-account
 *
 * Multi-account detector v3 (2026-10-22). Replaces v2 and multi_account_ip_match_v1.
 *
 * v3 adds what an IP address cannot tell: the same app/browser INSTALL on two
 * accounts (anti_cheat_device_sightings, reported by the client), and whether
 * the two accounts were actually DEALT INTO the same hands (hand_history),
 * instead of merely connecting to the same table. Verdicts:
 *   critical  same device and the same hands
 *   high      same device, or same household address and the same hands
 *             while both were on it
 *   medium    2+ distinct household addresses shared
 * After detection, one stale published shared-address list (Apple Private
 * Relay, AWS, Google Cloud, Cloudflare, GitHub Actions, Azure) is refreshed,
 * so those addresses never count as a household (lib/sharedIpRanges.ts).
 *
 * Why v1 was retired. v1 flagged every pair of accounts that opened an engine
 * socket from the same IP inside 24 hours. That is "two people logged in from
 * the same place", not "one person running two accounts". In practice it
 * flagged SmarterPokerOfficial and the other admin accounts, the synthetic
 * PostDeploy smoke accounts, players behind iCloud Private Relay and cloud
 * egress addresses, and re-flagged the same people every day. Dan, 2026-10-22:
 * never flag SmarterPokerOfficial or any admin account; only flag real
 * multiple accounts, not multiple log-ins.
 *
 * The rules live in public.detect_multi_account_v3(p_since, p_until):
 *   - Never-flag accounts are removed before any matching: admin/staff/owner
 *     accounts (SmarterPokerOfficial is role 'god'), synthetic PostDeploy
 *     accounts, and anti_cheat_exemptions (KingFish, Danimal). They neither
 *     get flagged nor cause anyone else to be flagged, and a device any of
 *     them ever used is a staff device that flags nobody.
 *   - Shared-infrastructure IPs are ignored: private, carrier NAT, published
 *     relay and cloud lists (public.anti_cheat_shared_ip_ranges), and any IP
 *     used by 6+ accounts in the window (a venue, a carrier NAT).
 *   - One shared address on its own is never a flag.
 * The anti_cheat_flags insert trigger is a second wall: it drops any flag on
 * a staff account and any multi-account flag on a synthetic account.
 *
 * Horses: identity filtering here is about staff and synthetic smoke
 * accounts only. Horses go through every rule exactly as humans do
 * (CLAUDE.md 10.5).
 *
 * FLAG-ONLY. No auto-block. Admin disposition happens in the dashboard.
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { resolveScanWindow, ScanWindowError, dedupeSinceFor } from '../lib/scanWindow.js';
import { refreshOneStaleSource, type RefreshOutcome } from '../lib/sharedIpRanges.js';

const DETECTOR = 'multi_account_v3';
const SCAN_WINDOW_HOURS = 24 * 14; // 2+ shared household IPs needs more than a day of history
const FLAG_DEDUPE_HOURS = 24 * 7; // the same pair is not re-flagged for a week

interface ScanResult {
  pairs_scanned: number;
  flags_written: number;
  flags_skipped_existing: number;
  errors: string[];
}

interface PairRow {
  user_a: string;
  user_b: string;
  severity: 'medium' | 'high' | 'critical';
  evidence: string[];
  shared_devices: number;
  shared_ips: number;
  ips: string[];
  shared_hands: number;
  hand_numbers: Array<number | string>;
}

export async function antiCheatMultiAccount(c: Context) {
  const supabase = getSupabase();
  const startedAt = new Date().toISOString();

  let scanWindow;
  try {
    scanWindow = await resolveScanWindow(c, SCAN_WINDOW_HOURS);
  } catch (err) {
    if (err instanceof ScanWindowError) return c.json({ ok: false, error: err.message }, 400);
    throw err;
  }
  const since = scanWindow.start.toISOString();
  const until = scanWindow.end.toISOString();
  const dedupeSince = dedupeSinceFor(scanWindow, FLAG_DEDUPE_HOURS).toISOString();

  const result: ScanResult = {
    pairs_scanned: 0,
    flags_written: 0,
    flags_skipped_existing: 0,
    errors: [],
  };

  // No fallback to raw audit rows: a detector that cannot apply its rules
  // reports an error instead of flagging on a weaker signal.
  const { data, error: rpcErr } = await supabase.rpc('detect_multi_account_v3', {
    p_since: since,
    p_until: until,
  } as Record<string, unknown>);

  if (rpcErr) {
    return c.json(
      { ok: false, detector: DETECTOR, error: `detect_multi_account_v3: ${rpcErr.message}` },
      500,
    );
  }

  const pairs = (data ?? []) as PairRow[];
  result.pairs_scanned = pairs.length;

  for (const p of pairs) {
    for (const [playerId, otherId] of [
      [p.user_a, p.user_b],
      [p.user_b, p.user_a],
    ] as const) {
      try {
        // Dedupe on the pair, not just the player: an open or already
        // reviewed flag for this same pair inside the window is enough.
        const { data: existing } = await supabase
          .from('anti_cheat_flags')
          .select('id')
          .eq('player_id', playerId)
          .eq('flag_type', 'multi_account')
          .in('status', ['open', 'reviewed', 'dismissed'])
          .gte('flagged_at', dedupeSince)
          .like('reason', `%${otherId}%`)
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
          player_id: playerId,
          flag_type: 'multi_account',
          severity: p.severity,
          reason: JSON.stringify({
            detector: DETECTOR,
            evidence: p.evidence,
            other_user_ids: [otherId],
            shared_devices: p.shared_devices,
            shared_ips: p.shared_ips,
            ips: p.ips,
            shared_hands: p.shared_hands,
            hand_numbers: (p.hand_numbers ?? []).map(Number),
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

  // Keep the published shared-address lists current: at most one source per
  // run, after detection, never failing the run.
  let sharedIpRefresh: RefreshOutcome = { source: null, skipped: 'dry run' };
  if (!scanWindow.dryRun) sharedIpRefresh = await refreshOneStaleSource(supabase);

  return c.json({
    ok: result.errors.length === 0,
    shared_ip_refresh: sharedIpRefresh,
    detector: DETECTOR,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    window_hours: SCAN_WINDOW_HOURS,
    window: { start: since, end: until },
    window_overridden: scanWindow.overridden,
    dry_run: scanWindow.dryRun,
    ...result,
  });
}
