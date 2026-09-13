/** Sufficient statistics for the existing integrity detectors. No hand JSON
 * survives addHand: only per-user moments and per-counterparty totals remain.
 * Keep attribution, timestamp aliases and detector thresholds in their current
 * contracts; reducing memory must not become a change in who gets flagged. */
export interface TimingAction {
  user_id?: string;
  userId?: string;
  id?: string;
  timestamp?: number;
  ts?: number;
  time?: number;
  action?: string;
  street?: string;
}
export interface TimingHand { actions: TimingAction[] | null }
export interface TimingMoments {
  count: number;
  sum: number;
  mean: number;
  m2: number;
  integerSquares: bigint | null;
}

export class BotTimingAccumulator {
  readonly users = new Map<string, TimingMoments>();

  addHand(hand: TimingHand): void {
    const perHand = new Map<string, number[]>();
    for (const action of hand.actions ?? []) {
      if (!action) continue;
      const uid = action.user_id ?? action.userId ?? action.id ?? null;
      const timestamp = action.timestamp ?? action.ts ?? action.time;
      if (!uid || typeof timestamp !== 'number') continue;
      const timestamps = perHand.get(uid) ?? [];
      timestamps.push(timestamp);
      perHand.set(uid, timestamps);
    }
    for (const [uid, timestamps] of perHand) {
      timestamps.sort((a, b) => a - b);
      for (let i = 1; i < timestamps.length; i++) {
        const delta = timestamps[i]! - timestamps[i - 1]!;
        if (!(delta > 0 && delta <= 90_000)) continue;
        const moments = this.users.get(uid) ?? { count: 0, sum: 0, mean: 0, m2: 0, integerSquares: 0n };
        moments.count += 1;
        moments.sum += delta;
        if (moments.integerSquares !== null) {
          moments.integerSquares = Number.isSafeInteger(delta)
            ? moments.integerSquares + BigInt(delta) ** 2n : null;
        }
        // Welford's centered recurrence avoids subtracting large squared sums
        // when a player's delays are almost identical (the signal we detect).
        const difference = delta - moments.mean;
        moments.mean += difference / moments.count;
        moments.m2 += difference * (delta - moments.mean);
        this.users.set(uid, moments);
      }
    }
  }
}

export function timingStats(moments: TimingMoments): { mean: number; std: number } {
  let variance = moments.m2 / moments.count;
  // Real action timestamps are integer milliseconds. Exact squared sums keep
  // a mathematically exact 50/100/150ms boundary from drifting just below the
  // strict threshold because Welford visited observations in a different order.
  // Fractional timestamps retain the stable centered recurrence above.
  if (moments.integerSquares !== null && Number.isSafeInteger(moments.sum)) {
    const count = BigInt(moments.count);
    variance = Number(moments.integerSquares * count - BigInt(moments.sum) ** 2n)
      / Number(count * count);
  }
  return { mean: moments.sum / moments.count, std: Math.sqrt(variance) };
}

export interface ScanPlayer {
  user_id?: string;
  userId?: string;
  id?: string;
  chips_invested?: number;
  chips_won?: number;
}
export interface ChipDumpHand {
  id: string;
  players: ScanPlayer[] | null;
  winners: ScanPlayer[] | null;
  pot_size: number | string | null;
  created_at: string;
}
export interface ChipDumpPair {
  giver: string;
  receiver: string;
  hands_together: number;
  giver_losses_to_receiver: number;
  net_transfer: number;
}
const uidOf = (player: ScanPlayer | null | undefined) =>
  player?.user_id ?? player?.userId ?? player?.id ?? null;

export class ChipDumpAccumulator {
  readonly pairs = new Map<string, ChipDumpPair>();
  readonly userTotals = new Map<string, { hands: number; wins: number }>();

  addHand(hand: ChipDumpHand): void {
    const players = hand.players ?? [];
    const winnerIds = new Set((hand.winners ?? []).map(uidOf).filter(Boolean) as string[]);
    for (const player of players) {
      const uid = uidOf(player);
      if (!uid) continue;
      const totals = this.userTotals.get(uid) ?? { hands: 0, wins: 0 };
      totals.hands += 1;
      if (winnerIds.has(uid)) totals.wins += 1;
      this.userTotals.set(uid, totals);
    }
    if (winnerIds.size !== 1) return;
    const winnerId = winnerIds.values().next().value!;
    for (const player of players) {
      const giverId = uidOf(player);
      if (!giverId || giverId === winnerId) continue;
      const invested = Number(player.chips_invested ?? 0) || 0;
      if (invested <= 0) continue;
      const key = `${giverId}|${winnerId}`;
      const pair = this.pairs.get(key) ?? {
        giver: giverId, receiver: winnerId, hands_together: 0,
        giver_losses_to_receiver: 0, net_transfer: 0,
      };
      pair.hands_together += 1;
      pair.giver_losses_to_receiver += 1;
      pair.net_transfer += invested;
      this.pairs.set(key, pair);
    }
  }
}
