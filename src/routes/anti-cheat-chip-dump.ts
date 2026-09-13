/**
 * GET/POST /cron/anti-cheat-chip-dump
 *
 * Phase X7.4 — closes the chip-dump portion of P0-E1.
 *
 * Cadence: every 30 minutes.
 *
 * Detector goal: surface (giver, receiver) pairs where one user has
 * consistently shipped chips to the other through head-to-head play. The
 * pair pattern is the strongest signal: a single one-off loss is just a bad
 * session, but if the same A-loses-to-B pattern recurs across many hands
 * within 24h with a high loss ratio, it's likely chip dumping.
 *
 * Signal: aggregate hand_history.players by (giver_id, receiver_id) pairs
 * over last 24h. Compute:
 *   - hands_played_together
 *   - giver's net loss to this specific receiver
 *   - giver's net result with everyone else
 * Threshold:
 *   - high     = pair has 30+ hands together AND giver lost > 80% of those AND
 *                net transfer > 5000 chips
 *   - critical = same as high BUT giver's win rate vs everyone else >= 50%
 *                (the loss is targeted, not just a bad player)
 *
 * Per Tier-E v1 contract: FLAG-ONLY. Both ids in the pair get a flag row
 * (giver and receiver — admin reviews the pair-level evidence in `reason`).
 *
 * Note: this is intentionally narrower than the existing collusion-scan.ts
 * (which checks 4 patterns including soft-play and timing-correlation).
 * Chip-dump-specific gives admins one focused queue rather than blending
 * dump signal into the existing collusion view.
 *
 * Auth: /cron/* middleware chain.
 */
import type { Context } from 'hono';
import { getSupabase } from '../lib/supabase.js';
import { resolveScanWindow, ScanWindowError, dedupeSinceFor } from '../lib/scanWindow.js';
import { scanPages } from '../lib/scanPages.js';
import { ChipDumpAccumulator, type ChipDumpHand } from '../lib/integrityScanAccumulators.js';

const WINDOW_HOURS = 24;
const FLAG_DEDUPE_HOURS = 24;
const MIN_HANDS_TOGETHER = 30;
const MIN_LOSS_RATIO = 0.8;
const MIN_NET_CHIPS = 5000;
const MAX_SCAN_HANDS = 50_000;

interface ScanResult {
  pairs_scanned: number;
  flags_written: number;
  flags_skipped_existing: number;
  errors: string[];
}

export async function antiCheatChipDump(c: Context) {
  const supabase = getSupabase();
  const startedAt = new Date().toISOString();

  let scanWindow;
  try {
    scanWindow = await resolveScanWindow(c, WINDOW_HOURS);
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

  const accumulator = new ChipDumpAccumulator();
  const { pairs, userTotals } = accumulator;
  let handsScanned = 0;
  let handsTruncated = false;
  try {
    const paged = await scanPages<ChipDumpHand>(
      () =>
        supabase
          .from('hand_history')
          .select('id, players, winners, pot_size, created_at')
          .gte('created_at', since)
          .lt('created_at', until)
          .not('ended_at', 'is', null)
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

  // Reads completed before the first flag write. No raw hand JSON remains.
  result.pairs_scanned = pairs.size;

  // Evaluate each pair against thresholds
  for (const acc of pairs.values()) {
    if (acc.hands_together < MIN_HANDS_TOGETHER) continue;
    const lossRatio = acc.giver_losses_to_receiver / acc.hands_together;
    if (lossRatio < MIN_LOSS_RATIO) continue;
    if (acc.net_transfer < MIN_NET_CHIPS) continue;

    // Round 69 fix: compute giver's win rate EXCLUDING the contaminated pair.
    // Otherwise a savvy cheater whose only losing record is to the receiver
    // looks like a "bad player" overall and never crosses the critical tier
    // (giverWinRateOverall >= 0.5).
    const giverTotals = userTotals.get(acc.giver);
    // The former second pair map incremented once beside hands_together and
    // always recorded zero wins: this pair exists only when the giver loses.
    // Reuse those identical counters instead of retaining a duplicate map.
    const vsPair = { hands: acc.hands_together, wins: 0 };
    const handsExcludingPair = (giverTotals?.hands ?? 0) - vsPair.hands;
    const winsExcludingPair = (giverTotals?.wins ?? 0) - vsPair.wins;
    const giverWinRateExcludingPair =
      handsExcludingPair > 0 ? winsExcludingPair / handsExcludingPair : 0;
    const severity = giverWinRateExcludingPair >= 0.5 ? 'critical' : 'high';

    for (const playerId of [acc.giver, acc.receiver]) {
      try {
        // Round 69 fix: dedupe by (player, flag_type, COUNTERPARTY) so a
        // multi-target dumper gets a separate flag per receiver. Original
        // code keyed on (player, flag_type) only — once flagged for the
        // first pair, all subsequent pairs were silently swallowed until
        // the first flag was reviewed.
        const counterparty = playerId === acc.giver ? acc.receiver : acc.giver;
        const { data: existing } = await supabase
          .from('anti_cheat_flags')
          .select('id, reason')
          .eq('player_id', playerId)
          .eq('flag_type', 'chip_dump')
          .eq('status', 'open')
          .gte('flagged_at', dedupeSince);

        const alreadyFlaggedForThisPair = (existing ?? []).some((row) => {
          try {
            const r = JSON.parse(String(row.reason ?? '{}'));
            return r.counterparty_user_id === counterparty;
          } catch {
            return false;
          }
        });

        if (alreadyFlaggedForThisPair) {
          result.flags_skipped_existing += 1;
          continue;
        }

        const role = playerId === acc.giver ? 'giver' : 'receiver';
        if (scanWindow.dryRun) {
          result.flags_written += 1;
          continue;
        }
        const { error: insErr } = await supabase.from('anti_cheat_flags').insert({
          player_id: playerId,
          flag_type: 'chip_dump',
          severity,
          reason: JSON.stringify({
            detector: 'chip_dump_pair_v2',
            role,
            counterparty_user_id: counterparty,
            hands_together: acc.hands_together,
            giver_loss_ratio: Number(lossRatio.toFixed(3)),
            net_chips_transferred: Math.round(acc.net_transfer),
            giver_win_rate_excluding_pair: Number(giverWinRateExcludingPair.toFixed(3)),
            window_hours: WINDOW_HOURS,
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
    window_hours: WINDOW_HOURS,
    window: { start: since, end: until },
    window_overridden: scanWindow.overridden,
    hands_scanned: handsScanned,
    hands_truncated: handsTruncated,
    dry_run: scanWindow.dryRun,
    ...result,
  });
}
