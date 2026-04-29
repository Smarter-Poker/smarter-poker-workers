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

const WINDOW_HOURS = 24;
const FLAG_DEDUPE_HOURS = 24;
const MIN_HANDS_TOGETHER = 30;
const MIN_LOSS_RATIO = 0.8;
const MIN_NET_CHIPS = 5000;

interface ScanResult {
  pairs_scanned: number;
  flags_written: number;
  flags_skipped_existing: number;
  errors: string[];
}

interface PlayerSeat {
  user_id?: string;
  userId?: string;
  id?: string;
  chips_invested?: number;
  chips_won?: number;
}

interface HandRow {
  id: string;
  players: PlayerSeat[] | null;
  winners: PlayerSeat[] | null;
  pot_size: number | string | null;
  created_at: string;
}

function uidOf(p: PlayerSeat | undefined | null): string | null {
  if (!p) return null;
  return (p.user_id ?? p.userId ?? p.id ?? null) as string | null;
}

export async function antiCheatChipDump(c: Context) {
  const supabase = getSupabase();
  const startedAt = new Date().toISOString();
  const since = new Date(Date.now() - WINDOW_HOURS * 3600_000).toISOString();
  const dedupeSince = new Date(Date.now() - FLAG_DEDUPE_HOURS * 3600_000).toISOString();

  const result: ScanResult = {
    pairs_scanned: 0,
    flags_written: 0,
    flags_skipped_existing: 0,
    errors: [],
  };

  const { data: hands, error } = await supabase
    .from('hand_history')
    .select('id, players, winners, pot_size, created_at')
    .gte('created_at', since)
    .not('ended_at', 'is', null)
    .limit(50_000);

  if (error) {
    result.errors.push(`hand_history scan: ${error.message}`);
    return c.json({ ok: false, started_at: startedAt, ...result }, 500);
  }

  // Build pair-level aggregates
  type PairAcc = {
    giver: string;
    receiver: string;
    hands_together: number;
    giver_losses_to_receiver: number;
    net_transfer: number; // chips that flowed giver → receiver
  };
  const pairs = new Map<string, PairAcc>();
  // Per-user aggregate "everyone else" win rate
  const userTotals = new Map<string, { hands: number; wins: number }>();

  for (const hand of (hands ?? []) as HandRow[]) {
    const players = hand.players ?? [];
    const winners = (hand.winners ?? []) as PlayerSeat[];
    const winnerIds = new Set(winners.map(uidOf).filter(Boolean) as string[]);
    const pot = Number(hand.pot_size ?? 0) || 0;

    for (const p of players) {
      const uid = uidOf(p);
      if (!uid) continue;
      const t = userTotals.get(uid) ?? { hands: 0, wins: 0 };
      t.hands += 1;
      if (winnerIds.has(uid)) t.wins += 1;
      userTotals.set(uid, t);
    }

    // Pair only when exactly one winner so attribution is clean
    if (winnerIds.size !== 1) continue;
    const winnerId = Array.from(winnerIds)[0]!;

    for (const p of players) {
      const giverId = uidOf(p);
      if (!giverId || giverId === winnerId) continue;
      const giverInvested = Number(p.chips_invested ?? 0) || 0;
      if (giverInvested <= 0) continue;

      const key = `${giverId}|${winnerId}`;
      const acc = pairs.get(key) ?? {
        giver: giverId,
        receiver: winnerId,
        hands_together: 0,
        giver_losses_to_receiver: 0,
        net_transfer: 0,
      };
      acc.hands_together += 1;
      acc.giver_losses_to_receiver += 1;
      // Approximate net transfer as giver's investment in this pot (rough but
      // serviceable — the chip-dump signal lives in the pattern, not the precise amount)
      acc.net_transfer += giverInvested;
      pairs.set(key, acc);
    }
  }

  result.pairs_scanned = pairs.size;

  // Evaluate each pair against thresholds
  for (const acc of pairs.values()) {
    if (acc.hands_together < MIN_HANDS_TOGETHER) continue;
    const lossRatio = acc.giver_losses_to_receiver / acc.hands_together;
    if (lossRatio < MIN_LOSS_RATIO) continue;
    if (acc.net_transfer < MIN_NET_CHIPS) continue;

    const giverTotals = userTotals.get(acc.giver);
    const giverWinRateOverall =
      giverTotals && giverTotals.hands > 0 ? giverTotals.wins / giverTotals.hands : 0;
    const severity = giverWinRateOverall >= 0.5 ? 'critical' : 'high';

    for (const playerId of [acc.giver, acc.receiver]) {
      try {
        const { data: existing } = await supabase
          .from('anti_cheat_flags')
          .select('id')
          .eq('player_id', playerId)
          .eq('flag_type', 'chip_dump')
          .eq('status', 'open')
          .gte('flagged_at', dedupeSince)
          .limit(1);

        if (existing && existing.length > 0) {
          result.flags_skipped_existing += 1;
          continue;
        }

        const role = playerId === acc.giver ? 'giver' : 'receiver';
        const { error: insErr } = await supabase.from('anti_cheat_flags').insert({
          player_id: playerId,
          flag_type: 'chip_dump',
          severity,
          reason: JSON.stringify({
            detector: 'chip_dump_pair_v1',
            role,
            counterparty_user_id: role === 'giver' ? acc.receiver : acc.giver,
            hands_together: acc.hands_together,
            giver_loss_ratio: Number(lossRatio.toFixed(3)),
            net_chips_transferred: Math.round(acc.net_transfer),
            giver_overall_win_rate: Number(giverWinRateOverall.toFixed(3)),
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
    ...result,
  });
}
